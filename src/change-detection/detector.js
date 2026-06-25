import { EventEmitter } from 'node:events'
import oracledb from 'oracledb'

import { getPool } from '#/oracledb.js'
import { refreshMv } from '#/change-detection/mv-refresh.js'
import { startCqnWakeup } from '#/change-detection/cqn-wakeup.js'
import { ensureMaterializedView } from '#/change-detection/mv-setup.js'
import { planChanges } from '#/change-detection/classify.js'
import { lowercaseKeys } from '#/change-detection/row-hash.js'

/**
 * One detector per source. Owns the sweep loop, the CQN subscription (if
 * configured), the timer, and the per-source mutex that prevents overlapping
 * sweeps. Multiple consumers calling `watch(sameSource)` share one detector
 * via the registry — see ./index.js.
 *
 * The detector emits domain events (`insert`/`update`/`delete`/`change`) and
 * `error`. Consumers of `watch()` never see Oracle errors, SCNs, or rowids.
 *
 * Sweep cycle:
 *   1. refresh the MV (a transactionally-consistent snapshot of the source);
 *   2. fetch rows whose source_scn > checkpoint (watermark short-circuit);
 *   3. for each, hash-compare against the row-state store; emit on real diff;
 *   4. fetch *all* primary keys from the MV; anti-join the state store;
 *      emit `delete` for missing ids;
 *   5. persist the new state + advance the checkpoint to max(source_scn).
 *
 * Why hash-compare on top of the watermark: COMPLETE refresh truncates and
 * reloads the MV; block-level ORA_ROWSCN false-positives a whole block of
 * rows on every commit. The hash is what makes the system correct — the
 * watermark is just an optimization for skipping rows we've already seen.
 *
 * CQN-only mode (`mvEnabled: false`): the whole MV pipeline — deploy,
 * refresh, sweeps, timer — is skipped, and CQN notifications are logged
 * instead of triggering sweeps. No domain events are emitted in this mode.
 * It exists to prove the CQN grant (GRANT CHANGE NOTIFICATION) works in a
 * deployed environment before the DBA has applied the MV grants.
 */
export class Detector extends EventEmitter {
  constructor({
    sourceName,
    sourceConfig,
    checkpointStore,
    stateStore,
    logger,
    intervalMs,
    mvEnabled = true
  }) {
    super()

    this.sourceName = sourceName
    this.sourceConfig = sourceConfig
    this.checkpointStore = checkpointStore
    this.stateStore = stateStore
    this.logger = logger.child({ source: sourceName })
    this.intervalMs = intervalMs
    this.mvEnabled = mvEnabled

    this.timer = undefined
    this.cqn = undefined
    this.activeSweep = null
    this.pendingSweep = false
    this.stopped = false
  }

  /**
   * Set up the timer and CQN subscription. Does NOT trigger the startup
   * sweep — the caller (the registry) must invoke `triggerStartupSweep()`
   * after attaching the first consumer's listener, otherwise startup-emitted
   * events fire into the void.
   *
   * Before timers or CQN come up, we self-serve the materialised-view
   * deployment: if the configured MV is missing from the database, run the
   * matching SQL file. Idempotent and safe to retry. If this step fails,
   * we throw — there's no point starting the sweep loop against a missing
   * MV.
   *
   * With `mvEnabled: false`, all of the above is skipped and only the CQN
   * subscription comes up (notifications are logged, not swept).
   */
  async start() {
    if (this.mvEnabled) {
      await ensureMaterializedView({
        sourceName: this.sourceName,
        sourceConfig: this.sourceConfig,
        logger: this.logger
      })

      this.timer = setInterval(() => {
        this.triggerSweep('timer').catch((err) =>
          this.logger.error({ err }, 'Timer-driven sweep failed')
        )
      }, this.intervalMs)
      this.timer.unref?.()
    } else {
      this.logger.info(
        'MV pipeline disabled (changeDetection.mvEnabled=false) — skipping MV deploy and sweeps; CQN notifications are log-only'
      )
    }

    if (this.sourceConfig.cqnQuery && !oracledb.thin) {
      await this.subscribeCqn()
    } else if (this.sourceConfig.cqnQuery && oracledb.thin) {
      this.logger.warn(
        this.mvEnabled
          ? 'CQN wake-up requested but oracledb is in Thin mode; running timer-only'
          : 'CQN wake-up requested but oracledb is in Thin mode; MV pipeline also disabled — source is inactive'
      )
    } else if (!this.sourceConfig.cqnQuery && !this.mvEnabled) {
      this.logger.warn(
        'Neither MV pipeline nor CQN configured — source is inactive'
      )
    }
  }

  async triggerStartupSweep() {
    // Initial sweep is the "catch-up" — anything that changed while the app
    // was offline is detected here, AFTER the first consumer has subscribed.
    if (!this.mvEnabled) {
      return
    }

    return this.triggerSweep('startup')
  }

