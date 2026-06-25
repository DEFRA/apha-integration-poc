import { MongoClient } from 'mongodb'

import { config } from '#/config.js'
import { Detector } from '#/change-detection/detector.js'
import {
  bootstrap,
  watch,
  shutdown,
  _detectorForTesting
} from '#/change-detection/index.js'

/**
 * End-to-end wiring test with NO Oracle: the real `watch()` → real `Registry`
 * → real `Detector` → real `createWatcher` buffer, backed by in-memory Mongo
 * and a faked Oracle layer. It is deliberately NOT `skipIf(ORACLE)`-gated — the
 * Oracle-backed suites cannot run everywhere, and this is the only test that
 * exercises the registry/detector/watcher integration as a unit (a consumer
 * attaching `.on('change')` after `watch()` resolves still receiving the
 * startup-sweep event; concurrent consumers sharing one detector).
 *
 * Oracle is removed three ways: `getPool` is faked, `refreshMv` and
 * `ensureMaterializedView` are no-ops, and `Detector.fetchChangedRows` is
 * stubbed to yield one canned row. The fake connection's `execute` answers the
 * deletion anti-join's live-id query with that same id, so no phantom delete
 * fires. `cqnQuery` is nulled so the CQN path is skipped regardless of whether
 * another suite put node-oracledb into Thick mode in this process.
 */

const { CANNED_ID, fakePool } = vi.hoisted(() => {
  const id = 'INT-1'

  const fakeConnection = {
    execute: async () => ({ rows: [{ ID: id }], metaData: [{ name: 'ID' }] }),
    close: async () => {}
  }

  return { CANNED_ID: id, fakePool: { getConnection: async () => fakeConnection } }
})

vi.mock('#/oracledb.js', () => ({ getPool: () => fakePool }))
vi.mock('#/change-detection/mv-refresh.js', () => ({
  refreshMv: async () => {}
}))
vi.mock('#/change-detection/mv-setup.js', () => ({
  ensureMaterializedView: async () => ({ created: false })
}))

function makeSilentLogger() {
  const logger = {
    info() {},
    warn() {},
    error() {},
    debug() {},
    child() {
      return logger
    }
  }

  return logger
}

const cannedRow = () => ({
  rows: [{ pyid: CANNED_ID, pystatuswork: 'Open', source_scn: 100 }],
  columns: ['pyid', 'pystatuswork', 'source_scn']
})

describe('#change-detection: registry/detector/watcher wiring (no Oracle)', () => {
  let client
  let db
  let fetchSpy
  let original

  beforeAll(async () => {
    client = await MongoClient.connect(globalThis.__MONGO_URI__)
    db = client.db('change-detection-integration-test')

    original = {
      mvEnabled: config.get('changeDetection.mvEnabled'),
      intervalMs: config.get('changeDetection.defaultIntervalMs'),
      cqnQuery: config.get('changeDetection.sources').workorders.cqnQuery
    }

    config.set('changeDetection.mvEnabled', true)
    // Long interval so the startup sweep — not a timer tick — is what emits.
    config.set('changeDetection.defaultIntervalMs', 60_000)
    // No CQN: this test exercises the MV pipeline wiring only, and nulling the
    // query keeps it independent of node-oracledb Thin/Thick mode.
    config.set('changeDetection.sources.workorders.cqnQuery', null)
  })

  afterAll(async () => {
    try {
      config.set('changeDetection.mvEnabled', original.mvEnabled)
      config.set('changeDetection.defaultIntervalMs', original.intervalMs)
      config.set('changeDetection.sources.workorders.cqnQuery', original.cqnQuery)
    } finally {
      await client.close()
    }
  })

  beforeEach(async () => {
    await shutdown().catch(() => {})

    await db.collection('cqn_checkpoints').deleteMany({})
    await db.collection('cqn_row_state').deleteMany({})

    fetchSpy = vi
      .spyOn(Detector.prototype, 'fetchChangedRows')
      .mockResolvedValue(cannedRow())

    await bootstrap({ db, logger: makeSilentLogger() })
  })

  afterEach(async () => {
    await shutdown().catch(() => {})
    fetchSpy.mockRestore()
  })

  test('a consumer attaching .on() after watch() resolves still receives the startup-sweep event', async () => {
    const watcher = await watch('workorders')

    // The startup sweep already ran inside watch(); the buffer must replay it.
    const received = []
    watcher.on('change', (event) => received.push(event))

    await vi.waitFor(
      () => expect(received.some((e) => e.id === CANNED_ID)).toBe(true),
      { timeout: 5_000, interval: 50 }
    )

    // The event must have come through the real sweep, not a shortcut.
    expect(fetchSpy).toHaveBeenCalled()

    // Exactly one delivery — a double-drain regression would deliver two.
    expect(received.filter((e) => e.id === CANNED_ID)).toHaveLength(1)

    const event = received.find((e) => e.id === CANNED_ID)

    expect(event.type).toBe('insert')
    expect(event.source).toBe('workorders')
    expect(event.row.pystatuswork).toBe('Open')
    expect(event.before).toBeUndefined()
    expect(event.detectedAt).toBeDefined()

    await watcher.stop()
  })

  test('two concurrent watch(sameSource) calls share exactly one detector and both receive events', async () => {
    const [a, b] = await Promise.all([watch('workorders'), watch('workorders')])

    const detector = _detectorForTesting('workorders')
    expect(detector).toBeDefined()
    expect(a).not.toBe(b)

    // Exactly one detector: each watcher attached one 'change' listener to the
    // shared detector. Two detectors (only one registered) would show 1 here.
    expect(detector.listenerCount('change')).toBe(2)

    const ra = []
    const rb = []
    a.on('change', (e) => ra.push(e))
    b.on('change', (e) => rb.push(e))

    await vi.waitFor(
      () =>
        expect(
          ra.some((e) => e.id === CANNED_ID) && rb.some((e) => e.id === CANNED_ID)
        ).toBe(true),
      { timeout: 5_000, interval: 50 }
    )

    await a.stop()
    await b.stop()
  })

  test('shutdown() tears down the registry so no detector remains', async () => {
    await watch('workorders')

    expect(_detectorForTesting('workorders')).toBeDefined()

    await shutdown()

    expect(_detectorForTesting('workorders')).toBeUndefined()
  })
})
