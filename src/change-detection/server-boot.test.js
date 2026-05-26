import { MongoClient } from 'mongodb'

// NOTE: All other imports are DYNAMIC. Static imports of `#/config.js` (or
// anything that transitively imports it) would force convict to initialise
// with whatever env vars exist at module-load time — which is BEFORE the
// vitest-mongodb setup hook sets `process.env.MONGO_URI`. The Hapi server's
// mongoDb plugin then connects to the default URL and the test fails.
// Following the pattern in src/plugins/mongodb.test.js.

/**
 * End-to-end integration test: boots the real Hapi server (which registers
 * the change-detection plugin), exercises the two materialised-view boot
 * scenarios — MV missing vs MV already present — and verifies that change
 * events flow through the full stack from a direct INSERT to a watcher.
 *
 * The test attaches its OWN `watch()` consumer alongside the plugin's
 * prototype console.log consumer. Both share the same underlying detector
 * via the registry, so we can observe events without spying on console
 * output. This is exactly the multi-consumer pattern the architecture is
 * designed for.
 */

const skip = !process.env.ORACLE_CLIENT_LIB_DIR

const ID_PREFIX = `WS-CD-${process.pid}-${Date.now()}-server-boot`

let pyidCounter = 0
const nextPyid = () => {
  pyidCounter += 1

  return `${ID_PREFIX}-${pyidCounter}`
}

