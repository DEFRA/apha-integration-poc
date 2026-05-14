import { initOracleDb, closeOracleDb, getPool } from '#/oracledb.js'
import { createChangeQuery } from '#/cqn.js'

const skipCqn = !process.env.ORACLE_CLIENT_LIB_DIR

describe.skipIf(skipCqn)('#cqn (integration, Thick mode)', () => {
  beforeAll(async () => {
    await initOracleDb()
  }, 30_000)

  afterAll(async () => {
    await closeOracleDb()
  })

  test('emits "change" when another connection inserts into ahwork_ac', async () => {
    const pyid = `WS-CQN-${Date.now()}`

    const handler = vi.fn()

    const subscription = await createChangeQuery({
      pool: 'pega',
      query: 'SELECT pyid, pystatuswork FROM pega_data.ahwork_ac'
    })

    subscription.emitter.on('change', handler)

    const writer = await getPool('pega').getConnection()

    try {
      await writer.execute(
        `INSERT INTO pega_data.ahwork_ac (pyid, pzinskey, pxobjclass, pystatuswork)
         VALUES (:1, :2, 'AH-AC-WS', 'Open')`,
        [pyid, `AH-AC-WS ${pyid}`]
      )
      await writer.commit()
    } finally {
      await writer.close()
    }

    await vi.waitFor(
      () => {
        expect(handler).toHaveBeenCalled()
      },
      { timeout: 15_000, interval: 250 }
    )

    const [event] = handler.mock.calls[0]

    expect(event.tableName).toMatch(/AHWORK_AC$/i)

    expect(event.rows[0]).toMatchObject({ operation: 'INSERT' })

    await subscription.unsubscribe()

    const cleanup = await getPool('pega').getConnection()

    try {
      await cleanup.execute(
        `DELETE FROM pega_data.ahwork_ac WHERE pyid LIKE 'WS-CQN-%'`
      )
      await cleanup.commit()
    } finally {
      await cleanup.close()
    }
  }, 60_000)

  test('emits "change" with DELETE when another connection deletes a matching row', async () => {
    const pyid = `WS-CQN-${Date.now()}`

    const handler = vi.fn()

    // Pre-seed the row that will later be deleted. Commit before subscribing
    // so the change handler is not fired by this INSERT.
    const seeder = await getPool('pega').getConnection()

    try {
      await seeder.execute(
        `INSERT INTO pega_data.ahwork_ac (pyid, pzinskey, pxobjclass, pystatuswork)
         VALUES (:1, :2, 'AH-AC-WS', 'Open')`,
        [pyid, `AH-AC-WS ${pyid}`]
      )
      await seeder.commit()
    } finally {
      await seeder.close()
    }

    const subscription = await createChangeQuery({
      pool: 'pega',
      query: 'SELECT pyid, pystatuswork FROM pega_data.ahwork_ac'
    })

    subscription.emitter.on('change', handler)

    const deleter = await getPool('pega').getConnection()
    try {
      await deleter.execute(`DELETE FROM pega_data.ahwork_ac WHERE pyid = :1`, [
        pyid
      ])

      await deleter.commit()
    } finally {
      await deleter.close()
    }

    await vi.waitFor(
      () => {
        expect(handler).toHaveBeenCalled()
      },
      { timeout: 15_000, interval: 250 }
    )

    const [event] = handler.mock.calls[0]

    expect(event.tableName).toMatch(/AHWORK_AC$/i)

    expect(event.rows[0]).toMatchObject({ operation: 'DELETE' })

    await subscription.unsubscribe()

    const cleanup = await getPool('pega').getConnection()
    try {
      await cleanup.execute(
        `DELETE FROM pega_data.ahwork_ac WHERE pyid LIKE 'WS-CQN-%'`
      )

      await cleanup.commit()
    } finally {
      await cleanup.close()
    }
  }, 60_000)
})
