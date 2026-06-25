import net from 'node:net'

import { initOracleDb, closeOracleDb, getPool } from '#/oracledb.js'
import { config } from '#/config.js'

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

/**
 * Minimal HTTP-CONNECT proxy: accepts `CONNECT host:port` and bridges raw
 * bytes to that host:port. Used to exercise the full proxy wiring end-to-end
 * (oracledb.js → forwarder → fake proxy → real Oracle) without needing a real
 * Squid in CI.
 */
async function startFakeConnectProxy() {
  const server = net.createServer({ allowHalfOpen: true }, (client) => {
    let buf = Buffer.alloc(0)
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk])
      const idx = buf.indexOf('\r\n\r\n')
      if (idx === -1) return

      client.removeListener('data', onData)

      const requestLine = buf.slice(0, idx).toString().split('\r\n')[0]
      const m = /^CONNECT\s+(\S+):(\d+)\s+HTTP\/1\.[01]$/i.exec(requestLine)
      if (!m) {
        client.write('HTTP/1.1 400 Bad Request\r\n\r\n')
        client.end()
        return
      }

      const leftover = buf.slice(idx + 4)
      const upstream = net.connect(
        { host: m[1], port: Number(m[2]), allowHalfOpen: true },
        () => {
          client.write('HTTP/1.1 200 OK\r\n\r\n')
          if (leftover.length) upstream.write(leftover)
          client.pipe(upstream)
          upstream.pipe(client)
        }
      )
      upstream.on('error', () => client.destroy())
    }
    client.on('data', onData)
    client.on('error', () => {})
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))

  return {
    host: '127.0.0.1',
    port: server.address().port,
    close: () =>
      new Promise((resolve) => server.close(() => resolve(undefined)))
  }
}

describe('#oracledb (integration, via HTTP-CONNECT proxy)', () => {
  let proxy

  beforeAll(async () => {
    proxy = await startFakeConnectProxy()
    // Setting httpProxy makes initOracleDb start the in-process forwarder
    // (thick mode) or attach `httpsProxy`/`httpsProxyPort` to pool attrs
    // (thin mode). Either way, all Oracle traffic now traverses the fake
    // proxy → real Oracle path, exercising the full deployed-env wiring.
    config.set('httpProxy', `http://${proxy.host}:${proxy.port}`)

    await initOracleDb()
  }, 30_000)

  afterAll(async () => {
    await closeOracleDb()
    config.set('httpProxy', null)
    await proxy.close()
  })

  test.each(POOLS)(
    'SELECT 1 FROM DUAL succeeds via the %s pool through the proxy',
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
