import { MongoClient } from 'mongodb'

import { initOracleDb, closeOracleDb } from '#/oracledb.js'
import { config } from '#/config.js'
import { bootstrap, watch, shutdown } from '#/change-detection/index.js'
import {
  makeIdPrefix,
  makePyidGenerator,
  directInsert,
  purgeRowsByPrefix,
  mvExists,
  dropMaterializedView
} from '#/change-detection/_test-helpers.js'

const skip = !process.env.ORACLE_CLIENT_LIB_DIR

const ID_PREFIX = makeIdPrefix('cqn-only')
const nextPyid = makePyidGenerator(ID_PREFIX)

/**
 * CQN-only mode (`changeDetection.mvEnabled: false` — the default): the
 * deployed-environment grant test. The detector must come up WITHOUT the
 * materialised view existing and without attempting to create it, subscribe
 * to CQN, and log raw notifications instead of sweeping. This is what lets
 * the app run against an Oracle user that has only been granted
 * CHANGE NOTIFICATION (plus SELECT on the source table).
 *
 * A capturing logger is injected through bootstrap() so the assertions can
 * observe the detector's log lines — in CQN-only mode the logs ARE the
 * observable behaviour (no domain events are emitted).
 */
function makeCapturingLogger() {
  const calls = { info: [], warn: [], error: [], debug: [] }

  const logger = {
    calls,
    info: (...args) => calls.info.push(args),
    warn: (...args) => calls.warn.push(args),
    error: (...args) => calls.error.push(args),
    debug: (...args) => calls.debug.push(args),
    child: () => logger
  }

  return logger
}

function loggedMessages(logger, level) {
  return logger.calls[level].map((args) =>
    args.find((arg) => typeof arg === 'string')
  )
}

describe.skipIf(skip)('#change-detection: CQN-only mode (Thick mode)', () => {
  let client
  let db
  let logger
  let workordersSource
  let originalMvEnabled

  beforeAll(async () => {
    await initOracleDb()

    client = await MongoClient.connect(globalThis.__MONGO_URI__)
    db = client.db('change-detection-test')

    workordersSource = config.get('changeDetection.sources').workorders

    originalMvEnabled = config.get('changeDetection.mvEnabled')

    // Explicit rather than relying on the default, so this suite still tests
    // CQN-only mode if the default flips back after the grant test.
    config.set('changeDetection.mvEnabled', false)
  }, 60_000)

  afterAll(async () => {
    await shutdown()
    await closeOracleDb()
    await client.close()

    config.set('changeDetection.mvEnabled', originalMvEnabled)
  })

  beforeEach(async () => {
    await shutdown()

    await db.collection('cqn_checkpoints').deleteMany({})
    await db.collection('cqn_row_state').deleteMany({})

    logger = makeCapturingLogger()

    await bootstrap({ db, logger })
  })

  afterEach(async () => {
    await purgeRowsByPrefix(ID_PREFIX)
  })

  test('starts without the MV, never deploys it, logs CQN notifications, emits no events', async () => {
    // Arrange: the MV must be absent so we prove start-up does not need it.
    await dropMaterializedView(workordersSource)
    expect(await mvExists(workordersSource)).toBe(false)

    // Act: watch() must resolve despite the missing MV — in MV mode this
    // same call would have deployed it (or failed without the grants).
    const watcher = await watch('workorders')

    const events = []
    watcher.on('change', (event) => events.push(event))

    // Assert: no MV deploy was attempted, and the CQN subscription is live.
    expect(await mvExists(workordersSource)).toBe(false)
    expect(loggedMessages(logger, 'info')).toContain('CQN wake-up subscribed')

    // Trigger a real change in the source table; the only visible effect
    // must be a logged notification, not a domain event.
    const pyid = nextPyid()
    await directInsert(pyid, 'Open')

    await vi.waitFor(
      () =>
        expect(loggedMessages(logger, 'info')).toContain(
          'CQN notification received (MV pipeline disabled; log-only)'
        ),
      { timeout: 15_000, interval: 200 }
    )

    const wakeup = logger.calls.info.find(
      (args) =>
        args[1] === 'CQN notification received (MV pipeline disabled; log-only)'
    )

    expect(wakeup[0].notification.tableName.toUpperCase()).toBe(
      'PEGA_DATA.AHWORK_AC'
    )

    // No sweeps ran: no domain events, no checkpoint writes, no row state.
    expect(events).toHaveLength(0)
    expect(await db.collection('cqn_checkpoints').countDocuments()).toBe(0)
    expect(await db.collection('cqn_row_state').countDocuments()).toBe(0)

    await watcher.stop()
  }, 60_000)
})
