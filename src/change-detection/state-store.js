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
