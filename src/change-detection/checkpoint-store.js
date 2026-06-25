/**
 * Mongo-backed checkpoint repository.
 *
 * One document per source records the highest source_scn the detector has
 * processed. The watermark short-circuits unchanged rows on each sweep, but
 * is NOT the source of truth for correctness — that is the row-state store's
 * hash compare. The checkpoint is an optimization that lets us avoid
 * re-hashing every row on every sweep.
 */
export class CheckpointStore {
  constructor(db) {
    this.collection = db.collection('cqn_checkpoints')
  }

  async ensureIndexes() {
    await this.collection.createIndex({ source: 1 }, { unique: true })
  }

  async get(source) {
    const doc = await this.collection.findOne({ source })

    return doc?.lastScn ?? 0
  }

  async set(source, lastScn) {
    await this.collection.updateOne(
      { source },
      { $set: { source, lastScn, updatedAt: new Date() } },
      { upsert: true }
    )
  }
}
