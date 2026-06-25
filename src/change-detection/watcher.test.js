import { EventEmitter } from 'node:events'

import { createWatcher } from '#/change-detection/watcher.js'

/**
 * Unit tests for the consumer-facing watcher. These drive a fake
 * EventEmitter-shaped "detector" so the pre-attach buffer, filter/shape
 * application, error isolation, and stop() detaching are all exercised
 * without Oracle or Mongo — the integration suites that exercise the real
 * detector are Oracle-gated and do not run everywhere.
 */

function makeFakeDetector() {
  const detector = new EventEmitter()

  detector.logger = {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    child() {
      return this
    }
  }

  return detector
}

function makeEvent(overrides = {}) {
  return {
    type: 'insert',
    source: 'workorders',
    id: 'A-1',
    row: { pyid: 'A-1', pystatuswork: 'Open' },
    before: undefined,
    ...overrides
  }
}

// One macrotask flushes the queueMicrotask-scheduled buffer drain.
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('#change-detection watcher', () => {
  test('buffers an event emitted before any listener attaches, then drains on first attach', async () => {
    const detector = makeFakeDetector()
    const watcher = createWatcher(detector, 'workorders', {})

    const event = makeEvent()
    detector.emit('change', event)

    // Nothing should have been delivered yet — the consumer has not attached.
    const received = []
    watcher.on('change', (e) => received.push(e))

    expect(received).toHaveLength(0)

    await tick()

    expect(received).toEqual([event])
  })

  test('two listeners attached synchronously both receive buffered events exactly once', async () => {
    const detector = makeFakeDetector()
    const watcher = createWatcher(detector, 'workorders', {})

    const event = makeEvent()
    detector.emit('change', event)

    const a = []
    const b = []
    watcher.on('change', (e) => a.push(e))
    watcher.on('change', (e) => b.push(e))

    await tick()

    // Exact counts prove the second newListener's microtask was a no-op, not
    // a second drain.
    expect(a).toHaveLength(1)
    expect(b).toHaveLength(1)
    expect(a[0]).toBe(event)
    expect(b[0]).toBe(event)
  })

  test('after the buffer drains, further events pass through live', async () => {
    const detector = makeFakeDetector()
    const watcher = createWatcher(detector, 'workorders', {})

    const received = []
    watcher.on('change', (e) => received.push(e))
    await tick()

    const event = makeEvent({ id: 'A-2' })
    detector.emit('change', event)

    expect(received).toEqual([event])
  })

  test('filter true delivers; filter false suppresses', async () => {
    const detector = makeFakeDetector()
    const watcher = createWatcher(detector, 'workorders', {
      filter: (event) => event.row?.pystatuswork === 'Closed'
    })

    const received = []
    watcher.on('change', (e) => received.push(e))
    await tick()

    detector.emit('change', makeEvent({ id: 'open', row: { pystatuswork: 'Open' } }))
    detector.emit('change', makeEvent({ id: 'closed', row: { pystatuswork: 'Closed' } }))

    expect(received.map((e) => e.id)).toEqual(['closed'])
  })

  test('a throwing filter is swallowed, logged, and drops the event', async () => {
    const detector = makeFakeDetector()
    const watcher = createWatcher(detector, 'workorders', {
      filter: () => {
        throw new Error('filter boom')
      }
    })

    const received = []
    watcher.on('change', (e) => received.push(e))
    await tick()

    detector.emit('change', makeEvent())

    expect(received).toHaveLength(0)
    expect(detector.logger.error).toHaveBeenCalled()
  })

  test('shape transforms row and before', async () => {
    const detector = makeFakeDetector()
    const watcher = createWatcher(detector, 'workorders', {
      shape: (row) => ({ id: row.pyid, status: row.pystatuswork })
    })

    const received = []
    watcher.on('change', (e) => received.push(e))
    await tick()

    detector.emit(
      'change',
      makeEvent({
        type: 'update',
        row: { pyid: 'A-1', pystatuswork: 'Closed' },
        before: { pyid: 'A-1', pystatuswork: 'Open' }
      })
    )

    expect(received[0].row).toEqual({ id: 'A-1', status: 'Closed' })
    expect(received[0].before).toEqual({ id: 'A-1', status: 'Open' })
  })

  test('a throwing shape is swallowed, logged, and drops the event', async () => {
    const detector = makeFakeDetector()
    const watcher = createWatcher(detector, 'workorders', {
      shape: () => {
        throw new Error('shape boom')
      }
    })

    const received = []
    watcher.on('change', (e) => received.push(e))
    await tick()

    detector.emit('change', makeEvent())

    expect(received).toHaveLength(0)
    expect(detector.logger.error).toHaveBeenCalled()
  })

  test('a shape returning undefined does NOT drop the event (row becomes undefined)', async () => {
    const detector = makeFakeDetector()
    const watcher = createWatcher(detector, 'workorders', {
      shape: () => undefined
    })

    const received = []
    watcher.on('change', (e) => received.push(e))
    await tick()

    detector.emit('change', makeEvent())

    // applyShape returns the spread object (truthy); only a thrown shape drops.
    expect(received).toHaveLength(1)
    expect(received[0].type).toBe('insert')
    expect(received[0].id).toBe('A-1')
    expect(received[0].row).toBeUndefined()
  })

  test('error events are buffered then drained too', async () => {
    const detector = makeFakeDetector()
    const watcher = createWatcher(detector, 'workorders', {})

    const err = new Error('sweep failed')
    detector.emit('error', err)

    const received = []
    watcher.on('error', (e) => received.push(e))

    await tick()

    expect(received).toEqual([err])
  })

  test('stop() detaches from the detector and removes consumer listeners', async () => {
    const detector = makeFakeDetector()
    const watcher = createWatcher(detector, 'workorders', {})

    const received = []
    watcher.on('change', (e) => received.push(e))
    await tick()

    await watcher.stop()

    detector.emit('change', makeEvent())
    await tick()

    expect(received).toHaveLength(0)
    expect(detector.listenerCount('change')).toBe(0)
    expect(detector.listenerCount('error')).toBe(0)
    expect(watcher.listenerCount('change')).toBe(0)
  })

  test('exposes the source name it bound to', () => {
    const detector = makeFakeDetector()
    const watcher = createWatcher(detector, 'workorders', {})

    expect(watcher.source).toBe('workorders')
  })
})
