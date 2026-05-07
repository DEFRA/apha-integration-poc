import { initOracleDb, closeOracleDb, getPool } from '#/oracledb.js'

const POOLS = ['sam', 'pega']

describe('#oracledb (integration)', () => {
  beforeAll(async () => {
    await initOracleDb()
  }, 30_000)

  afterAll(async () => {
    await closeOracleDb()
  })

  test.each(POOLS)('getPool(%s) returns the configured pool', (name) => {
    const pool = getPool(name)

    expect(pool.poolAlias).toBe(`${name}Pool`)
  })

  test.each(POOLS)(
    'SELECT 1 FROM DUAL succeeds via the %s pool',
    async (name) => {
      const connection = await getPool(name).getConnection()

      try {
        const result = await connection.execute('SELECT 1 FROM DUAL')

        expect(result.rows).toEqual([[1]])
      } finally {
        await connection.close()
      }
    },
    15_000
  )
})
