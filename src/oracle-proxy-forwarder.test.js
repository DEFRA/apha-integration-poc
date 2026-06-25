import net from 'node:net'

import { startProxyForwarders } from '#/oracle-proxy-forwarder.js'

const createLogger = () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn()
})

/**
 * Minimal HTTP-CONNECT proxy for tests. Accepts `CONNECT host:port HTTP/1.1`,
 * optionally rewrites the upstream target, replies with the configured status,
 * then pipes bytes to/from the upstream.
 */
async function startFakeProxy({
  status = 'HTTP/1.1 200 OK',
  overrideTarget,
  fragmentStatus = false,
  onConnect
} = {}) {
  const server = net.createServer({ allowHalfOpen: true }, (client) => {
    let buf = Buffer.alloc(0)

    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk])
      const idx = buf.indexOf('\r\n\r\n')
      if (idx === -1) return

      // Stop consuming; without 'data' listeners, the stream pauses and any
      // further client bytes accumulate in the buffer until pipe resumes it.
      client.removeListener('data', onData)

      const header = buf.slice(0, idx).toString()
      const leftover = buf.slice(idx + 4)
      const requestLine = header.split('\r\n')[0]
      const m = /^CONNECT\s+(\S+):(\d+)\s+HTTP\/1\.[01]$/i.exec(requestLine)
      if (!m) {
        client.write('HTTP/1.1 400 Bad Request\r\n\r\n')
        client.end()
        return
      }

      onConnect?.({ host: m[1], port: Number(m[2]) })

      if (!/^HTTP\/1\.[01] 2\d\d/.test(status)) {
        client.write(`${status}\r\n\r\n`)
        client.end()
        return
      }

      const target = overrideTarget ?? { host: m[1], port: Number(m[2]) }
      const upstream = net.connect(
        { host: target.host, port: target.port, allowHalfOpen: true },
        () => {
          if (fragmentStatus) {
            client.write(`${status}\r\n`)
            setImmediate(() => client.write('\r\n'))
          } else {
            client.write(`${status}\r\n\r\n`)
          }
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

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })

  return {
    host: '127.0.0.1',
    port: server.address().port,
    close: () =>
      new Promise((resolve) => server.close(() => resolve(undefined)))
  }
}

async function startEchoServer() {
  const server = net.createServer({ allowHalfOpen: true }, (sock) =>
    sock.pipe(sock)
  )
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    host: '127.0.0.1',
    port: server.address().port,
    close: () =>
      new Promise((resolve) => server.close(() => resolve(undefined)))
  }
}

function tcpExchange(host, port, payload) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, host)
    const chunks = []
    sock.on('data', (c) => chunks.push(c))
    sock.on('end', () => resolve(Buffer.concat(chunks)))
    sock.on('error', reject)
    sock.on('connect', () => {
      sock.write(payload)
      sock.end()
    })
  })
}

function splitHostPort(s) {
  const [host, port] = s.split(':')
  return { host, port: Number(port) }
}

