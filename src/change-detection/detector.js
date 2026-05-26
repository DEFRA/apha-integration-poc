import { EventEmitter } from 'node:events'
import crypto from 'node:crypto'
import oracledb from 'oracledb'

import { getPool } from '#/oracledb.js'
import { refreshMv } from '#/change-detection/mv-refresh.js'
import { startCqnWakeup } from '#/change-detection/cqn-wakeup.js'
import { ensureMaterializedView } from '#/change-detection/mv-setup.js'

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
 */
export class Detector extends EventEmitter {
  constructor({
    sourceName,
    sourceConfig,
    checkpointStore,
    stateStore,
    logger,
    intervalMs
  }) {
    super()

    this.sourceName = sourceName
    this.sourceConfig = sourceConfig
    this.checkpointStore = checkpointStore
    this.stateStore = stateStore
    this.logger = logger.child({ source: sourceName })
    this.intervalMs = intervalMs

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
   */
  async start() {
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

    if (this.sourceConfig.cqnQuery && !oracledb.thin) {
      await this.subscribeCqn()
    } else if (this.sourceConfig.cqnQuery && oracledb.thin) {
      this.logger.warn(
        'CQN wake-up requested but oracledb is in Thin mode; running timer-only'
      )
    }
  }

  async triggerStartupSweep() {
    // Initial sweep is the "catch-up" — anything that changed while the app
    // was offline is detected here, AFTER the first consumer has subscribed.
    return this.triggerSweep('startup')
  }

  async subscribeCqn() {
    try {
      this.cqn = await startCqnWakeup({
        pool: this.sourceConfig.pool,
        query: this.sourceConfig.cqnQuery,
        onWakeup: () => {
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
      // Timer-only operation is still correct, just higher-latency.
      this.logger.warn(
        { err },
        'CQN wake-up failed to subscribe; running timer-only'
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
    if (this.stopped) {
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

      let maxScn = checkpoint
      let insertCount = 0
      let updateCount = 0

      for (const row of changedRows) {
        const id = row[this.sourceConfig.primaryKey]
        const sourceScn = Number(row.source_scn)
        const payload = stripInternalColumns(row)
        const payloadHash = hashPayload(payload)

        const prev = await this.stateStore.get(this.sourceName, id)

        if (!prev) {
          this.emitChange({
            type: 'insert',
            source: this.sourceName,
            id,
            row: payload,
            before: undefined
          })

          insertCount++
        } else if (prev.payloadHash !== payloadHash) {
          this.emitChange({
            type: 'update',
            source: this.sourceName,
            id,
            row: payload,
            before: prev.payload
          })

          updateCount++
        }
        // else: same hash — false positive from refresh/block SCN, skip silently

        await this.stateStore.upsert(
          this.sourceName,
          id,
          payloadHash,
          payload,
          sourceScn
        )

        if (sourceScn > maxScn) {
          maxScn = sourceScn
        }
      }

      const deleteCount = await this.detectDeletions(connection)

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
      this.logger.error({ err, reason }, 'Sweep failed')

      this.emit('error', err)
    } finally {
      await connection.close().catch(() => {})
    }
  }

  async fetchChangedRows(connection, checkpoint) {
    // ORA_ROWSCN projected as source_scn during MV creation — see the 010
    // setup script for why the MV's *own* ORA_ROWSCN would be useless here.
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

    let deleteCount = 0

    for (const id of knownIds) {
      if (liveIds.has(id)) {
        continue
      }

      const prev = await this.stateStore.get(this.sourceName, id)

      this.emitChange({
        type: 'delete',
        source: this.sourceName,
        id,
        row: undefined,
        before: prev?.payload
      })

      await this.stateStore.delete(this.sourceName, id)
      deleteCount++
    }

    return deleteCount
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

function lowercaseKeys(obj) {
  const out = {}

  for (const key of Object.keys(obj)) {
    out[key.toLowerCase()] = obj[key]
  }

  return out
}

function stripInternalColumns(row) {
  const payload = { ...row }
  delete payload.source_scn

  return payload
}

function hashPayload(payload) {
  // Sorted keys so column-order changes from the driver don't churn hashes;
  // Date / BigInt / Buffer normalized so they round-trip stably.
  const sorted = {}

  for (const key of Object.keys(payload).sort()) {
    sorted[key] = payload[key]
  }

  const json = JSON.stringify(sorted, (_key, value) => {
    if (value instanceof Date) {
      return value.toISOString()
    }

    if (typeof value === 'bigint') {
      return value.toString()
    }

    if (Buffer.isBuffer(value)) {
      return value.toString('base64')
    }

    return value
  })

  return crypto.createHash('sha256').update(json).digest('hex')
}