describe.skipIf(skip)(
  '#change-detection: server boot (integration, Thick mode)',
  () => {
    // Modules loaded in beforeAll so config.js sees the memory-mongo URL.
    let config
    let initOracleDb
    let closeOracleDb
    let ensureMaterializedView
    let watch
    let shutdown
    let createLogger
    let mvExists
    let dropMaterializedView
    let getMvCreatedAt
    let directInsert
    let purgeRowsByPrefix

    let mongoClient
    let pluginDb
    let server
    let testWatcher
    let workordersSource
    let originalEnabled
    let originalInterval

    beforeAll(async () => {
      // Memory mongo is up by now (vitest-mongodb's setup beforeAll ran first
      // because it was declared in setupFiles). Loading config.js *now* picks
      // up the right MONGO_URI.
      ;({ config } = await import('#/config.js'))
      ;({ initOracleDb, closeOracleDb } = await import('#/oracledb.js'))
      ;({ ensureMaterializedView } =
        await import('#/change-detection/mv-setup.js'))
      ;({ watch, shutdown } = await import('#/change-detection/index.js'))
      ;({ createLogger } = await import('#/common/helpers/logging/logger.js'))
      ;({
        mvExists,
        dropMaterializedView,
        getMvCreatedAt,
        directInsert,
        purgeRowsByPrefix
      } = await import('#/change-detection/_test-helpers.js'))

      mongoClient = await MongoClient.connect(globalThis.__MONGO_URI__)
      pluginDb = mongoClient.db(config.get('mongo.databaseName'))

      workordersSource = config.get('changeDetection.sources').workorders

      originalEnabled = config.get('changeDetection.enabled')
      originalInterval = config.get('changeDetection.defaultIntervalMs')

      config.set('changeDetection.enabled', true)
      config.set('changeDetection.defaultIntervalMs', 500)
    }, 60_000)

    afterAll(async () => {
      config.set('changeDetection.enabled', originalEnabled)
      config.set('changeDetection.defaultIntervalMs', originalInterval)

      await mongoClient.close()
    })

    beforeEach(async () => {
      // Clear module-level registry left by any earlier test file.
      await shutdown().catch(() => {})

      // Each boot starts from a clean state-store so the detector's first
      // sweep classifies the existing source rows from scratch.
      await pluginDb.collection('cqn_checkpoints').deleteMany({})
      await pluginDb.collection('cqn_row_state').deleteMany({})
    })

    afterEach(async () => {
      if (testWatcher) {
        await testWatcher.stop().catch(() => {})
        testWatcher = null
      }

      if (server) {
        // server.stop() fires the 'stop' event which triggers both the
        // change-detection plugin's tear-down (watchers + shutdown registry)
        // and the oracleDb plugin's tear-down (closeOracleDb).
        await server.stop({ timeout: 5000 }).catch(() => {})
        server = null
      }

      // Safety net: if the test failed before server.stop, the pools may
      // still be open. close them so the next test can re-init cleanly.
      await closeOracleDb().catch(() => {})

      // Purge test rows. May fail silently if pools are closed.
      await purgeRowsByPrefix(ID_PREFIX).catch(() => {})
    })

    test('cold boot: MV does not exist → server creates it on startup and events flow', async () => {
      // Arrange: ensure the MV is absent so we genuinely test the "creates"
      // path. Pools need to be alive briefly for the drop, but we close them
      // again so the server's own boot path is what creates the next set.
      await initOracleDb()
      await dropMaterializedView(workordersSource)
      expect(await mvExists(workordersSource)).toBe(false)
      await closeOracleDb()

      // Act: boot the server exactly as production does — pools first, then
      // the Hapi server. The change-detection plugin's `register` runs during
      // `initialize`, which transitively calls Detector.start() → mv-setup,
      // which must deploy the MV.
      await initOracleDb()

      const { createServer } = await import('#/server.js')

      server = await createServer()
      await server.initialize()

      // Assert: the plugin's boot deployed the MV.
      expect(await mvExists(workordersSource)).toBe(true)

      // Now exercise the materialised view by triggering a real change and
      // observing it through our own watcher (which shares the detector with
      // the plugin's console.log consumer).
      testWatcher = await watch('workorders')

      const events = []
      testWatcher.on('change', (event) => {
        events.push(event)
      })

      const pyid = nextPyid()
      await directInsert(pyid, 'Open')

      await vi.waitFor(
        () => expect(events.some((e) => e.id === pyid)).toBe(true),
        { timeout: 10_000, interval: 200 }
      )

      const event = events.find((e) => e.id === pyid)

      expect(event.type).toBe('insert')
      expect(event.source).toBe('workorders')
      expect(event.row.pystatuswork).toBe('Open')
    }, 60_000)

    test('warm boot: MV already exists → server reuses it without recreating, events flow', async () => {
      // Arrange: ensure the MV exists, then capture its creation timestamp.
      // After server boot, the timestamp must be unchanged — proving the
      // mv-setup path saw the existing MV and skipped the deploy.
      await initOracleDb()
      await ensureMaterializedView({
        sourceName: 'workorders',
        sourceConfig: workordersSource,
        logger: createLogger()
      })

      expect(await mvExists(workordersSource)).toBe(true)

      const createdBefore = await getMvCreatedAt(workordersSource)

      expect(createdBefore).toBeDefined()

      await closeOracleDb()

      // Act: boot the server. The plugin's `register` calls ensureMV; with
      // the MV already in place, it should log "skipping deploy" and proceed
      // straight to wiring up the timer / CQN.
      await initOracleDb()

      const { createServer } = await import('#/server.js')

      server = await createServer()
      await server.initialize()

      // Assert: MV is still there AND has not been recreated. Equal
      // timestamps would be impossible if the plugin had dropped and
      // re-created the MV during boot.
      expect(await mvExists(workordersSource)).toBe(true)
      expect(await getMvCreatedAt(workordersSource)).toEqual(createdBefore)

      // Exercise: events flow end-to-end just as they would on a cold boot.
      testWatcher = await watch('workorders')

      const events = []
      testWatcher.on('change', (event) => {
        events.push(event)
      })

      const pyid = nextPyid()
      await directInsert(pyid, 'Open')

      await vi.waitFor(
        () => expect(events.some((e) => e.id === pyid)).toBe(true),
        { timeout: 10_000, interval: 200 }
      )
    }, 60_000)
  }
)
