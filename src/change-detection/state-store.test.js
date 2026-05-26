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
})
