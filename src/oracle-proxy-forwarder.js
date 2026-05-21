/**
 * tcp-over-http-connect bridge for thick-mode oracle through the cdp squid proxy.
 *
 * thin mode honors `httpsproxy`/`httpsproxyport` pool attrs and tunnels itself;
 * thick mode (which we need for cqn) does not — it tries plain tcp to the
 * oracle ip, finds no route from inside the pod, and times out.
 *
 * fix: run a tiny tcp server on localhost per unique upstream, rewrite each
 * pool's connect string to point at it, and have it dial squid and issue an
 * http connect to the real oracle host:port. once squid replies "200", the
 * two sockets are glued together for transparent bidirectional bytes.
 */

import net from 'node:net'

/**
 * start one http-connect-tunnel forwarder per unique upstream `host:port`,
 * listening on localhost.
 *
 * @param {string[]} targets array of "host:port" strings (deduped)
 * @param {{ host: string, port: number }} proxy the squid proxy to tunnel through
 * @param {object} logger pino-style logger (.info / .warn / .error)
 * @returns {Promise<{ map: Record<string,string>, close: () => Promise<void> }>}
 *
 * example map entry: { "10.62.132.5:31536": "localhost:54321" }
 */
export async function startProxyForwarders({ targets, proxy, logger }) {
  // dedupe upstreams — sam and pega currently share one endpoint
  const unique = [...new Set(targets)]
  const map = {}
  const servers = []

  for (const target of unique) {
    const [targetHost, targetPortStr] = target.split(':')
    const targetPort = Number(targetPortStr)

    /** reject broken input before starting a server (nan is falsy). */
    if (!targetHost || !targetPort) {
      throw new Error(
        `Invalid upstream target "${target}" (expected host:port)`
      )
    }

    /**
     * `allowhalfopen: true` is essential — by default node closes both
     * directions of a socket when one side fins, which would cascade
     * through the chain and sever the return path mid-conversation.
     */
    const server = net.createServer({ allowHalfOpen: true }, (client) => {
      // `client` is the socket from the oracle pool

      const upstream = net.connect(
        { host: proxy.host, port: proxy.port, allowHalfOpen: true },
        () => {
          /**
           * http connect wire format:
           *   CONNECT host:port HTTP/1.1\r\n
           *   Host: host:port\r\n
           *   \r\n
           * squid replies "HTTP/1.1 200 ..." on success; parsed below.
           */
          upstream.write(
            `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` +
              `Host: ${targetHost}:${targetPort}\r\n\r\n`
          )
        }
      )

      /**
       * handshake state. tcp doesn't guarantee chunk boundaries, so we
       * accumulate into `buf` until we see the end of the response headers.
       */
      let established = false
      let buf = Buffer.alloc(0)

      upstream.on('data', (chunk) => {
        // after handshake, `pipe()` takes over — this listener no-ops
        if (established) return

        buf = Buffer.concat([buf, chunk])
        const idx = buf.indexOf('\r\n\r\n')
        if (idx === -1) return // headers incomplete — wait for more

        const status = buf.slice(0, idx).toString().split('\r\n')[0]
        if (!/^HTTP\/1\.[01] 200/.test(status)) {
          /**
           * squid said no — typically 403 (acl) or 407 (proxy auth).
           * platform/config issue, not a retryable hiccup.
           */
          logger.error(
            { target, status },
            'Proxy refused CONNECT for OracleDB tunnel'
          )
          client.destroy()
          upstream.destroy()
          return
        }

        established = true

        // squid may piggy-back upstream bytes onto the same chunk as "200"
        const leftover = buf.slice(idx + 4)
        if (leftover.length) client.write(leftover)

        // glue the sockets together — transparent bidirectional bytes from here
        upstream.pipe(client)
        client.pipe(upstream)
      })

      // if either side errors, drop the other so we don't leak half-open sockets
      client.on('error', () => upstream.destroy())
      upstream.on('error', (err) => {
        // tcp link to squid failed; pool will reconnect on its own
        logger.warn(
          { err: err.message, target },
          'OracleDB tunnel upstream error'
        )
        client.destroy()
      })
    })

    /**
     * port 0 → kernel picks any free port; 127.0.0.1 binds loopback-only
     * so the forwarder is never reachable from outside the pod.
     */
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })

    const localPort = server.address().port

    // src/oracledb.js uses this map to rewrite each pool's connect string
    map[target] = `localhost:${localPort}`
    servers.push(server)

    logger.info(
      `Started OracleDB CONNECT-tunnel: localhost:${localPort} -> ${target} (via ${proxy.host}:${proxy.port})`
    )
  }

  return {
    map,
    /**
     * graceful shutdown — stops accepting new connections; existing ones
     * finish on their own per node's net.server polite-shutdown semantics.
     */
    close: async () => {
      await Promise.all(
        servers.map(
          (s) => new Promise((resolve) => s.close(() => resolve(undefined)))
        )
      )
    }
  }
}
