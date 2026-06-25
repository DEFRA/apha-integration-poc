import { planChanges } from '#/change-detection/classify.js'
import { hashPayload } from '#/change-detection/row-hash.js'

/**
 * The classifier is the correctness kernel of the sweep; these tests pin the
 * invariants the Oracle-gated integration suites otherwise guard: insert vs
 * real update vs hash-equal skip, that every examined row is returned for
 * persistence, that maxScn covers skips too, and the priorState key contract.
 */

const row = (overrides = {}) => ({
  pyid: 'A-1',
  pystatuswork: 'Open',
  source_scn: 100,
  ...overrides
})

const priorFor = (payload, extra = {}) => ({
  payloadHash: hashPayload(payload),
  payload,
  sourceScn: 1,
  ...extra
})

describe('#change-detection classify: planChanges', () => {
  test('a row with no prior state is an insert (before undefined), and is persisted', () => {
    const { entries } = planChanges({
      rows: [row()],
      primaryKey: 'pyid',
      priorState: new Map()
    })

    expect(entries).toHaveLength(1)

    const [entry] = entries

    expect(entry.id).toBe('A-1')
    expect(entry.sourceScn).toBe(100)
    expect(entry.payload).toEqual({ pyid: 'A-1', pystatuswork: 'Open' })
    expect(entry.payloadHash).toBe(hashPayload(entry.payload))
    expect(entry.event).toEqual({
      type: 'insert',
      id: 'A-1',
      row: { pyid: 'A-1', pystatuswork: 'Open' },
      before: undefined
    })
  })

  test('a row whose hash differs from prior is an update carrying the prior payload as before', () => {
    const before = { pyid: 'A-1', pystatuswork: 'Open' }

    const { entries } = planChanges({
      rows: [row({ pystatuswork: 'Closed' })],
      primaryKey: 'pyid',
      priorState: new Map([['A-1', priorFor(before)]])
    })

    const [entry] = entries

    expect(entry.event).toEqual({
      type: 'update',
      id: 'A-1',
      row: { pyid: 'A-1', pystatuswork: 'Closed' },
      before
    })
  })

  test('a row whose hash equals prior emits NO event but is still persisted', () => {
    const payload = { pyid: 'A-1', pystatuswork: 'Open' }

    const { entries } = planChanges({
      rows: [row({ source_scn: 200 })],
      primaryKey: 'pyid',
      priorState: new Map([['A-1', priorFor(payload)]])
    })

    expect(entries).toHaveLength(1)

    const [entry] = entries

    expect(entry.event).toBeUndefined()
    // still persisted with the fresh scn so the watermark advances
    expect(entry.sourceScn).toBe(200)
    expect(entry.payloadHash).toBe(hashPayload(payload))
  })

  test('maxScn covers hash-equal skip rows (the highest scn may belong to a skip)', () => {
    const payload = { pyid: 'B-1', pystatuswork: 'Open' }

    const { maxScn, entries } = planChanges({
      rows: [
        row({ pyid: 'A-1', source_scn: 100 }), // insert
        row({ pyid: 'B-1', source_scn: 300, pystatuswork: 'Open' }) // skip, highest scn
      ],
      primaryKey: 'pyid',
      priorState: new Map([['B-1', priorFor(payload)]])
    })

    expect(entries[0].event?.type).toBe('insert')
    expect(entries[1].event).toBeUndefined()
    // Highest scn belongs to the skipped row — it must still advance the mark,
    // otherwise that row re-surfaces on every sweep forever.
    expect(maxScn).toBe(300)
  })

  test('entries and events preserve input order', () => {
    const { entries } = planChanges({
      rows: [
        row({ pyid: 'A-1', source_scn: 10 }),
        row({ pyid: 'B-1', source_scn: 20 }),
        row({ pyid: 'C-1', source_scn: 30 })
      ],
      primaryKey: 'pyid',
      priorState: new Map()
    })

    expect(entries.map((e) => e.id)).toEqual(['A-1', 'B-1', 'C-1'])
    expect(entries.map((e) => e.event.type)).toEqual([
      'insert',
      'insert',
      'insert'
    ])
  })

  test('maxScn is null for an empty row set', () => {
    const { entries, maxScn } = planChanges({
      rows: [],
      primaryKey: 'pyid',
      priorState: new Map()
    })

    expect(entries).toEqual([])
    expect(maxScn).toBeNull()
  })

  test('priorState key-type mismatch misses and reclassifies a real update as insert', () => {
    // Row id is the number 1; prior is keyed by the string '1'. Map.get(1) !==
    // get('1'), so the lookup misses and the row looks brand new. Pins the
    // contract that keys must match exactly (a coercion regression flips this).
    const numericRow = { pyid: 1, pystatuswork: 'Closed', source_scn: 100 }

    const { entries } = planChanges({
      rows: [numericRow],
      primaryKey: 'pyid',
      priorState: new Map([['1', priorFor({ pyid: 1, pystatuswork: 'Open' })]])
    })

    expect(entries[0].event.type).toBe('insert')
  })

  test('classification is driven only by the hash — a matching hash skips even if the prior payload object differs', () => {
    const current = { pyid: 'A-1', pystatuswork: 'Open' }

    const { entries } = planChanges({
      rows: [row()],
      primaryKey: 'pyid',
      // Same hash as the current payload, but a different stored payload object.
      priorState: new Map([
        ['A-1', { payloadHash: hashPayload(current), payload: { stale: true } }]
      ])
    })

    expect(entries[0].event).toBeUndefined()
  })

  test('an all-skip batch emits nothing but still reports maxScn (the all-no-op checkpoint case)', () => {
    const a = { pyid: 'A-1', pystatuswork: 'Open' }
    const b = { pyid: 'B-1', pystatuswork: 'Open' }

    const { entries, maxScn } = planChanges({
      rows: [
        row({ pyid: 'A-1', source_scn: 120 }),
        row({ pyid: 'B-1', source_scn: 90 })
      ],
      primaryKey: 'pyid',
      priorState: new Map([
        ['A-1', priorFor(a)],
        ['B-1', priorFor(b)]
      ])
    })

    expect(entries.every((e) => e.event === undefined)).toBe(true)
    expect(maxScn).toBe(120)
  })

  test('source_scn arriving as a numeric string is coerced and used', () => {
    const { entries, maxScn } = planChanges({
      rows: [row({ source_scn: '300' })],
      primaryKey: 'pyid',
      priorState: new Map()
    })

    expect(entries[0].sourceScn).toBe(300)
    expect(maxScn).toBe(300)
  })

  test('a later row with a lower scn does not lower maxScn', () => {
    const { maxScn } = planChanges({
      rows: [
        row({ pyid: 'A-1', source_scn: 300 }),
        row({ pyid: 'B-1', source_scn: 100 })
      ],
      primaryKey: 'pyid',
      priorState: new Map()
    })

    expect(maxScn).toBe(300)
  })

  test('a non-numeric source_scn (NaN) does not poison maxScn for later valid rows', () => {
    const { entries, maxScn } = planChanges({
      rows: [
        row({ pyid: 'A-1', source_scn: undefined }),
        row({ pyid: 'B-1', source_scn: 200 })
      ],
      primaryKey: 'pyid',
      priorState: new Map()
    })

    expect(Number.isNaN(entries[0].sourceScn)).toBe(true)
    expect(maxScn).toBe(200)
  })
})
