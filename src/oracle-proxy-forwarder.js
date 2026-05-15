import net from 'node:net'

/**
 * Start one HTTP-CONNECT-tunnel forwarder per unique upstream `host:port`,
 * listening on localhost. Each forwarder accepts plain-TCP client connections
 * and bridges them through the HTTP proxy (via the CONNECT method) to the real
 * upstream.
 *
 * Required for node-oracledb Thick mode behind the CDP egress proxy: Thick
 * mode ignores the `httpsProxy`/`httpsProxyPort` pool attributes (those are
 * documented as Thin-mode-only). Without a forwarder, pool connections open
 * plain TCP straight at the upstream and time out in the deployed environment
 * where Squid is the only egress route.
 */
export async function startProxyForwarders({ targets, proxy, logger }) {
  const unique = [...new Set(targets)]
  const map = {}
  const servers = []

  for (const target of unique) {
    const [targetHost, targetPortStr] = target.split(':')
    const targetPort = Number(targetPortStr)

    if (!targetHost || !targetPort) {
      throw new Error(
        `Invalid upstream target "${target}" (expected host:port)`
      )
    }

    const server = net.createServer((client) => {
      const upstream = net.connect(proxy.port, proxy.host, () => {
        upstream.write(
          `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` +
            `Host: ${targetHost}:${targetPort}\r\n\r\n`
        )
      })

      let established = false
      let buf = Buffer.alloc(0)

      upstream.on('data', (chunk) => {
        if (established) return

        buf = Buffer.concat([buf, chunk])
        const idx = buf.indexOf('\r\n\r\n')
        if (idx === -1) return

        const status = buf.slice(0, idx).toString().split('\r\n')[0]
        if (!/^HTTP\/1\.[01] 200/.test(status)) {
          logger.error(
            { target, status },
            'Proxy refused CONNECT for OracleDB tunnel'
          )
          client.destroy()
          upstream.destroy()
          return
        }

        established = true
        const leftover = buf.slice(idx + 4)
        if (leftover.length) client.write(leftover)
        upstream.pipe(client)
        client.pipe(upstream)
      })

      client.on('error', () => upstream.destroy())
      upstream.on('error', (err) => {
        logger.warn(
          { err: err.message, target },
          'OracleDB tunnel upstream error'
        )
        client.destroy()
      })
    })

    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })

    const localPort = server.address().port
    map[target] = `localhost:${localPort}`
    servers.push(server)

    logger.info(
      `Started OracleDB CONNECT-tunnel: localhost:${localPort} -> ${target} (via ${proxy.host}:${proxy.port})`
    )
  }

  return {
    map,
    close: async () => {
      await Promise.all(
        servers.map(
          (s) => new Promise((resolve) => s.close(() => resolve(undefined)))
        )
      )
    }
  }
}
