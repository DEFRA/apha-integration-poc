import {
  hashPayload,
  lowercaseKeys,
  stripInternalColumns
} from '#/change-detection/row-hash.js'

/**
 * Golden-digest tests lock the CURRENT hash output so any accidental change to
 * the algorithm (different sort, different normalisation) breaks loudly —
 * silently changing it would re-emit `update` events for every tracked row on
 * the next sweep.
 */
describe('#change-detection row-hash: hashPayload', () => {
  test('golden digests for the supported value kinds', () => {
    expect(hashPayload({ a: 1, b: 'two' })).toBe(
      'f15bfc93d70801047473922f67fed863ecc7f82f0677ebb7122923aee81e0f97'
    )
    expect(hashPayload({ when: new Date('2020-06-15T12:00:00.000Z') })).toBe(
      'c24968ae2f03ac2c2ff49588ad61e3ba2884afeac468df02b03173f7e9c79b71'
    )
    expect(hashPayload({ n: 9007199254740993n })).toBe(
      '3bbb752b000e9ac58b939c07bb99307d18ccc5be92189d3c32738ec24c98579f'
    )
    expect(hashPayload({ blob: Buffer.from('hello') })).toBe(
      '150282bb4a4882348d6abe837744798e7bb658b03a03cfb482ca83bd4656a04b'
    )
    expect(hashPayload({ outer: { z: 1, a: 2 } })).toBe(
      '15bbc6e989517bd036633bda995ca2ed1b343ae7ca814f2fd1d350a04a9713ce'
    )
  })

  test('is stable across top-level key order', () => {
    expect(hashPayload({ a: 1, b: 2 })).toBe(hashPayload({ b: 2, a: 1 }))
  })

  test('an undefined-valued key hashes the same as the key being absent', () => {
    expect(hashPayload({ a: 1, b: undefined })).toBe(hashPayload({ a: 1 }))
  })

  test('nested object key order DOES change the hash (only top level is sorted)', () => {
    expect(hashPayload({ outer: { z: 1, a: 2 } })).not.toBe(
      hashPayload({ outer: { a: 2, z: 1 } })
    )
  })

  test('Date is normalised to its ISO string', () => {
    expect(hashPayload({ when: new Date('2020-06-15T12:00:00.000Z') })).toBe(
      hashPayload({ when: '2020-06-15T12:00:00.000Z' })
    )
  })

  test('bigint is normalised to its decimal string', () => {
    expect(hashPayload({ n: 42n })).toBe(hashPayload({ n: '42' }))
  })

  test('Buffer hashes stably via its toJSON representation', () => {
    // Quirk worth pinning: JSON.stringify calls a value's toJSON() BEFORE the
    // replacer, so a Buffer is serialised as { type: 'Buffer', data: [...] }
    // and the Buffer.isBuffer→base64 branch never actually fires. The hash is
    // still deterministic; this locks the real representation so a "fix" to
    // base64 (which would re-hash every Buffer column) breaks loudly.
    const buf = Buffer.from('hello')

    expect(hashPayload({ blob: buf })).toBe(
      hashPayload({ blob: { type: 'Buffer', data: [...buf] } })
    )
    expect(hashPayload({ blob: buf })).not.toBe(
      hashPayload({ blob: buf.toString('base64') })
    )
  })
})

describe('#change-detection row-hash: lowercaseKeys', () => {
  test('lowercases every key, preserving values', () => {
    expect(lowercaseKeys({ PYID: 'A-1', PyStatusWork: 'Open' })).toEqual({
      pyid: 'A-1',
      pystatuswork: 'Open'
    })
  })

  test('returns a new object', () => {
    const input = { A: 1 }

    expect(lowercaseKeys(input)).not.toBe(input)
  })
})

describe('#change-detection row-hash: stripInternalColumns', () => {
  test('removes source_scn and leaves everything else', () => {
    expect(
      stripInternalColumns({ pyid: 'A-1', pystatuswork: 'Open', source_scn: 123 })
    ).toEqual({ pyid: 'A-1', pystatuswork: 'Open' })
  })

  test('returns a copy — the input is not mutated', () => {
    const input = { pyid: 'A-1', source_scn: 123 }
    const result = stripInternalColumns(input)

    expect(result).not.toBe(input)
    expect(input.source_scn).toBe(123)
  })
})
