import { CheckpointStore } from '#/change-detection/checkpoint-store.js'
import { StateStore } from '#/change-detection/state-store.js'
import { Registry } from '#/change-detection/registry.js'

/**
 * Public API. The only thing application code ever imports.
 *
 *   await bootstrap({ db, logger })   // once, by the plugin
 *   const w = await watch('workorders')
 *   w.on('change', (event) => console.log(event))
 *   await w.stop()
 *
 * The registry (./registry.js) holds one Detector per source and multiplexes
 * events to every consumer; the watcher (./watcher.js) applies each consumer's
 * `filter` / `shape` and buffers startup events until the consumer's first
 * listener attaches.
 */
let registry

export async function bootstrap({ db, logger }) {
  if (registry) {
    throw new Error('change-detection bootstrap called twice')
  }

  const checkpointStore = new CheckpointStore(db)
  const stateStore = new StateStore(db)

  await checkpointStore.ensureIndexes()
  await stateStore.ensureIndexes()

  registry = new Registry({
    checkpointStore,
    stateStore,
    logger,
    entries: new Map()
  })
}

export async function watch(sourceName, options = {}) {
  if (!registry) {
    throw new Error(
      'change-detection not bootstrapped — call bootstrap() first'
    )
  }

  return registry.watch(sourceName, options)
}

export async function shutdown() {
  if (!registry) {
    return
  }

  await registry.shutdown()
  registry = undefined
}

/**
 * for testing: reach into the registry to drive a detector directly. Not part
 * of the public API. Returns undefined if the registry is not bootstrapped
 * or the source has no detector yet.
 */
export function _detectorForTesting(sourceName) {
  return registry?.entries.get(sourceName)?.detector
}
