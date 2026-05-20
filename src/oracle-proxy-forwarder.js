// =============================================================================
// Oracle proxy forwarder — a tiny TCP-over-HTTP-CONNECT bridge for Thick mode
// =============================================================================
//
// Why does this file exist?
// -------------------------
// In the deployed CDP environment, the only outbound network route is a Squid
// HTTP proxy (its address comes from the `HTTP_PROXY` environment variable).
// All traffic to the SAM/PEGA Oracle databases has to go through it.
//
// node-oracledb's *Thin* mode knows how to use that proxy on its own — you set
// `httpsProxy`/`httpsProxyPort` on the pool and the driver tunnels through.
// But our app runs *Thick* mode (because Continuous Query Notification is a
// Thick-mode-only feature), and Thick mode's connection layer ignores those
// proxy attributes — they are documented as Thin-mode-only. Without help, a
// Thick-mode pool tries to open a plain TCP socket straight at the Oracle IP,
// finds no route from inside the pod, and hangs until it times out.
//
// What does this file do?
// -----------------------
// It runs a tiny TCP server on localhost, one per unique upstream Oracle
// endpoint. We then rewrite each pool's connect string in src/oracledb.js so
// it points at this local server instead of the real Oracle host:
//   "10.62.132.5:31536/SVCNAME"  ->  "localhost:<picked-port>/SVCNAME"
// The Oracle Thick-mode client thinks it is talking to a local database. When
// it opens a connection, this server:
//
//   1. dials the Squid proxy on plain TCP
//   2. sends Squid an HTTP CONNECT request asking it to tunnel to the real
//      Oracle host:port
//   3. once Squid replies "200 Connection established", glues the two sockets
//      together so bytes flow transparently in both directions
//
// HTTP CONNECT is a built-in part of HTTP/1.1 — a client says "open a raw TCP
// tunnel to host:port and just forward bytes". Squid speaks it; that's the
// only thing we need from the proxy.
// =============================================================================

// Node's low-level TCP module — gives us TCP sockets (net.connect) and TCP
// servers (net.createServer). Lower-level than `http` or `fetch`: just bytes.
import net from 'node:net'

/**
 * Start one HTTP-CONNECT-tunnel forwarder per unique upstream `host:port`,
 * listening on localhost.
 *
 * Parameters:
 *   - targets:  array of "host:port" strings (may contain duplicates — deduped)
 *   - proxy:    { host, port } of the Squid HTTP proxy to tunnel through
 *   - logger:   pino-style logger; we call .info / .warn / .error on it
 *
 * Returns:
 *   {
 *     map:    { "<original-host:port>": "localhost:<chosen-port>", ... },
 *     close:  async () => void   // stops accepting new connections
 *   }
 *
 * Example map entry:
 *   { "10.62.132.5:31536": "localhost:54321" }
 */
