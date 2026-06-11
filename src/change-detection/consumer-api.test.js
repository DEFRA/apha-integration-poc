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
  purgeRowsByPrefix
} from '#/change-detection/_test-helpers.js'

const skip = !process.env.ORACLE_CLIENT_LIB_DIR

const ID_PREFIX = makeIdPrefix('consumer-api')
const nextPyid = makePyidGenerator(ID_PREFIX)

describe.skipIf(skip)('#change-detection: consumer API', () => {
  let client
  let db
  let originalIntervalMs
  let originalMvEnabled

  beforeAll(async () => {
    await initOracleDb()

    client = await MongoClient.connect(globalThis.__MONGO_URI__)
    db = client.db('change-detection-test')

    originalIntervalMs = config.get('changeDetection.defaultIntervalMs')
    originalMvEnabled = config.get('changeDetection.mvEnabled')

    // This suite exercises the full MV pipeline; the default is CQN-only.
    config.set('changeDetection.mvEnabled', true)
  }, 60_000)

  afterAll(async () => {
    await shutdown()
    await closeOracleDb()
    await client.close()

    config.set('changeDetection.defaultIntervalMs', originalIntervalMs)
    config.set('changeDetection.mvEnabled', originalMvEnabled)
  })

  beforeEach(async () => {
    // shutdown() first so any in-flight CQN-triggered sweep from the
    // previous test's afterEach drains before we wipe state. See the
    // matching comment in basics.test.js for the full reasoning.
    await shutdown()

    await db.collection('cqn_checkpoints').deleteMany({})
    await db.collection('cqn_row_state').deleteMany({})

    config.set('changeDetection.defaultIntervalMs', 500)

    await bootstrap({ db, logger: createLogger() })
  })

  afterEach(async () => {
    await purgeRowsByPrefix(ID_PREFIX)
  })

  test('two consumers share one detector; stopping one does not affect the other', async () => {
    const a = await watch('workorders')
    const b = await watch('workorders')

    // Same registry entry → same underlying detector.
    expect(_detectorForTesting('workorders')).toBeDefined()

    const eventsA = []
    const eventsB = []
    a.on('change', (event) => {
      eventsA.push(event)
    })
    b.on('change', (event) => {
      eventsB.push(event)
    })

    const pyid1 = nextPyid()
    await directInsert(pyid1, 'Open')

    await vi.waitFor(
      () =>
        expect(eventsA.some((e) => e.id === pyid1)).toBe(true) &&
        expect(eventsB.some((e) => e.id === pyid1)).toBe(true),
      { timeout: 10_000, interval: 200 }
    )

    // Stop A; B must continue receiving events from the same detector.
    await a.stop()

    const pyid2 = nextPyid()
    await directInsert(pyid2, 'Open')

    await vi.waitFor(
      () => expect(eventsB.some((e) => e.id === pyid2)).toBe(true),
      { timeout: 10_000, interval: 200 }
    )

    expect(eventsA.some((e) => e.id === pyid2)).toBe(false)

    await b.stop()
  }, 30_000)

  test('filter option suppresses events that do not match', async () => {
    const watcher = await watch('workorders', {
      filter: (event) => event.row?.pystatuswork === 'Closed'
    })

    const events = []
    watcher.on('change', (event) => {
      events.push(event)
    })

    const openId = nextPyid()
    const closedId = nextPyid()

    await directInsert(openId, 'Open')
    await directInsert(closedId, 'Closed')

    await vi.waitFor(
      () => expect(events.some((e) => e.id === closedId)).toBe(true),
      { timeout: 10_000, interval: 200 }
    )

    // The Open row must not have been emitted to THIS watcher.
    expect(events.some((e) => e.id === openId)).toBe(false)

    await watcher.stop()
  }, 30_000)

  test('shape option transforms emitted row and before payloads', async () => {
    const watcher = await watch('workorders', {
      shape: (row) => ({ id: row.pyid, status: row.pystatuswork })
    })

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

    expect(event.row).toEqual({ id: pyid, status: 'Open' })

    // Source-level fields like pzinskey must not survive the shape transform.
    expect(event.row.pzinskey).toBeUndefined()

    await watcher.stop()
  }, 30_000)
})
