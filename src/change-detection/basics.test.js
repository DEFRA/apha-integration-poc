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
  purgeRowsByPrefix
} from '#/change-detection/_test-helpers.js'

const skip = !process.env.ORACLE_CLIENT_LIB_DIR

const ID_PREFIX = makeIdPrefix('basics')
const nextPyid = makePyidGenerator(ID_PREFIX)

describe.skipIf(skip)('#change-detection: basic event emission', () => {
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
    // shutdown() first so any in-flight CQN-triggered sweep from the
    // previous test's afterEach (purgeRowsByPrefix issues a DELETE which
    // fires CQN on the still-subscribed previous detector) drains before
    // we wipe state. If we deleted first, the drained sweep would write
    // rows back after our wipe.
    await shutdown()

    await db.collection('cqn_checkpoints').deleteMany({})
    await db.collection('cqn_row_state').deleteMany({})

    config.set('changeDetection.defaultIntervalMs', 500)

    await bootstrap({ db, logger: createLogger() })
  })

  afterEach(async () => {
    await purgeRowsByPrefix(ID_PREFIX)
  })

  test('emits insert on a fresh row', async () => {
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

    const event = events.find((e) => e.id === pyid)

    expect(event).toMatchObject({
      type: 'insert',
      source: 'workorders',
      id: pyid
    })
    expect(event.row.pystatuswork).toBe('Open')
    expect(event.before).toBeUndefined()

    await watcher.stop()
  }, 30_000)

  test('emits update with before/row when a tracked row changes', async () => {
    const pyid = nextPyid()
    await directInsert(pyid, 'Open')

    const watcher = await watch('workorders')

    const events = []
    watcher.on('change', (event) => {
      if (event.id === pyid) {
        events.push(event)
      }
    })

    // Startup sweep records the row; only THEN do we mutate it, so the
    // first observed event for our id is the update, not the catch-up insert.
    await vi.waitFor(
      () => expect(events.some((e) => e.type === 'insert')).toBe(true),
      { timeout: 10_000, interval: 200 }
    )

    await directUpdate(pyid, 'Closed')

    await vi.waitFor(
      () => expect(events.some((e) => e.type === 'update')).toBe(true),
      { timeout: 10_000, interval: 200 }
    )

    const update = events.find((e) => e.type === 'update')

    expect(update.row.pystatuswork).toBe('Closed')
    expect(update.before.pystatuswork).toBe('Open')

    await watcher.stop()
  }, 30_000)

  test('emits delete with before when a tracked row is removed', async () => {
    const pyid = nextPyid()
    await directInsert(pyid, 'Open')

    const watcher = await watch('workorders')

    const events = []
    watcher.on('change', (event) => {
      if (event.id === pyid) {
        events.push(event)
      }
    })

    await vi.waitFor(
      () => expect(events.some((e) => e.type === 'insert')).toBe(true),
      { timeout: 10_000, interval: 200 }
    )

    await directDelete(pyid)

    await vi.waitFor(
      () => expect(events.some((e) => e.type === 'delete')).toBe(true),
      { timeout: 10_000, interval: 200 }
    )

    const del = events.find((e) => e.type === 'delete')

    expect(del.before.pystatuswork).toBe('Open')
    expect(del.row).toBeUndefined()

    await watcher.stop()
  }, 30_000)

  test('writing the same value back produces no event (hash-compare suppresses no-op updates)', async () => {
    const pyid = nextPyid()
    await directInsert(pyid, 'Open')

    const watcher = await watch('workorders')

    const events = []
    watcher.on('change', (event) => {
      if (event.id === pyid) {
        events.push(event)
      }
    })

    await vi.waitFor(
      () => expect(events.some((e) => e.type === 'insert')).toBe(true),
      { timeout: 10_000, interval: 200 }
    )

    // Write the SAME value back. The block-level ORA_ROWSCN of the source
    // row will bump (Oracle commits the no-op), so the watermark scan WILL
    // see this row — but the hash is unchanged, so no event.
    await directUpdate(pyid, 'Open')

    // Force a couple of sweeps to be sure
    await _detectorForTesting('workorders').triggerSweep('test')
    await _detectorForTesting('workorders').triggerSweep('test')

    const updates = events.filter((e) => e.type === 'update')

    expect(updates).toHaveLength(0)

    await watcher.stop()
  }, 30_000)

  test('idempotency: a second sweep over identical state emits no duplicate', async () => {
    const pyid = nextPyid()
    await directInsert(pyid, 'Open')

    const watcher = await watch('workorders')

    const events = []
    watcher.on('change', (event) => {
      if (event.id === pyid) {
        events.push(event)
      }
    })

    await vi.waitFor(() => expect(events.length).toBe(1), {
      timeout: 10_000,
      interval: 200
    })

    // Drive two more *real* sweeps on the same detector. With no DB change
    // between them, the watermark scan may re-examine the row (block-level
    // SCN can move), but the hash compare must suppress any duplicate event.
    const detector = _detectorForTesting('workorders')
    await detector.triggerSweep('test')
    await detector.triggerSweep('test')

    expect(events.length).toBe(1)

    await watcher.stop()
  }, 30_000)
})