  async subscribeCqn() {
    try {
      this.cqn = await startCqnWakeup({
        pool: this.sourceConfig.pool,
        query: this.sourceConfig.cqnQuery,
        onWakeup: (notification) => {
          if (!this.mvEnabled) {
            // CQN-only mode: the notification itself is the deliverable.
            this.logger.info(
              { notification },
              'CQN notification received (MV pipeline disabled; log-only)'
            )

            return
          }

          this.triggerSweep('cqn').catch((err) =>
            this.logger.error({ err }, 'CQN-triggered sweep failed')
          )
        },
        onDeregistered: () => {
          // The timer keeps correctness alive even if we never get CQN back.
          this.cqn = undefined
          this.scheduleResubscribe(0)
        },
        logger: this.logger
      })

      this.logger.info(
        { query: this.sourceConfig.cqnQuery },
        'CQN wake-up subscribed'
      )
    } catch (err) {
      // With the MV pipeline up, timer-only operation is still correct, just
      // higher-latency. Without it, this source now does nothing — say so.
      // The Oracle error (ORA-/NJS-/DPI- code) goes into the message itself:
      // log viewers list the message column, and the nested err object is
      // only visible after expanding the document.
      this.logger.warn(
        {
          err,
          pool: this.sourceConfig.pool,
          query: this.sourceConfig.cqnQuery
        },
        this.mvEnabled
          ? `CQN wake-up failed to subscribe (${errSummary(err)}); running timer-only`
          : `CQN subscribe failed (${errSummary(err)}) and MV pipeline is disabled — source is inactive`
      )

      throw err
    }
  }

  /**
   * Bounded exponential backoff while the detector is alive. Loops forever
   * (with cap) until either resubscribe succeeds or stop() is called. The
   * timer carries correctness in the meantime, so an extended outage here
   * only costs latency, not events.
   */
  scheduleResubscribe(attempt) {
    if (this.stopped) {
      return
    }

    const delayMs = Math.min(60_000, 1_000 * 2 ** attempt)

    const handle = setTimeout(() => {
      this.resubscribe(attempt)
    }, delayMs)
    handle.unref?.()
  }

  async resubscribe(attempt) {
    if (this.stopped || this.cqn) {
      return
    }

    try {
      await this.subscribeCqn()
    } catch {
      // subscribeCqn already logged. Schedule the next attempt.
      this.scheduleResubscribe(attempt + 1)
    }
  }

  /**
   * Coalesces concurrent triggers into a single follow-up sweep. If a sweep
   * is already in flight, we record that another is wanted and run exactly
   * one more when the current one finishes — never a queue of N pending
   * sweeps for N notifications.
   *
   * Returns a promise that resolves when the triggering sweep (and any
   * coalesced follow-up) completes — `stop()` awaits this to drain.
   */
  triggerSweep(reason) {
    // mvEnabled guard is belt-and-braces: in CQN-only mode nothing should
    // call this, but a sweep against a missing MV must never run.
    if (this.stopped || !this.mvEnabled) {
      return Promise.resolve()
    }

    if (this.activeSweep) {
      this.pendingSweep = true
      return this.activeSweep
    }

    this.activeSweep = this.runSweep(reason)
      .catch((err) => {
        // runSweep already emits 'error' and logs; swallow here so the
        // chained .then() runs and clears activeSweep.
        this.logger.error({ err }, 'Sweep promise rejected (unexpected)')
      })
      .then(async () => {
        this.activeSweep = null

        if (this.pendingSweep && !this.stopped) {
          this.pendingSweep = false

          return this.triggerSweep('coalesced')
        }
      })

    return this.activeSweep
  }

  async runSweep(reason) {
    const startedAt = Date.now()
    const pool = getPool(this.sourceConfig.pool)
    const connection = await pool.getConnection()

    try {
      await refreshMv(connection, this.sourceConfig.mv)

      const checkpoint = await this.checkpointStore.get(this.sourceName)

      const { rows: changedRows, columns } = await this.fetchChangedRows(
        connection,
        checkpoint
      )

      const priorState = await this.loadPriorState(changedRows)

      const { entries, maxScn: changedMaxScn } = planChanges({
        rows: changedRows,
        primaryKey: this.sourceConfig.primaryKey,
        priorState
      })

      let insertCount = 0
      let updateCount = 0

      for (const entry of entries) {
        // Emit then persist, per row, so the partial-failure window stays one
        // row (a crash mid-loop re-emits at most that row on the next sweep).
        if (entry.event) {
          this.emitChange({ ...entry.event, source: this.sourceName })

          if (entry.event.type === 'insert') {
            insertCount++
          } else {
            updateCount++
          }
        }

        await this.stateStore.upsert(
          this.sourceName,
          entry.id,
          entry.payloadHash,
          entry.payload,
          entry.sourceScn
        )
      }

      const deleteCount = await this.detectDeletions(connection)

      // Advance only forward, and never on an empty / pure-no-op sweep (see the
      // maxScn contract in classify.js).
      let maxScn = checkpoint

      if (changedMaxScn !== null && changedMaxScn > maxScn) {
        maxScn = changedMaxScn
      }

      if (maxScn > checkpoint) {
        await this.checkpointStore.set(this.sourceName, maxScn)
      }

      this.logger.debug(
        {
          reason,
          durationMs: Date.now() - startedAt,
          examined: changedRows.length,
          inserts: insertCount,
          updates: updateCount,
          deletes: deleteCount,
          checkpoint: maxScn,
          columns
        },
        'Sweep complete'
      )
    } catch (err) {
      this.logger.error({ err, reason }, `Sweep failed: ${errSummary(err)}`)

      this.emit('error', err)
    } finally {
      await connection.close().catch(() => {})
    }
  }