export async function startProxyForwarders({ targets, proxy, logger }) {
  // SAM and PEGA currently share the same Oracle endpoint, so we only need
  // one forwarder per *unique* upstream. `new Set(...)` strips duplicates;
  // the spread turns it back into an array we can iterate.
  const unique = [...new Set(targets)]

  // Will be populated with one entry per unique target as we start forwarders.
  const map = {}

  // We keep references to every server we start so `close()` (below) can
  // shut them all down at the end of process lifetime.
  const servers = []

  for (const target of unique) {
    // "host:port" -> ["host", "port"]. The port is still a string at this
    // point — Number(...) on the next line converts it.
    const [targetHost, targetPortStr] = target.split(':')
    const targetPort = Number(targetPortStr)

    // Reject obviously-broken input *before* we start a server. A missing
    // host or a non-numeric port (Number(...) returns NaN, which is falsy)
    // would silently produce a server that never tunnels anywhere useful.
    if (!targetHost || !targetPort) {
      throw new Error(
        `Invalid upstream target "${target}" (expected host:port)`
      )
    }

    // -------------------------------------------------------------------------
    // Build the localhost TCP server that the Oracle client will connect to.
    // -------------------------------------------------------------------------
    //
    // `allowHalfOpen: true` is important and easy to overlook. A TCP socket
    // has TWO independent directions: the side that reads and the side that
    // writes. When one side sends a FIN ("I'm done sending"), Node by default
    // closes BOTH directions on the corresponding socket. In a forwarder, that
    // auto-close cascades through the whole chain — client/forwarder/proxy/
    // upstream — and severs the response path before bytes can flow back.
    // Setting `allowHalfOpen: true` keeps each direction independent so we
    // faithfully relay only the half-close that was asked for, the way a real
    // router or proxy does.
    const server = net.createServer({ allowHalfOpen: true }, (client) => {
      // The arrow function above runs once for every incoming TCP connection.
      // `client` is the socket on this end of that incoming connection — in
      // production, that's a node-oracledb connection from a pool.

      // Open a TCP connection to the Squid proxy. Same allowHalfOpen rationale
      // as above. The third argument is a callback that fires once the TCP
      // connection to the proxy is fully established.
      const upstream = net.connect(
        { host: proxy.host, port: proxy.port, allowHalfOpen: true },
        () => {
          // We're connected to Squid. Ask it to open a raw TCP tunnel to the
          // real Oracle host:port using the HTTP CONNECT method.
          //
          // The wire format is plain HTTP/1.1 over the socket we just opened:
          //   CONNECT host:port HTTP/1.1\r\n
          //   Host: host:port\r\n
          //   \r\n          <- blank line terminates the headers
          //
          // Squid will reply with something like
          //   HTTP/1.1 200 Connection established\r\n\r\n
          // if it accepts the tunnel. We parse that reply in the 'data'
          // handler below.
          upstream.write(
            `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` +
              `Host: ${targetHost}:${targetPort}\r\n\r\n`
          )
        }
      )

      // State machine for the CONNECT-response handshake:
      //   `established` flips to true once we've parsed Squid's "200 OK".
      //   `buf` accumulates bytes from Squid in case the response arrives in
      //   multiple TCP chunks (TCP gives us zero guarantees about chunk size
      //   or boundaries, so we always have to be ready to reassemble).
      let established = false
      let buf = Buffer.alloc(0)

      upstream.on('data', (chunk) => {
        // After the handshake completes we hand control to `pipe()` below.
        // This listener is still attached for the lifetime of the socket but
        // we want it to be a no-op so it doesn't interfere with `pipe()`'s
        // own data forwarding.
        if (established) return

        // Append the new chunk to whatever bytes we've already collected,
        // then check whether we've seen the blank-line that marks the end of
        // the HTTP response headers ("\r\n\r\n").
        buf = Buffer.concat([buf, chunk])
        const idx = buf.indexOf('\r\n\r\n')
        if (idx === -1) return // headers not complete yet — wait for more

        // The first line of the response is the status line, e.g.
        // "HTTP/1.1 200 Connection established". We only accept a 200.
        const status = buf.slice(0, idx).toString().split('\r\n')[0]
        if (!/^HTTP\/1\.[01] 200/.test(status)) {
          // Squid said no — typically `403 Forbidden` because its ACL doesn't
          // allow CONNECT to this port, or a `407` if it requires proxy
          // authentication we haven't provided. This is a platform/config
          // problem, not a transient hiccup, so we log it loudly and tear
          // both sides of the would-be tunnel down.
          logger.error(
            { target, status },
            'Proxy refused CONNECT for OracleDB tunnel'
          )
          client.destroy()
          upstream.destroy()
          return
        }

        // Handshake succeeded — we are now in "tunnel established" mode.
        established = true

        // Squid is allowed to piggy-back real upstream bytes onto the same
        // TCP chunk as its "200 OK" header (unusual in practice, but legal).
        // Anything past the blank line is real tunnel data from Oracle, so
        // we forward those bytes down to the client immediately.
        const leftover = buf.slice(idx + 4)
        if (leftover.length) client.write(leftover)

        // Glue the two sockets together for the rest of their lifetime.
        // `a.pipe(b)` reads bytes from stream `a` and writes them to stream
        // `b`, AND propagates the end-of-stream signal. Doing it in BOTH
        // directions gives us a transparent bidirectional bridge — bytes the
        // Oracle client sends flow up to Squid, bytes Squid sends flow back
        // to the client, and we never have to look at any of them.
        upstream.pipe(client)
        client.pipe(upstream)
      })

      // Defensive error handlers. If either side of the pair breaks, we drop
      // the other so we don't leak half-open sockets. node-oracledb's pool
      // will see the broken connection and retry on its own schedule.
      client.on('error', () => upstream.destroy())
      upstream.on('error', (err) => {
        // The TCP link to Squid itself failed (proxy down, network blip,
        // etc.). Worth surfacing as a warning so it shows up in logs, but
        // not catastrophic — the pool will recover by reconnecting.
        logger.warn(
          { err: err.message, target },
          'OracleDB tunnel upstream error'
        )
        client.destroy()
      })
    })

    // Start the server listening. Two details worth knowing:
    //   - Port `0` is the magic "kernel, pick any free port for me" value;
    //     we read back the chosen port from `server.address().port` below.
    //     Avoids hard-coding ports and any chance of collision.
    //   - Binding to `127.0.0.1` (not `0.0.0.0`) means the forwarder is only
    //     reachable from inside this container/process. It is NOT exposed
    //     to any network — the only client ever is node-oracledb in-process.
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })

    const localPort = server.address().port

    // Record the mapping. Whatever calls us (src/oracledb.js) uses this map
    // to rewrite each pool's connect string from the real upstream to our
    // localhost forwarder, before passing it to oracledb.createPool().
    map[target] = `localhost:${localPort}`
    servers.push(server)

    logger.info(
      `Started OracleDB CONNECT-tunnel: localhost:${localPort} -> ${target} (via ${proxy.host}:${proxy.port})`
    )
  }

  return {
    map,
    // Graceful shutdown, called from closeOracleDb() during server stop.
    // `server.close()` stops the server from accepting new connections;
    // existing in-flight connections are left to finish on their own, which
    // is the standard polite-shutdown semantics for Node's net.Server.
    // We call it on every server and wait for them all in parallel.
    close: async () => {
      await Promise.all(
        servers.map(
          (s) => new Promise((resolve) => s.close(() => resolve(undefined)))
        )
      )
    }
  }
}
