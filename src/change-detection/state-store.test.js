import { MongoClient } from 'mongodb'

import { StateStore } from '#/change-detection/state-store.js'

describe('#stateStore', () => {
  let client
  let db
  let store

  beforeAll(async () => {
    client = await MongoClient.connect(globalThis.__MONGO_URI__)
    db = client.db('state-store-test')
    store = new StateStore(db)
    await store.ensureIndexes()
  })

  afterAll(async () => {
    await client.close()
  })

  beforeEach(async () => {
    await db.collection('cqn_row_state').deleteMany({})
  })

  test('returns null when row state does not exist', async () => {
    expect(await store.get('workorders', 'WS-1')).toBeNull()
  })

  test('upserts and reads back the row state', async () => {
    await store.upsert(
      'workorders',
      'WS-1',
      'hash-1',
      { pyid: 'WS-1', status: 'Open' },
      1000
    )

    const got = await store.get('workorders', 'WS-1')

    expect(got).toMatchObject({
      source: 'workorders',
      id: 'WS-1',
      payloadHash: 'hash-1',
      payload: { pyid: 'WS-1', status: 'Open' },
      sourceScn: 1000
    })
  })

  test('overwrites on second upsert', async () => {
    await store.upsert(
      'workorders',
      'WS-1',
      'hash-1',
      { pyid: 'WS-1', status: 'Open' },
      1
    )

    await store.upsert(
      'workorders',
      'WS-1',
      'hash-2',
      { pyid: 'WS-1', status: 'Closed' },
      2
    )

    const got = await store.get('workorders', 'WS-1')

    expect(got.payloadHash).toBe('hash-2')
    expect(got.payload.status).toBe('Closed')
    expect(got.sourceScn).toBe(2)
  })

  test('listIds returns all ids for the source', async () => {
    await store.upsert('workorders', 'WS-1', 'h', {}, 1)
    await store.upsert('workorders', 'WS-2', 'h', {}, 1)
    await store.upsert('customers', 'C-1', 'h', {}, 1)

    const ids = await store.listIds('workorders')

    expect(ids.sort()).toEqual(['WS-1', 'WS-2'])
  })

  test('delete removes a single id', async () => {
    await store.upsert('workorders', 'WS-1', 'h', {}, 1)
    await store.upsert('workorders', 'WS-2', 'h', {}, 1)

    await store.delete('workorders', 'WS-1')

    expect(await store.get('workorders', 'WS-1')).toBeNull()
    expect(await store.get('workorders', 'WS-2')).not.toBeNull()
  })

  test('getMany returns an empty Map for no ids and issues no query', async () => {
    const findSpy = vi.spyOn(store.collection, 'find')

    const result = await store.getMany('workorders', [])

    expect(result).toBeInstanceOf(Map)
    expect(result.size).toBe(0)
    expect(findSpy).not.toHaveBeenCalled()

    findSpy.mockRestore()
  })

  test('getMany collapses duplicate ids to a single Map entry', async () => {
    await store.upsert('workorders', 'WS-1', 'h', {}, 1)

    const result = await store.getMany('workorders', ['WS-1', 'WS-1'])

    expect(result.size).toBe(1)
  })

  test('getMany returns a Map keyed by id with the full document shape', async () => {
    await store.upsert(
      'workorders',
      'WS-1',
      'h1',
      { pyid: 'WS-1', s: 'Open' },
      10
    )
    await store.upsert(
      'workorders',
      'WS-2',
      'h2',
      { pyid: 'WS-2', s: 'Closed' },
      20
    )

    const result = await store.getMany('workorders', ['WS-1', 'WS-2'])

    expect(result.size).toBe(2)
    expect(result.get('WS-1')).toMatchObject({
      source: 'workorders',
      id: 'WS-1',
      payloadHash: 'h1',
      payload: { pyid: 'WS-1', s: 'Open' },
      sourceScn: 10
    })
    expect(result.get('WS-2')).toMatchObject({
      payloadHash: 'h2',
      sourceScn: 20
    })
  })

  test('getMany omits absent ids and ignores other sources', async () => {
    await store.upsert('workorders', 'WS-1', 'h', {}, 1)
    await store.upsert('customers', 'C-1', 'h', {}, 1)

    const result = await store.getMany('workorders', [
      'WS-1',
      'WS-missing',
      'C-1'
    ])

    expect([...result.keys()]).toEqual(['WS-1'])
  })

  test('getMany reads across chunk boundaries with no missed or duplicate ids', async () => {
    const ids = Array.from({ length: 1001 }, (_, i) => `WS-${i}`)

    await db.collection('cqn_row_state').insertMany(
      ids.map((id) => ({
        source: 'workorders',
        id,
        payloadHash: 'h',
        payload: {},
        sourceScn: 1
      }))
    )

    const result = await store.getMany('workorders', ids)

    expect(result.size).toBe(1001)
    expect(result.get('WS-0')).toBeDefined()
    expect(result.get('WS-1000')).toBeDefined()
  })

  test('getMany returns a fresh Map not aliased to store state', async () => {
    await store.upsert('workorders', 'WS-1', 'h', {}, 1)

    const a = await store.getMany('workorders', ['WS-1'])
    const b = await store.getMany('workorders', ['WS-1'])

    expect(a).not.toBe(b)

    a.delete('WS-1')

    expect((await store.getMany('workorders', ['WS-1'])).size).toBe(1)
  })
})
