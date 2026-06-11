import { EventEmitter } from 'node:events'

import { config } from '#/config.js'
import { CheckpointStore } from '#/change-detection/checkpoint-store.js'
import { StateStore } from '#/change-detection/state-store.js'
import { Detector } from '#/change-detection/detector.js'

/**
 * Public API. The only thing application code ever imports.
 *
 *   await bootstrap({ db, logger })   // once, by the plugin
 *   const w = await watch('workorders')
 *   w.on('change', (event) => console.log(event))
 *   await w.stop()
 *
 * The registry holds one Detector per source and multiplexes events to
 * every consumer that asked for that source — so a hundred consumers do not
 * mean a hundred sweeps. Consumer-supplied `filter` / `shape` options are
 * applied per-consumer, downstream of the shared detector.
 *
 * Sweep cadence is a *source*-level concern, configured under
 * `changeDetection.defaultIntervalMs` (or a per-source override). Consumers
 * cannot tune it from `watch()` — a tuning knob that's silently ignored for
 * everyone after the first caller is worse than not having one at all.
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

class Registry {
  constructor({ checkpointStore, stateStore, logger, entries }) {
    this.checkpointStore = checkpointStore
    this.stateStore = stateStore
    this.logger = logger
    this.entries = entries
  }

  async watch(sourceName, options) {
    const sourceConfig = readSourceConfig(sourceName)

    // First synchronous phase: claim or find the entry. Because everything
    // up to the first `await` runs atomically in Node, two concurrent
    // watch() calls cannot both pass the "no entry" check.
    let entry = this.entries.get(sourceName)

    let isFirstCaller = false

    if (!entry) {
      const detector = new Detector({
        sourceName,
        sourceConfig,
        checkpointStore: this.checkpointStore,
        stateStore: this.stateStore,
        logger: this.logger,
        intervalMs: config.get('changeDetection.defaultIntervalMs'),
        mvEnabled: config.get('changeDetection.mvEnabled')
      })

      entry = { detector, readyPromise: null }

      this.entries.set(sourceName, entry)

      isFirstCaller = true
    }

    // Attach this consumer's listener BEFORE the startup sweep can fire.
    // For the first caller, this is critical: start() schedules the timer
    // but does not sweep; the startup sweep runs only after every "first
    // wave" listener has attached.
    const watcher = createWatcher(entry.detector, sourceName, options)

    if (isFirstCaller) {
      entry.readyPromise = (async () => {
        await entry.detector.start()

        await entry.detector.triggerStartupSweep()
      })()
    }

    // Subsequent callers await the same promise — resolved immediately if
    // start-up has already completed. Errors during start propagate to all
    // callers in this wave, which is the right behaviour: if the detector
    // can't start, no consumer should think it's running.
    await entry.readyPromise

    return watcher
  }

  async shutdown() {
    const entries = [...this.entries.values()]

    this.entries.clear()

    await Promise.all(entries.map((e) => e.detector.stop()))
  }
}

/**
 * A consumer-facing watcher: an EventEmitter-shaped object that:
 *   - applies the consumer's `filter` and `shape` to each event;
 *   - forwards events to the consumer's handlers;
 *   - buffers events emitted before the consumer's first listener attaches,
 *     and drains them on first attach so startup catch-up events are never
 *     missed by the natural `const w = await watch(...); w.on(...)` pattern;
 *   - leaves the underlying detector untouched when the consumer stops
 *     (other consumers may still be subscribed). The detector itself only
 *     stops when the registry shuts down.
 */
function createWatcher(detector, sourceName, options) {
  const out = new EventEmitter()

  const filter = options.filter

  const shape = options.shape

  // Pre-attach buffer. While `buffer` is non-null, events go here instead of
  // being emitted, because no consumer listener can have been attached yet
  // (watch() hasn't returned). The first 'newListener' event from the
  // consumer flips the switch, drains, and from then on it's pass-through.
  let buffer = []

  const safeEmitOut = (eventName, payload) => {
    try {
      out.emit(eventName, payload)
    } catch (err) {
      detector.logger.error(
        { err, source: sourceName, event: eventName },
        'Consumer handler threw'
      )
    }
  }

  const deliver = (eventName, payload) => {
    if (buffer !== null) {
      buffer.push([eventName, payload])

      return
    }

    safeEmitOut(eventName, payload)
  }

  // Drain on the first consumer-attached listener for any real event. Use
  // 'newListener' (fires before the listener is added) plus a microtask so
  // the listener is fully registered before we replay events to it, and so
  // consumers can attach multiple handlers synchronously and all of them
  // see the buffered events.
  out.on('newListener', (eventName) => {
    if (eventName === 'newListener' || eventName === 'removeListener') {
      return
    }

    if (buffer === null) {
      return
    }

    queueMicrotask(() => {
      if (buffer === null) {
        return
      }

      const queued = buffer

      buffer = null

      for (const [name, payload] of queued) {
        safeEmitOut(name, payload)
      }
    })
  })

  const onChange = (event) => {
    if (filter && !safeBool(filter, event, detector.logger)) {
      return
    }

    const shaped = shape ? applyShape(event, shape, detector.logger) : event

    if (!shaped) {
      return
    }

    deliver(shaped.type, shaped)
    deliver('change', shaped)
  }

  const onError = (err) => {
    deliver('error', err)
  }

  detector.on('change', onChange)
  detector.on('error', onError)

  out.stop = async () => {
    detector.off('change', onChange)
    detector.off('error', onError)
    out.removeAllListeners()
  }

  // Surface the source name so consumers can introspect what they bound to.
  out.source = sourceName

  return out
}

function readSourceConfig(sourceName) {
  const allSources = config.get('changeDetection.sources')

  const sourceConfig = allSources?.[sourceName]

  if (!sourceConfig) {
    throw new Error(
      `Unknown change-detection source "${sourceName}". Known sources: ${Object.keys(allSources ?? {}).join(', ') || '(none)'}`
    )
  }

  return sourceConfig
}

function safeBool(fn, event, logger) {
  try {
    return Boolean(fn(event))
  } catch (err) {
    logger.error(
      { err, source: event.source },
      'filter() threw — skipping event'
    )

    return false
  }
}

function applyShape(event, fn, logger) {
  try {
    const reshaped = { ...event }

    if (event.row !== undefined) {
      reshaped.row = fn(event.row)
    }

    if (event.before !== undefined) {
      reshaped.before = fn(event.before)
    }

    return reshaped
  } catch (err) {
    logger.error(
      { err, source: event.source },
      'shape() threw — skipping event'
    )

    return undefined
  }
}
