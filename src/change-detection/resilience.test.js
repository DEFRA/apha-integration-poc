import { MongoClient } from 'mongodb'

import { initOracleDb, closeOracleDb } from '#/oracledb.js'
import { config } from '#/config.js'
import {
  bootstrap,
  watch,
  shutdown,
  _detectorForTesting
} from '#/change-detection/index.js'
import { createLogger } from '#/common/helpers/logging/logger.js'
import {
  makeIdPrefix,
  makePyidGenerator,
  directInsert,
  directUpdate,
  directDelete,
  purgeRowsByPrefix,
  countSourceRows
} from '#/change-detection/_test-helpers.js'

const skip = !process.env.ORACLE_CLIENT_LIB_DIR

const ID_PREFIX = makeIdPrefix('resilience')
const nextPyid = makePyidGenerator(ID_PREFIX)

const SHORT_INTERVAL = 500
const LONG_INTERVAL = 60_000

describe.skipIf(skip)('#change-detection: resilience', () => {
  let client
  let db
  let originalIntervalMs

  beforeAll(async () => {
    await initOracleDb()

    client = await MongoClient.connect(globalThis.__MONGO_URI__)
    db = client.db('change-detection-test')

    originalIntervalMs = config.get('changeDetection.defaultIntervalMs')
  }, 60_000)

  afterAll(async () => {
    await shutdown()
    await closeOracleDb()
    await client.close()

    config.set('changeDetection.defaultIntervalMs', originalIntervalMs)
  })

  beforeEach(async () => {
    // Order matters: shutdown FIRST so any in-flight sweep triggered by the
    // previous test's afterEach (purgeRowsByPrefix issues a DELETE that
    // fires CQN, which kicks off a sweep on the still-subscribed previous
    // detector) finishes before we wipe the state store. If we deleted
    // first, shutdown's drain of that sweep would then write the rows back.
    await shutdown()

    await db.collection('cqn_checkpoints').deleteMany({})
    await db.collection('cqn_row_state').deleteMany({})

    config.set('changeDetection.defaultIntervalMs', SHORT_INTERVAL)

    await bootstrap({ db, logger: createLogger() })
  })

  afterEach(async () => {
    await purgeRowsByPrefix(ID_PREFIX)
  })

  test('startup catch-up: a single change made while detector is stopped is emitted on restart', async () => {
    const pyid = nextPyid()

    // First detector run — records the table's current state in the row store.
    let watcher = await watch('workorders')
    await watcher.stop()
    await shutdown()

    // Detector gone; mutate the database. Nothing is listening.
    await directInsert(pyid, 'Open')

    // Restart with a long interval so the catch-up event MUST come from the
    // startup sweep, not from a fast timer tick.
    config.set('changeDetection.defaultIntervalMs', LONG_INTERVAL)
    await bootstrap({ db, logger: createLogger() })

    watcher = await watch('workorders')

    const events = []
    watcher.on('change', (event) => {
      events.push(event)
    })

    await vi.waitFor(
      () =>
        expect(events.some((e) => e.id === pyid && e.type === 'insert')).toBe(
          true
        ),
      { timeout: 10_000, interval: 200 }
    )

    await watcher.stop()
  }, 60_000)

  test('bulk startup catch-up: every existing source row is classified as an insert on the first-ever sweep', async () => {
    // beforeEach already wiped the state store and bootstrapped a fresh
    // registry, so the detector has no prior knowledge of *any* row. The
    // first sweep should therefore see every source row as new and emit an
    // `insert` for each. This is the realistic "first ever boot" scenario;
    // the per-row catch-up test above only exercises a single missed change.
    const expectedCount = await countSourceRows()

    // Sanity check — the seed data should yield enough rows that we're
    // exercising more than the single-row case.
    expect(expectedCount).toBeGreaterThan(10)

    const watcher = await watch('workorders')

    const inserts = []
    watcher.on('insert', (event) => {
      inserts.push(event)
    })

    await vi.waitFor(() => expect(inserts.length).toBe(expectedCount), {
      timeout: 15_000,
      interval: 250
    })

    // Every emitted event must be classified as insert with no `before`,
    // otherwise we'd be in some odd state where prior rows leaked through.
    for (const event of inserts) {
      expect(event.type).toBe('insert')
      expect(event.before).toBeUndefined()
      expect(event.row).toBeDefined()
    }

    // The IDs emitted should match the IDs currently in the source.
    expect(new Set(inserts.map((e) => e.id)).size).toBe(expectedCount)

    await watcher.stop()
  }, 30_000)

  test('multiple changes missed during downtime — insert, update, delete — are all detected on restart', async () => {
    // Phase 1: pre-seed two rows that the first detector run will record in
    // the state store. We'll mutate them while the detector is down.
    const toUpdate = nextPyid()
    const toDelete = nextPyid()
    await directInsert(toUpdate, 'Open')
    await directInsert(toDelete, 'Open')

    let watcher = await watch('workorders')

    const phase1 = []
    watcher.on('change', (event) => {
      if (event.id === toUpdate || event.id === toDelete) {
        phase1.push(event)
      }
    })

    // Both pre-seeded rows must be in the state store before we stop.
    await vi.waitFor(
      () => {
        const ids = new Set(phase1.map((e) => e.id))
        return expect(ids.has(toUpdate) && ids.has(toDelete)).toBe(true)
      },
      { timeout: 10_000, interval: 200 }
    )

    await watcher.stop()
    await shutdown()

    // Phase 2: mutate the database while NOTHING is watching. Three distinct
    // changes — one of each type. This is the worst-case "we were down and
    // a bunch of stuff happened" scenario the catch-up sweep must handle.
    const toInsert = nextPyid()
    await directUpdate(toUpdate, 'Closed')
    await directDelete(toDelete)
    await directInsert(toInsert, 'Open')

    // Phase 3: restart with a long interval so the catch-up events come
    // exclusively from the startup sweep (not a fast timer tick).
    config.set('changeDetection.defaultIntervalMs', LONG_INTERVAL)
    await bootstrap({ db, logger: createLogger() })

    watcher = await watch('workorders')

    const phase2 = []
    watcher.on('change', (event) => {
      if (
        event.id === toUpdate ||
        event.id === toDelete ||
        event.id === toInsert
      ) {
        phase2.push(event)
      }
    })

    await vi.waitFor(
      () => {
        const update = phase2.find(
          (e) => e.id === toUpdate && e.type === 'update'
        )
        const del = phase2.find((e) => e.id === toDelete && e.type === 'delete')
        const ins = phase2.find((e) => e.id === toInsert && e.type === 'insert')

        return expect(Boolean(update && del && ins)).toBe(true)
      },
      { timeout: 15_000, interval: 200 }
    )

    // Verify the payloads carry the correct `before` / `row` content — the
    // state store's job is not just to detect *that* something changed but
    // to give us the before-and-after so a consumer doesn't have to re-read
    // the source.
    const update = phase2.find((e) => e.id === toUpdate && e.type === 'update')
    expect(update.before.pystatuswork).toBe('Open')
    expect(update.row.pystatuswork).toBe('Closed')

    const del = phase2.find((e) => e.id === toDelete && e.type === 'delete')
    expect(del.before.pystatuswork).toBe('Open')
    expect(del.row).toBeUndefined()

    const ins = phase2.find((e) => e.id === toInsert && e.type === 'insert')
    expect(ins.row.pystatuswork).toBe('Open')
    expect(ins.before).toBeUndefined()

    await watcher.stop()
  }, 90_000)

  test('timer-only mode (no CQN) still detects changes', async () => {
    const sources = config.get('changeDetection.sources')
    const originalQuery = sources.workorders.cqnQuery

    config.set('changeDetection.sources.workorders.cqnQuery', null)

    try {
      // Force a fresh detector that picks up the cleared cqnQuery.
      await shutdown()
      await bootstrap({ db, logger: createLogger() })

      const watcher = await watch('workorders')

      const events = []
      watcher.on('change', (event) => {
        events.push(event)
      })

      const pyid = nextPyid()
      await directInsert(pyid, 'Open')

      await vi.waitFor(
        () => expect(events.some((e) => e.id === pyid)).toBe(true),
        { timeout: 10_000, interval: 200 }
      )

      await watcher.stop()
    } finally {
      config.set('changeDetection.sources.workorders.cqnQuery', originalQuery)
    }
  }, 30_000)

  test('CQN deregistration: timer keeps delivering changes after the CQN handle is lost', async () => {
    const watcher = await watch('workorders')

    const events = []
    watcher.on('change', (event) => {
      events.push(event)
    })

    const detector = _detectorForTesting('workorders')

    // Simulate the database deregistering our subscription: tear down CQN
    // underneath the detector. The timer must continue to deliver changes.
    if (detector.cqn) {
      await detector.cqn.stop()
      detector.cqn = undefined
    }

    const pyid = nextPyid()
    await directInsert(pyid, 'Open')

    await vi.waitFor(
      () => expect(events.some((e) => e.id === pyid)).toBe(true),
      { timeout: 10_000, interval: 200 }
    )

    await watcher.stop()
  }, 30_000)

  test('refresh failure mid-sweep does not crash the timer', async () => {
    const watcher = await watch('workorders')

    const errors = []
    watcher.on('error', (err) => {
      errors.push(err)
    })

    const events = []
    watcher.on('change', (event) => {
      events.push(event)
    })

    const detector = _detectorForTesting('workorders')

    // Inject a transient failure into the next refresh call. The sweep
    // should surface an `error` event and return cleanly — leaving the
    // timer alive — so the NEXT scheduled sweep succeeds normally.
    let failOnce = true
    const realRunSweep = detector.runSweep.bind(detector)
    detector.runSweep = async function (reason) {
      if (failOnce) {
        failOnce = false
        const err = new Error('ORA-12345: simulated transient refresh error')
        this.emit('error', err)
        throw err
      }
      return realRunSweep(reason)
    }

    try {
      await detector.triggerSweep('test').catch(() => {})

      expect(errors.length).toBeGreaterThan(0)

      const pyid = nextPyid()
      await directInsert(pyid, 'Open')

      await vi.waitFor(
        () => expect(events.some((e) => e.id === pyid)).toBe(true),
        { timeout: 10_000, interval: 200 }
      )
    } finally {
      detector.runSweep = realRunSweep
    }

    await watcher.stop()
  }, 30_000)
})
