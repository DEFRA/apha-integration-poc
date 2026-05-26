import { initOracleDb, closeOracleDb } from '#/oracledb.js'
import { config } from '#/config.js'
import { createLogger } from '#/common/helpers/logging/logger.js'
import { ensureMaterializedView } from '#/change-detection/mv-setup.js'
import {
  mvExists,
  dropMaterializedView
} from '#/change-detection/_test-helpers.js'

const skip = !process.env.ORACLE_CLIENT_LIB_DIR

describe.skipIf(skip)('#mv-setup (integration, Thick mode)', () => {
  let workordersSource

  beforeAll(async () => {
    await initOracleDb()

    workordersSource = config.get('changeDetection.sources').workorders
  }, 60_000)

  afterAll(async () => {
    await closeOracleDb()
  })

  test('creates the materialised view when it does not exist', async () => {
    await dropMaterializedView(workordersSource)

    const result = await ensureMaterializedView({
      sourceName: 'workorders',
      sourceConfig: workordersSource,
      logger: createLogger()
    })

    expect(result.created).toBe(true)
    expect(await mvExists(workordersSource)).toBe(true)
  }, 60_000)

  test('skips creation when the materialised view already exists', async () => {
    // Make sure it exists first.
    await ensureMaterializedView({
      sourceName: 'workorders',
      sourceConfig: workordersSource,
      logger: createLogger()
    })

    // Second call should be a no-op.
    const result = await ensureMaterializedView({
      sourceName: 'workorders',
      sourceConfig: workordersSource,
      logger: createLogger()
    })

    expect(result.created).toBe(false)
    expect(await mvExists(workordersSource)).toBe(true)
  }, 30_000)

  test('throws a clear error when the SQL file is missing for an unknown source', async () => {
    const bogusSource = { ...workordersSource, mv: 'APHA_POC.NOPE_MV' }

    await dropMaterializedView(bogusSource)

    await expect(
      ensureMaterializedView({
        sourceName: 'source-that-has-no-sql-file',
        sourceConfig: bogusSource,
        logger: createLogger()
      })
    ).rejects.toThrow(/No materialised-view SQL file found/)
  }, 30_000)
})
