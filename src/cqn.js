import { EventEmitter } from 'node:events'
import oracledb from 'oracledb'

import { getPool } from '#/oracledb.js'

let counter = 0

export async function createChangeQuery({ pool, query }) {
  if (!pool || !query) {
    throw new Error('createChangeQuery requires { pool, query }')
  }

  const emitter = new EventEmitter()

  const name = `cqn_${process.pid}_${Date.now()}_${++counter}`

  // The subscribing connection must stay open for the life of the
  // subscription — node-oracledb ties the registration to it. Releasing it
  // back to the pool while subscribed leaves the client library's
  // notification machinery referencing a recycled connection, which surfaces
  // as nondeterministic hangs at process exit.
  const connection = await getPool(pool).getConnection()

  const closeConnection = async () => {
    try {
      await connection.close()
    } catch {
      // Already closed or the pool is shutting down — nothing to release.
    }
  }

  const operations =
    oracledb.CQN_OPCODE_INSERT |
    oracledb.CQN_OPCODE_UPDATE |
    oracledb.CQN_OPCODE_DELETE

  const qos = oracledb.SUBSCR_QOS_QUERY | oracledb.SUBSCR_QOS_ROWIDS

  try {
    await connection.subscribe(name, {
      qos,
      operations,
      sql: query,
      namespace: oracledb.SUBSCR_NAMESPACE_DBCHANGE,
      timeout: 0,
      // Client-initiated notifications avoid the reverse TCP callback from
      // server → client. This is essential when running against an OracleDB
      // that can't reach the machine (CDP pods without ingress, etc.).
      clientInitiated: true,
      callback: (message) => {
        if (message.type === oracledb.SUBSCR_EVENT_TYPE_DEREG) {
          // Database-side deregistration: there is nothing left to
          // unsubscribe, so release the held connection before telling
          // listeners (who may immediately resubscribe on a fresh one).
          closeConnection().finally(() => emitter.emit('deregistered'))

          return
        }

        emitChanges(emitter, message)
      }
    })
  } catch (err) {
    await closeConnection()

    throw err
  }

  return {
    emitter,
    async unsubscribe() {
      try {
        await connection.unsubscribe(name)
      } finally {
        await closeConnection()
      }
    }
  }
}

function emitChanges(emitter, message) {
  for (const query of message.queries ?? []) {
    for (const table of query.tables ?? []) {
      emitter.emit('change', {
        tableName: table.name,
        operation: opcodeName(table.operation),
        rows: (table.rows ?? []).map((row) => ({
          rowid: row.rowid,
          operation: opcodeName(row.operation)
        }))
      })
    }
  }
}

function opcodeName(op) {
  if (op & oracledb.CQN_OPCODE_INSERT) {
    return 'INSERT'
  }

  if (op & oracledb.CQN_OPCODE_UPDATE) {
    return 'UPDATE'
  }

  if (op & oracledb.CQN_OPCODE_DELETE) {
    return 'DELETE'
  }

  return 'OTHER'
}