describe('#startProxyForwarders', () => {
  test('round-trips bytes from localhost client through proxy to upstream', async () => {
    const upstream = await startEchoServer()
    const proxy = await startFakeProxy()
    const logger = createLogger()
    const target = `${upstream.host}:${upstream.port}`

    const fwd = await startProxyForwarders({
      targets: [target],
      proxy: { host: proxy.host, port: proxy.port },
      logger
    })

    try {
      const local = splitHostPort(fwd.map[target])
      const echoed = await tcpExchange(local.host, local.port, 'hello-oracle')
      expect(echoed.toString()).toBe('hello-oracle')
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringMatching(/Started OracleDB CONNECT-tunnel/)
      )
    } finally {
      await fwd.close()
      await proxy.close()
      await upstream.close()
    }
  })

  test('passes the correct host:port in the CONNECT request', async () => {
    const upstream = await startEchoServer()
    const seenConnects = []
    const proxy = await startFakeProxy({
      onConnect: (t) => seenConnects.push(t),
      overrideTarget: { host: upstream.host, port: upstream.port }
    })
    const target = '10.62.132.5:31536'

    const fwd = await startProxyForwarders({
      targets: [target],
      proxy: { host: proxy.host, port: proxy.port },
      logger: createLogger()
    })

    try {
      const local = splitHostPort(fwd.map[target])
      await tcpExchange(local.host, local.port, 'x')
      expect(seenConnects).toEqual([{ host: '10.62.132.5', port: 31536 }])
    } finally {
      await fwd.close()
      await proxy.close()
      await upstream.close()
    }
  })

  test('deduplicates targets and returns distinct local ports per upstream', async () => {
    const a = await startEchoServer()
    const b = await startEchoServer()
    const proxy = await startFakeProxy()
    const targetA = `${a.host}:${a.port}`
    const targetB = `${b.host}:${b.port}`

    const fwd = await startProxyForwarders({
      targets: [targetA, targetA, targetB],
      proxy: { host: proxy.host, port: proxy.port },
      logger: createLogger()
    })

    try {
      expect(Object.keys(fwd.map).sort()).toEqual([targetA, targetB].sort())
      expect(fwd.map[targetA]).not.toBe(fwd.map[targetB])

      const localA = splitHostPort(fwd.map[targetA])
      const localB = splitHostPort(fwd.map[targetB])
      const [echoedA, echoedB] = await Promise.all([
        tcpExchange(localA.host, localA.port, 'route-A'),
        tcpExchange(localB.host, localB.port, 'route-B')
      ])
      expect(echoedA.toString()).toBe('route-A')
      expect(echoedB.toString()).toBe('route-B')
    } finally {
      await fwd.close()
      await proxy.close()
      await a.close()
      await b.close()
    }
  })

  test('throws on malformed target', async () => {
    const logger = createLogger()

    await expect(
      startProxyForwarders({
        targets: ['hostonly'],
        proxy: { host: '127.0.0.1', port: 9999 },
        logger
      })
    ).rejects.toThrow(/Invalid upstream target/)

    await expect(
      startProxyForwarders({
        targets: ['host:notanumber'],
        proxy: { host: '127.0.0.1', port: 9999 },
        logger
      })
    ).rejects.toThrow(/Invalid upstream target/)
  })

  test('logs error and tears down the client when the proxy refuses CONNECT', async () => {
    const proxy = await startFakeProxy({ status: 'HTTP/1.1 403 Forbidden' })
    const logger = createLogger()

    const fwd = await startProxyForwarders({
      targets: ['example.invalid:1521'],
      proxy: { host: proxy.host, port: proxy.port },
      logger
    })

    try {
      const local = splitHostPort(fwd.map['example.invalid:1521'])
      const received = await new Promise((resolve, reject) => {
        const sock = net.connect(local.port, local.host)
        const chunks = []
        sock.on('data', (c) => chunks.push(c))
        sock.on('close', () => resolve(Buffer.concat(chunks)))
        sock.on('error', reject)
      })
      expect(received.length).toBe(0)

      await vi.waitFor(() => {
        expect(logger.error).toHaveBeenCalledWith(
          expect.objectContaining({
            status: expect.stringContaining('403')
          }),
          expect.stringMatching(/refused CONNECT/i)
        )
      })
    } finally {
      await fwd.close()
      await proxy.close()
    }
  })

  test('handles fragmented HTTP CONNECT response from the proxy', async () => {
    const upstream = await startEchoServer()
    const proxy = await startFakeProxy({ fragmentStatus: true })
    const target = `${upstream.host}:${upstream.port}`

    const fwd = await startProxyForwarders({
      targets: [target],
      proxy: { host: proxy.host, port: proxy.port },
      logger: createLogger()
    })

    try {
      const local = splitHostPort(fwd.map[target])
      const echoed = await tcpExchange(local.host, local.port, 'fragmented')
      expect(echoed.toString()).toBe('fragmented')
    } finally {
      await fwd.close()
      await proxy.close()
      await upstream.close()
    }
  })

  test('logs upstream error and closes client when the proxy is unreachable', async () => {
    // Pick a localhost port that nothing is listening on; ECONNREFUSED is immediate.
    const dead = net.createServer()
    await new Promise((resolve) => dead.listen(0, '127.0.0.1', resolve))
    const deadPort = dead.address().port
    await new Promise((resolve) => dead.close(resolve))

    const logger = createLogger()

    const fwd = await startProxyForwarders({
      targets: ['127.0.0.1:1521'],
      proxy: { host: '127.0.0.1', port: deadPort },
      logger
    })

    try {
      const local = splitHostPort(fwd.map['127.0.0.1:1521'])
      await new Promise((resolve) => {
        const sock = net.connect(local.port, local.host)
        sock.on('close', resolve)
        sock.on('error', resolve)
      })

      await vi.waitFor(() => {
        expect(logger.warn).toHaveBeenCalledWith(
          expect.objectContaining({ err: expect.any(String) }),
          expect.stringMatching(/upstream error/i)
        )
      })
    } finally {
      await fwd.close()
    }
  })

  test('close() stops the forwarder from accepting new connections', async () => {
    const upstream = await startEchoServer()
    const proxy = await startFakeProxy()
    const target = `${upstream.host}:${upstream.port}`

    const fwd = await startProxyForwarders({
      targets: [target],
      proxy: { host: proxy.host, port: proxy.port },
      logger: createLogger()
    })

    const local = splitHostPort(fwd.map[target])
    await fwd.close()

    await expect(
      new Promise((resolve, reject) => {
        const sock = net.connect(local.port, local.host)
        sock.on('connect', () => {
          sock.end()
          resolve('connected')
        })
        sock.on('error', reject)
      })
    ).rejects.toThrow()

    await proxy.close()
    await upstream.close()
  })
})
