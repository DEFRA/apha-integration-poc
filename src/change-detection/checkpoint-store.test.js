import { MongoClient } from 'mongodb'

import { CheckpointStore } from '#/change-detection/checkpoint-store.js'

describe('#checkpointStore', () => {
  let client
  let db
  let store

  beforeAll(async () => {
    client = await MongoClient.connect(globalThis.__MONGO_URI__)
    db = client.db('checkpoint-store-test')
    store = new CheckpointStore(db)
    await store.ensureIndexes()
  })

  afterAll(async () => {
    await client.close()
  })

  beforeEach(async () => {
    await db.collection('cqn_checkpoints').deleteMany({})
  })

  test('returns 0 when no checkpoint exists', async () => {
    expect(await store.get('workorders')).toBe(0)
  })

  test('persists and reads back the SCN', async () => {
    await store.set('workorders', 12345)

    expect(await store.get('workorders')).toBe(12345)
  })

  test('upserts on subsequent writes', async () => {
    await store.set('workorders', 1)
    await store.set('workorders', 99)

    expect(await store.get('workorders')).toBe(99)

    const count = await db.collection('cqn_checkpoints').countDocuments({
      source: 'workorders'
    })

    expect(count).toBe(1)
  })

  test('separates checkpoints by source', async () => {
    await store.set('workorders', 10)
    await store.set('customers', 20)

    expect(await store.get('workorders')).toBe(10)
    expect(await store.get('customers')).toBe(20)
  })
})
