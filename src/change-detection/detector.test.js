import { Detector } from '#/change-detection/detector.js'
import { hashPayload } from '#/change-detection/row-hash.js'

/**
 * Oracle-free unit tests for the detector. They pin the runSweep orchestration
 * wiring (fetch -> load prior -> classify -> emit/upsert -> detect deletions ->
 * advance checkpoint) and the single-flight/coalescing contract — the things
 * the Oracle-gated suites otherwise guard. The Oracle layer is faked: getPool
 * yields a controllable connection and refreshMv is a no-op; fetchChangedRows
 * is stubbed per test.
 */

const harness = vi.hoisted(() => ({
  order: [],
  closeCount: 0,
  executeImpl: async () => ({ rows: [] })
}))

vi.mock('#/oracledb.js', () => ({
  getPool: () => ({
    getConnection: async () => ({
      execute: async (...args) => {
        // fetchChangedRows is stubbed per test, so the only real execute call
        // is detectDeletions' live-id query.
        harness.order.push('liveIds')

        return harness.executeImpl(...args)
      },
      close: async () => {
        harness.closeCount += 1
      }
    })
  })
}))

vi.mock('#/change-detection/mv-refresh.js', () => ({
  refreshMv: async () => {
    harness.order.push('refresh')
  }
}))

// Mocked so start() can wire up the timer without touching Oracle (used by the
// "timer survives a sweep error" test).
vi.mock('#/change-detection/mv-setup.js', () => ({
  ensureMaterializedView: async () => ({ created: false })
}))

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

function makeSilentLogger() {
  const logger = {
    info() {},
    warn() {},
    error() {},
    debug() {},
    child() {
      return logger
    }
  }

  return logger
}

function makeCapturingLogger() {
  const debug = []
  const logger = {
    info() {},
    warn() {},
    error() {},
    debug: (...args) => debug.push(args),
    child() {
      return logger
    }
  }
  logger.debugCalls = debug

  return logger
}

const SOURCE_CONFIG = {
  pool: 'pega',
  mv: 'APHA_POC.X_MV',
  primaryKey: 'pyid',
  cqnQuery: null
}

function setup({
  checkpoint = 0,
  priorState = new Map(),
  changedRows = [],
  liveIds = [],
  logger = makeSilentLogger()
} = {}) {
  harness.order = []
  harness.closeCount = 0
  harness.executeImpl = async () => ({
    rows: liveIds.map((id) => ({ ID: id }))
  })

  const ops = [] // interleaved emit/upsert/delete order
  const upserts = []
  const setCalls = []
  const state = priorState // Map<id, doc>

  const checkpointStore = {
    get: vi.fn(async () => checkpoint),
    set: vi.fn(async (_source, scn) => {
      setCalls.push(scn)
    })
  }

  const stateStore = {
    get: vi.fn(async (_source, id) => state.get(id) ?? null),
    getMany: vi.fn(async (_source, ids) => {
      const byId = new Map()

      for (const id of ids) {
        const doc = state.get(id)

        if (doc) {
          byId.set(id, doc)
        }
      }

      return byId
    }),
    upsert: vi.fn(async (source, id, payloadHash, payload, sourceScn) => {
      ops.push({ op: 'upsert', id })
      upserts.push({ source, id, payloadHash, payload, sourceScn })
      state.set(id, { payloadHash, payload, sourceScn })
    }),
    listIds: vi.fn(async () => [...state.keys()]),
    delete: vi.fn(async (_source, id) => {
      ops.push({ op: 'delete', id })
      state.delete(id)
    })
  }

  const detector = new Detector({
    sourceName: 'workorders',
    sourceConfig: SOURCE_CONFIG,
    checkpointStore,
    stateStore,
    logger,
    intervalMs: 60_000,
    mvEnabled: true
  })

  detector.fetchChangedRows = vi.fn(async () => {
    harness.order.push('fetch')

    return { rows: changedRows, columns: [] }
  })

  const changes = []
  const errors = []
  detector.on('change', (e) => {
    ops.push({ op: 'emit', id: e.id, type: e.type })
    changes.push(e)
  })
  detector.on('error', (e) => errors.push(e))

  return {
    detector,
    checkpointStore,
    stateStore,
    changes,
    errors,
    ops,
    upserts,
    setCalls
  }
}