  async loadPriorState(rows) {
    // One batched read of all changed ids — a consistent pre-sweep snapshot,
    // keyed by id, as the classifier expects. The ids are distinct (the MV's
    // PK is unique), so the up-front snapshot equals a per-row read. This holds
    // the prior-state Map alongside changedRows (~2x peak heap on a large
    // catch-up sweep) — acceptable for the volumes here.
    const ids = rows.map((row) => row[this.sourceConfig.primaryKey])

    return this.stateStore.getMany(this.sourceName, ids)
  }

  async fetchChangedRows(connection, checkpoint) {
    // ORA_ROWSCN is projected as source_scn during MV creation; the MV's own
    // ORA_ROWSCN is useless as a watermark because a COMPLETE refresh rewrites
    // every row, so its rowscn changes on every sweep.
    const result = await connection.execute(
      `SELECT * FROM ${this.sourceConfig.mv} WHERE source_scn > :checkpoint`,
      { checkpoint },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    )

    const columns = result.metaData?.map((m) => m.name.toLowerCase()) ?? []
    const rows = result.rows.map((row) => lowercaseKeys(row))

    return { rows, columns }
  }

  async detectDeletions(connection) {
    // Anti-join the state store against the live MV: any id we've previously
    // emitted that's no longer in the MV is a delete. Running this on every
    // sweep keeps the prototype simple; for very large sources you'd move to
    // a periodic sweep or a soft-delete column.
    const result = await connection.execute(
      `SELECT ${this.sourceConfig.primaryKey} AS id FROM ${this.sourceConfig.mv}`,
      {},
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    )

    const liveIds = new Set(result.rows.map((row) => row.ID ?? row.id))
    const knownIds = await this.stateStore.listIds(this.sourceName)

    const missingIds = knownIds.filter((id) => !liveIds.has(id))

    if (missingIds.length === 0) {
      return 0
    }

    // Batch the `before` payloads for just the (usually small) deleted set.
    const priorState = await this.stateStore.getMany(
      this.sourceName,
      missingIds
    )

    for (const id of missingIds) {
      const prev = priorState.get(id)

      this.emitChange({
        type: 'delete',
        source: this.sourceName,
        id,
        row: undefined,
        before: prev?.payload
      })

      await this.stateStore.delete(this.sourceName, id)
    }

    return missingIds.length
  }

  emitChange(event) {
    const enriched = { ...event, detectedAt: new Date().toISOString() }

    // Domain-specific listeners ("insert", "update", "delete") are convenient;
    // a unified "change" listener is what most consumers actually want.
    // Each consumer (registered by the registry) wraps its forwarding in
    // try/catch, so a single throwing handler can't cascade — but we still
    // protect the sweep loop here as a belt-and-braces guard against new
    // listener kinds added later.
    safeEmit(this, event.type, enriched, this.logger)
    safeEmit(this, 'change', enriched, this.logger)
  }

  async stop() {
    this.stopped = true

    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }

    // Drain any in-flight sweep before tearing down Oracle/Mongo, otherwise
    // we'd be writing state and closing connections concurrently.
    if (this.activeSweep) {
      await this.activeSweep.catch(() => {})
    }

    if (this.cqn) {
      await this.cqn.stop()
      this.cqn = undefined
    }

    this.removeAllListeners()
  }
}

// node-oracledb 6 error messages append a multi-line "Help:" URL; the first
// line carries the ORA-/NJS-/DPI- code and description, which is all a log
// message needs.
function errSummary(err) {
  return String(err?.message ?? err).split('\n')[0]
}

function safeEmit(emitter, eventName, payload, logger) {
  const listeners = emitter.listeners(eventName)

  for (const listener of listeners) {
    try {
      listener(payload)
    } catch (err) {
      // One consumer's bad handler must not block sibling consumers.
      logger.error(
        { err, event: eventName, id: payload?.id },
        'Change-event handler threw'
      )
    }
  }
}
