import oracledb from 'oracledb'
import { MongoClient } from 'mongodb'
import { PayloadCalculator } from '../../src/services/change-detection/PayloadCalculator.js'
import { ChangeDetector } from '../../src/services/change-detection/ChangeDetector.js'

class InMemoryEventBus {
  constructor() {
    this.events = []
  }

  async publish(event) {
    this.events.push(event)
    return `msg-${this.events.length}` // Return messageId for acknowledgment
  }

  getEvents() {
    return this.events
  }

  clear() {
    this.events = []
  }
}

async function setupConnections() {
  const oraclePool = await oracledb.createPool({
    user: process.env.ORACLE_USER || 'ahbrp',
    password: process.env.ORACLE_PASSWORD || 'password',
    connectString: process.env.ORACLE_CONNECT || 'localhost:1521/FREEPDB1'
  })

  const mongoClient = await MongoClient.connect(
    process.env.MONGO_URI || 'mongodb://localhost:27017'
  )
  const mongodb = mongoClient.db(process.env.MONGO_DB || 'change-detection-poc')

  return { oraclePool, mongoClient, mongodb }
}

async function cleanState(mongodb) {
  await mongodb.collection('payload-hashes').deleteMany({})
  await mongodb.collection('poll-state').deleteMany({})
}

async function updateParty(oraclePool, partyPk, newId) {
  const connection = await oraclePool.getConnection()
  try {
    await connection.execute(
      'UPDATE PARTY SET PARTY_ID = :newId, UPDATED_DATETIME = SYSTIMESTAMP WHERE PARTY_PK = :pk',
      { newId, pk: partyPk }
    )
    await connection.commit()
  } finally {
    await connection.close()
  }
}

async function updateTimestampOnly(oraclePool, partyPk) {
  const connection = await oraclePool.getConnection()
  try {
    await connection.execute(
      'UPDATE PARTY SET UPDATED_DATETIME = SYSTIMESTAMP WHERE PARTY_PK = :pk',
      { pk: partyPk }
    )
    await connection.commit()
  } finally {
    await connection.close()
  }
}

async function deleteParty(oraclePool, partyPk) {
  const connection = await oraclePool.getConnection()
  try {
    await connection.execute('DELETE FROM PARTY_STATE WHERE PARTY_PK = :pk', {
      pk: partyPk
    })
    await connection.execute('DELETE FROM PARTY WHERE PARTY_PK = :pk', {
      pk: partyPk
    })
    await connection.commit()
  } finally {
    await connection.close()
  }
}

async function getFirstParty(oraclePool) {
  const connection = await oraclePool.getConnection()
  try {
    const result = await connection.execute(
      'SELECT PARTY_PK, PARTY_ID FROM PARTY WHERE ROWNUM = 1',
      [],
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    )
    return result.rows[0]
  } finally {
    await connection.close()
  }
}

async function runTests() {
  const { oraclePool, mongoClient, mongodb } = await setupConnections()

  const eventBus = new InMemoryEventBus()
  const payloadCalculator = new PayloadCalculator(oraclePool)
  const changeDetector = new ChangeDetector(
    oraclePool,
    mongodb,
    eventBus,
    payloadCalculator
  )

  try {
    await cleanState(mongodb)

    const baseline = await changeDetector.pollForChanges('PARTY')
    console.log(
      `Baseline: scanned=${baseline.rowsScanned} events=${baseline.eventsEmitted}`
    )

    await new Promise((resolve) => setTimeout(resolve, 2000))

    await mongodb
      .collection('poll-state')
      .updateOne(
        { table: 'PARTY' },
        { $set: { lastPollTime: new Date(Date.now() - 60 * 1000) } }
      )

    const party = await getFirstParty(oraclePool)
    await updateParty(oraclePool, party.PARTY_PK, `UPDATED-${party.PARTY_ID}`)

    eventBus.clear()
    const updateResult = await changeDetector.pollForChanges('PARTY')
    console.log(
      `Update: scanned=${updateResult.rowsScanned} events=${updateResult.eventsEmitted}`
    )

    await new Promise((resolve) => setTimeout(resolve, 2000))

    await mongodb
      .collection('poll-state')
      .updateOne(
        { table: 'PARTY' },
        { $set: { lastPollTime: new Date(Date.now() - 60 * 1000) } }
      )

    await updateTimestampOnly(oraclePool, party.PARTY_PK)

    eventBus.clear()
    const falsePositiveResult = await changeDetector.pollForChanges('PARTY')
    console.log(
      `False positive check: scanned=${falsePositiveResult.rowsScanned} events=${falsePositiveResult.eventsEmitted} unchanged=${falsePositiveResult.unchangedCount}`
    )

    const countBefore = await mongodb
      .collection('payload-hashes')
      .countDocuments({ sourceTable: 'PARTY' })

    await deleteParty(oraclePool, party.PARTY_PK)

    eventBus.clear()
    const deleteResult = await changeDetector.detectDeletes('PARTY')
    console.log(`Delete: detected=${deleteResult.deletionsDetected}`)

    const countAfter = await mongodb
      .collection('payload-hashes')
      .countDocuments({ sourceTable: 'PARTY' })
    console.log(`Hashes removed: ${countBefore - countAfter}`)

    console.log('\nAll tests passed')
  } catch (error) {
    console.error('Test failed:', error.message)
    throw error
  } finally {
    await oraclePool.close()
    await mongoClient.close()
  }
}

runTests().catch((err) => {
  console.error('Fatal:', err.message)
  process.exit(1)
})