describe('#change-detection detector: runSweep orchestration', () => {
  test('a hash-equal row is upserted without an emit, and the checkpoint still advances', async () => {
    const payload = { pyid: 'A-1', col: 'x' }
    const priorState = new Map([
      ['A-1', { payloadHash: hashPayload(payload), payload, sourceScn: 50 }]
    ])

    const { detector, changes, upserts, setCalls } = setup({
      checkpoint: 100,
      priorState,
      changedRows: [{ pyid: 'A-1', col: 'x', source_scn: 200 }],
      liveIds: ['A-1']
    })

    await detector.runSweep('test')

    expect(changes).toHaveLength(0)
    expect(upserts).toHaveLength(1)
    expect(upserts[0]).toEqual({
      source: 'workorders',
      id: 'A-1',
      payloadHash: hashPayload(payload),
      payload: { pyid: 'A-1', col: 'x' },
      sourceScn: 200
    })
    // Highest scn belonged to a skip — the mark must still advance.
    expect(setCalls).toEqual([200])
  })

  test('insert + update emit then upsert, in row order, with correct payloads and args', async () => {
    const before = { pyid: 'B-1', col: 'old' }
    const priorState = new Map([
      ['B-1', { payloadHash: hashPayload(before), payload: before, sourceScn: 10 }]
    ])

    const { detector, changes, ops, upserts, setCalls } = setup({
      checkpoint: 50,
      priorState,
      changedRows: [
        { pyid: 'A-1', col: 'new', source_scn: 100 },
        { pyid: 'B-1', col: 'changed', source_scn: 110 }
      ],
      liveIds: ['A-1', 'B-1']
    })

    await detector.runSweep('test')

    expect(changes.map((e) => [e.type, e.id])).toEqual([
      ['insert', 'A-1'],
      ['update', 'B-1']
    ])

    expect(changes[0]).toMatchObject({
      type: 'insert',
      source: 'workorders',
      id: 'A-1',
      row: { pyid: 'A-1', col: 'new' }
    })
    // `before` must be present-and-undefined on an insert, not absent.
    expect('before' in changes[0]).toBe(true)
    expect(changes[0].before).toBeUndefined()
    // detectedAt is an ISO string, not a raw Date.
    expect(typeof changes[0].detectedAt).toBe('string')

    expect(changes[1]).toMatchObject({
      type: 'update',
      source: 'workorders',
      id: 'B-1',
      row: { pyid: 'B-1', col: 'changed' },
      before: { pyid: 'B-1', col: 'old' }
    })
    expect(typeof changes[1].detectedAt).toBe('string')

    // Emit-then-upsert, interleaved per row (the one-row failure window).
    expect(ops).toEqual([
      { op: 'emit', id: 'A-1', type: 'insert' },
      { op: 'upsert', id: 'A-1' },
      { op: 'emit', id: 'B-1', type: 'update' },
      { op: 'upsert', id: 'B-1' }
    ])

    expect(upserts[0]).toEqual({
      source: 'workorders',
      id: 'A-1',
      payloadHash: hashPayload({ pyid: 'A-1', col: 'new' }),
      payload: { pyid: 'A-1', col: 'new' },
      sourceScn: 100
    })
    expect(upserts[1]).toEqual({
      source: 'workorders',
      id: 'B-1',
      payloadHash: hashPayload({ pyid: 'B-1', col: 'changed' }),
      payload: { pyid: 'B-1', col: 'changed' },
      sourceScn: 110
    })

    expect(setCalls).toEqual([110])
  })

  test('an empty sweep emits nothing, upserts nothing, and does NOT touch the checkpoint', async () => {
    const { detector, changes, upserts, setCalls } = setup({
      checkpoint: 100,
      changedRows: [],
      liveIds: []
    })

    await detector.runSweep('test')

    expect(changes).toHaveLength(0)
    expect(upserts).toHaveLength(0)
    expect(setCalls).toEqual([]) // no advance -> no write -> no rewind
  })

  test('deletions run after the changed-row upserts, read fresh live ids, and emit-then-delete', async () => {
    const gone = { pyid: 'X-1', col: 'gone' }
    const priorState = new Map([
      ['X-1', { payloadHash: hashPayload(gone), payload: gone, sourceScn: 5 }]
    ])

    const { detector, changes, ops, stateStore } = setup({
      checkpoint: 50,
      priorState,
      changedRows: [{ pyid: 'A-1', col: 'new', source_scn: 100 }],
      liveIds: ['A-1'] // X-1 absent from the live MV -> delete
    })

    await detector.runSweep('test')

    // Fresh live-id read happens after refresh and the changed-row fetch.
    expect(harness.order).toEqual(['refresh', 'fetch', 'liveIds'])

    expect(changes.map((e) => [e.type, e.id])).toEqual([
      ['insert', 'A-1'],
      ['delete', 'X-1']
    ])

    const del = changes.find((e) => e.type === 'delete')
    expect(del.before).toEqual(gone)
    expect(del.row).toBeUndefined()

    // The delete phase runs after the changed-row upserts.
    const upsertIdx = ops.findIndex((o) => o.op === 'upsert' && o.id === 'A-1')
    const deleteEmitIdx = ops.findIndex((o) => o.op === 'emit' && o.id === 'X-1')
    expect(upsertIdx).toBeGreaterThanOrEqual(0)
    expect(upsertIdx).toBeLessThan(deleteEmitIdx)

    expect(stateStore.delete).toHaveBeenCalledWith('workorders', 'X-1')
  })

  test('the "Sweep complete" debug log reports examined / counts / checkpoint / columns', async () => {
    const logger = makeCapturingLogger()
    const before = { pyid: 'B-1', col: 'old' }
    const priorState = new Map([
      ['B-1', { payloadHash: hashPayload(before), payload: before, sourceScn: 10 }]
    ])

    const { detector } = setup({
      checkpoint: 50,
      priorState,
      changedRows: [
        { pyid: 'A-1', col: 'new', source_scn: 100 }, // insert
        { pyid: 'B-1', col: 'changed', source_scn: 110 } // update
      ],
      liveIds: ['A-1', 'B-1'],
      logger
    })

    await detector.runSweep('cqn')

    const entry = logger.debugCalls.find((a) => a[1] === 'Sweep complete')
    expect(entry).toBeDefined()
    expect(entry[0]).toMatchObject({
      reason: 'cqn',
      examined: 2,
      inserts: 1,
      updates: 1,
      deletes: 0,
      checkpoint: 110,
      columns: []
    })
  })

  test('the timer survives a sweep error — the detector keeps running', async () => {
    const { detector } = setup({ checkpoint: 0, changedRows: [], liveIds: [] })

    await detector.start()
    expect(detector.timer).toBeDefined()

    detector.fetchChangedRows = async () => {
      throw new Error('ORA-1: boom')
    }

    await detector.triggerSweep('test')

    // The sweep error must not tear the detector down.
    expect(detector.timer).toBeDefined()
    expect(detector.stopped).toBe(false)

    await detector.stop()
  })

  test('multiple deletions in one sweep emit in listIds order, each with its own before payload', async () => {
    const x = { pyid: 'X-1', col: 'x' }
    const y = { pyid: 'Y-1', col: 'y' }
    const priorState = new Map([
      ['X-1', { payloadHash: hashPayload(x), payload: x, sourceScn: 1 }],
      ['Y-1', { payloadHash: hashPayload(y), payload: y, sourceScn: 2 }]
    ])

    const { detector, changes, stateStore } = setup({
      checkpoint: 0,
      priorState,
      changedRows: [{ pyid: 'A-1', col: 'new', source_scn: 100 }],
      liveIds: ['A-1'] // X-1 and Y-1 both absent -> both deleted
    })

    await detector.runSweep('test')

    const deletes = changes.filter((e) => e.type === 'delete')
    expect(deletes.map((e) => e.id)).toEqual(['X-1', 'Y-1'])
    expect(deletes[0].before).toEqual(x)
    expect(deletes[1].before).toEqual(y)

    expect(stateStore.delete.mock.calls).toEqual([
      ['workorders', 'X-1'],
      ['workorders', 'Y-1']
    ])
  })

  test('a sweep failure surfaces an error event, closes the connection, and the next sweep succeeds', async () => {
    const { detector, errors, changes } = setup({
      checkpoint: 0,
      changedRows: [{ pyid: 'A-1', col: 'x', source_scn: 10 }],
      liveIds: ['A-1']
    })

    const stub = detector.fetchChangedRows
    let calls = 0
    detector.fetchChangedRows = vi.fn(async (...args) => {
      calls += 1

      if (calls === 1) {
        throw new Error('ORA-12345: simulated transient error')
      }

      return stub(...args)
    })

    // First sweep fails inside the try; runSweep catches, emits 'error', and
    // closes the connection in finally — it does not reject.
    await detector.triggerSweep('test')

    expect(errors).toHaveLength(1)
    expect(errors[0].message).toMatch(/ORA-12345/)
    expect(harness.closeCount).toBe(1)
    expect(detector.activeSweep).toBeNull()

    // Second sweep runs cleanly.
    await detector.triggerSweep('test')

    expect(changes.some((e) => e.id === 'A-1' && e.type === 'insert')).toBe(true)
    expect(detector.activeSweep).toBeNull()
    expect(harness.closeCount).toBe(2)
  })
})

