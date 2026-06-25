/**
 * Mongo-backed row-state repository.
 *
 * One document per (source, id) holds the last-known row payload and its
 * hash. This is what makes change detection correct in the face of:
 *   - COMPLETE-refresh false positives (whole MV rewritten each sweep);
 *   - block-level ORA_ROWSCN false positives (any change in a block bumps SCN);
 *   - startup catch-up (compare current MV state vs what we last saw);
 *   - delete detection (rows known to us but absent from the MV).
 *
 * Storing the full payload (not just the hash) is what lets us emit a
 * `before` field on update/delete events — without it, consumers would only
 * ever see the new state.
 */
export class StateStore {
  constructor(db) {
    this.collection = db.collection('cqn_row_state')
  }

  async ensureIndexes() {
    await this.collection.createIndex(
      { source: 1, id: 1 },
      { unique: true, name: 'source_id_unique' }
    )

    await this.collection.createIndex({ source: 1 }, { name: 'source_idx' })
  }

  async get(source, id) {
    return this.collection.findOne({ source, id })
  }

  /**
   * Batched read of many ids in one (chunked) query, returned as a fresh
   * Map<id, doc>. Ids absent from the store are simply absent from the Map.
   * Chunked so a bulk startup sweep can't blow past MongoDB's 16 MB command
   * limit on the `$in` list.
   */
  async getMany(source, ids) {
    const byId = new Map()

    if (ids.length === 0) {
      return byId
    }

    const CHUNK = 1000

    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK)

      const docs = await this.collection
        .find({ source, id: { $in: chunk } })
        .toArray()

      for (const doc of docs) {
        byId.set(doc.id, doc)
      }
    }

    return byId
  }

  async upsert(source, id, payloadHash, payload, sourceScn) {
    await this.collection.updateOne(
      { source, id },
      {
        $set: {
          source,
          id,
          payloadHash,
          payload,
          sourceScn,
          updatedAt: new Date()
        }
      },
      { upsert: true }
    )
  }

  async delete(source, id) {
    await this.collection.deleteOne({ source, id })
  }

  async listIds(source) {
    const cursor = this.collection.find(
      { source },
      { projection: { id: 1, _id: 0 } }
    )

    const docs = await cursor.toArray()

    return docs.map((doc) => doc.id)
  }
}
