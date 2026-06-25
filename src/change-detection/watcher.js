import { EventEmitter } from 'node:events'

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
export function createWatcher(detector, sourceName, options) {
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
