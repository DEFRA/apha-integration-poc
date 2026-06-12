import { config } from '#/config.js'
import { bootstrap, watch, shutdown } from '#/change-detection/index.js'

/**
 * Wires the change-detection subsystem into the Hapi lifecycle. The plugin
 * is intentionally thin — it bootstraps the registry, attaches a console.log
 * handler to every configured source (prototype consumer), and tears down on
 * server stop. Real consumers would call `watch()` from their own code and
 * own their handlers.
 */
export const changeDetection = {
  plugin: {
    name: 'change-detection',
    version: '1.0.0',
    register: async function (server) {
      if (!config.get('changeDetection.enabled')) {
        return
      }

      await bootstrap({ db: server.db, logger: server.logger })

      const sources = config.get('changeDetection.sources') ?? {}

      const watchers = []

      for (const sourceName of Object.keys(sources)) {
        try {
          const watcher = await watch(sourceName)

          watcher.on('change', (event) => {
            // Prototype consumer — replace with real handler when one exists.
            console.log(`[change-detection] ${sourceName}`, event)
          })

          watcher.on('error', (err) => {
            server.logger.error(
              { err, source: sourceName },
              'Change-detection error'
            )
          })

          watchers.push(watcher)

          server.logger.info(
            { source: sourceName },
            'Change-detection source watching'
          )
        } catch (err) {
          // First line of the error carries the Oracle code (ORA-/NJS-/DPI-)
          // — inline it so the message is diagnostic on its own in log
          // viewers that only list the message column.
          const summary = String(err?.message ?? err).split('\n')[0]

          server.logger.error(
            { err, source: sourceName },
            `Failed to start change-detection source "${sourceName}": ${summary}`
          )
        }
      }

      server.events.on('stop', async () => {
        server.logger.info('Stopping change-detection')

        for (const watcher of watchers) {
          await watcher.stop().catch(() => {})
        }

        await shutdown()
      })
    }
  }
}