describe('#change-detection detector: single-flight / coalescing', () => {
  function makeBareDetector({ mvEnabled = true } = {}) {
    return new Detector({
      sourceName: 'workorders',
      sourceConfig: SOURCE_CONFIG,
      checkpointStore: {},
      stateStore: {},
      logger: makeSilentLogger(),
      intervalMs: 60_000,
      mvEnabled
    })
  }

  test('triggerSweep routes through this.runSweep(reason) dynamically', async () => {
    const detector = makeBareDetector()
    const reasons = []
    detector.runSweep = vi.fn(async (reason) => {
      reasons.push(reason)
    })

    await detector.triggerSweep('cqn')

    expect(detector.runSweep).toHaveBeenCalledWith('cqn')
    expect(reasons).toEqual(['cqn'])
  })

  test('a thrown runSweep clears activeSweep and the next sweep still runs', async () => {
    const detector = makeBareDetector()
    let n = 0
    detector.runSweep = vi.fn(async () => {
      n += 1
      if (n === 1) {
        throw new Error('boom')
      }
    })

    await detector.triggerSweep('test')
    expect(detector.activeSweep).toBeNull()

    await detector.triggerSweep('test')
    expect(n).toBe(2)
    expect(detector.activeSweep).toBeNull()
  })

  test('concurrent triggers coalesce into exactly one follow-up sweep', async () => {
    const detector = makeBareDetector()
    const releasers = []
    let total = 0
    detector.runSweep = vi.fn(async () => {
      total += 1
      await new Promise((resolve) => releasers.push(resolve))
    })

    const p1 = detector.triggerSweep('a')
    const p2 = detector.triggerSweep('b')
    const p3 = detector.triggerSweep('c')

    await tick()
    // Only the first sweep is running; b and c are coalesced into one pending.
    expect(total).toBe(1)
    expect(releasers).toHaveLength(1)

    releasers[0]()
    await tick()
    // Exactly one follow-up runs — not one per trigger.
    expect(total).toBe(2)
    expect(releasers).toHaveLength(2)

    releasers[1]()
    await Promise.all([p1, p2, p3])

    expect(total).toBe(2)
    expect(detector.activeSweep).toBeNull()
  })

  test('the stopped guard short-circuits triggerSweep', async () => {
    const detector = makeBareDetector()
    detector.runSweep = vi.fn()
    detector.stopped = true

    await detector.triggerSweep('test')

    expect(detector.runSweep).not.toHaveBeenCalled()
  })

  test('the mvEnabled=false guard short-circuits triggerSweep', async () => {
    const detector = makeBareDetector({ mvEnabled: false })
    detector.runSweep = vi.fn()

    await detector.triggerSweep('test')

    expect(detector.runSweep).not.toHaveBeenCalled()
  })
})
