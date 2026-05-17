import crypto from 'node:crypto'
import stringify from 'fast-json-stable-stringify'
import { getTableConfig } from './table-config.js'

const createLogger = () => ({
  info: (...args) => console.log('[INFO]', ...args),
  warn: (...args) => console.warn('[WARN]', ...args),
  error: (...args) => console.error('[ERROR]', ...args)
})

export class ChangeDetector {
  constructor(oraclePool, mongodb, eventBus, payloadCalculator) {
    this.oraclePool = oraclePool
    this.mongodb = mongodb
    this.eventBus = eventBus
    this.payloadCalculator = payloadCalculator
    this.logger = createLogger()
  }

  async pollForChanges(tableName) {
    const startTime = Date.now()
    const lastPollTime = await this.getLastPollTime(tableName)

    this.logger.info(`Polling ${tableName} since ${lastPollTime.toISOString()}`)

    const changedEntities = await this.getChangedEntities(tableName, lastPollTime)
    this.logger.info(`Found ${changedEntities.length} changed ${tableName} rows`)

    let eventsEmitted = 0
    let unchangedCount = 0

    for (const entity of changedEntities) {
      const entityId = this.getEntityId(tableName, entity)
      const currentHash = this.hashPayload(entity)
      const previousHash = await this.getPreviousHash(tableName, entityId)

      if (currentHash !== previousHash) {
        await this.publishEvent({
          type: previousHash ? 'UPDATE' : 'CREATE',
          entityType: tableName.toLowerCase(),
          entityId,
          payload: entity,
          timestamp: new Date().toISOString(),
          hash: currentHash
        })
        // Only store hash AFTER confirmed publish
        await this.storeHash(tableName, entityId, currentHash, entity)
        eventsEmitted++
      } else {
        unchangedCount++
      }
    }

    await this.updateLastPollTime(tableName, new Date())

    return {
      tableName,
      rowsScanned: changedEntities.length,
      eventsEmitted,
      unchangedCount,
      durationMs: Date.now() - startTime
    }
  }

  /**
  Checks for deletions on a regular basis by reconciling MongoDB's tracked IDs with Oracle's current id
  */
  async detectDeletes(tableName) {
    const startTime = Date.now()

    this.logger.info(`Running delete detection for ${tableName}`)

    const knownIds = await this.mongodb
      .collection('payload-hashes')
      .distinct('sourceId', { sourceTable: tableName })

    const currentIds = await this.getCurrentIds(tableName)
    const deletedIds = knownIds.filter((id) => !currentIds.includes(id))

    this.logger.info(`Detected ${deletedIds.length} deleted ${tableName} entities`)

    for (const deletedId of deletedIds) {
      const hashDoc = await this.mongodb.collection('payload-hashes').findOne({
        sourceTable: tableName,
        sourceId: deletedId
      })

      await this.publishEvent({
        type: 'DELETE',
        entityType: tableName.toLowerCase(),
        entityId: deletedId,
        deletedAt: new Date().toISOString(),
        reason: 'GDPR_RIGHT_TO_BE_FORGOTTEN',
        lastKnownPayload: hashDoc?.payload || null
      })

      await this.mongodb.collection('payload-hashes').deleteOne({
        sourceTable: tableName,
        sourceId: deletedId
      })
    }

    return {
      tableName,
      deletionsDetected: deletedIds.length,
      durationMs: Date.now() - startTime
    }
  }

  async getChangedEntities(tableName, lastPollTime) {
    const config = getTableConfig(tableName)
    const method = this.payloadCalculator[config.payloadMethod]

    if (!method) {
      throw new Error(
        `PayloadCalculator missing method '${config.payloadMethod}' for table ${tableName}`
      )
    }

    return await method.call(this.payloadCalculator, lastPollTime)
  }

  async getCurrentIds(tableName) {
    const config = getTableConfig(tableName)
    const connection = await this.oraclePool.getConnection()

    try {
      const query = `SELECT ${config.primaryKey} FROM ${tableName}`
      const result = await connection.execute(query, [], { outFormat: 4002 })
      return result.rows.map((row) => String(row[config.primaryKey]))
    } finally {
      await connection.close()
    }
  }

  getEntityId(tableName, entity) {
    const config = getTableConfig(tableName)
    const idValue = entity[config.entityIdField]

    if (idValue === undefined || idValue === null) {
      throw new Error(
        `Entity missing required field '${config.entityIdField}' for table ${tableName}`
      )
    }

    return String(idValue)
  }

  hashPayload(payload) {
    return crypto.createHash('sha256').update(stringify(payload)).digest('hex')
  }

  async getPreviousHash(tableName, entityId) {
    const doc = await this.mongodb.collection('payload-hashes').findOne({
      sourceTable: tableName,
      sourceId: entityId
    })
    return doc?.payloadHash || null
  }

  async storeHash(tableName, entityId, hash, payload) {
    await this.mongodb.collection('payload-hashes').updateOne(
      { sourceTable: tableName, sourceId: entityId },
      {
        $set: {
          payloadHash: hash,
          lastChecked: new Date(),
          payload
        }
      },
      { upsert: true }
    )
  }

  async publishEvent(event) {
    if (!this.eventBus) return

    const messageId = await this.eventBus.publish(event)

    if (!messageId) {
      throw new Error('Event publish failed - no acknowledgment')
    }

    this.logger.info('Event published and acknowledged:', {
      messageId,
      entityId: event.entityId
    })
  }

  async getLastPollTime(tableName) {
    const doc = await this.mongodb.collection('poll-state').findOne({ table: tableName })
    return doc?.lastPollTime || new Date(Date.now() - 24 * 60 * 60 * 1000)
  }

  async updateLastPollTime(tableName, pollTime) {
    await this.mongodb.collection('poll-state').updateOne(
      { table: tableName },
      { $set: { lastPollTime: pollTime, lastPollSuccess: new Date() } },
      { upsert: true }
    )
  }
}
