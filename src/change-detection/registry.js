import { config } from '#/config.js'
import { Detector } from '#/change-detection/detector.js'
import { createWatcher } from '#/change-detection/watcher.js'

/**
 * Holds one Detector per source and multiplexes its events to every consumer
 * that asked for that source — so a hundred consumers do not mean a hundred
 * sweeps. Consumer-supplied `filter` / `shape` options are applied per-consumer
 * by the watcher, downstream of the shared detector.
 *
 * Sweep cadence is a *source*-level concern, configured under
 * `changeDetection.defaultIntervalMs` (or a per-source override). Consumers
 * cannot tune it from `watch()` — a tuning knob that's silently ignored for
 * everyone after the first caller is worse than not having one at all.
 */
export class Registry {
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
