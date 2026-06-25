import oracledb from 'oracledb'

import { getPool } from '#/oracledb.js'
import { config } from '#/config.js'

/**
 * Shared fixtures and SQL helpers for the change-detection integration test
 * suites. Each test file builds its own `ID_PREFIX` so concurrent teardown
 * across files (or across processes) never purges another file's rows.
 */

export function makeIdPrefix(suffix) {
  return `WS-CD-${process.pid}-${Date.now()}-${suffix}`
}

export function makePyidGenerator(prefix) {
  let counter = 0

  return () => {
    counter += 1

    return `${prefix}-${counter}`
  }
}

export async function directInsert(pyid, status) {
  const conn = await getPool('pega').getConnection()

  try {
    await conn.execute(
      `INSERT INTO pega_data.ahwork_ac (pyid, pzinskey, pxobjclass, pystatuswork)
       VALUES (:1, :2, 'AH-AC-WS', :3)`,
      [pyid, `AH-AC-WS ${pyid}`, status]
    )
    await conn.commit()
  } finally {
    await conn.close()
  }
}

export async function directUpdate(pyid, status) {
  const conn = await getPool('pega').getConnection()

  try {
    await conn.execute(
      `UPDATE pega_data.ahwork_ac SET pystatuswork = :1 WHERE pyid = :2`,
      [status, pyid]
    )
    await conn.commit()
  } finally {
    await conn.close()
  }
}

export async function directDelete(pyid) {
  const conn = await getPool('pega').getConnection()

  try {
    await conn.execute(`DELETE FROM pega_data.ahwork_ac WHERE pyid = :1`, [
      pyid
    ])
    await conn.commit()
  } finally {
    await conn.close()
  }
}

export async function purgeRowsByPrefix(prefix) {
  const conn = await getPool('pega').getConnection()

  try {
    await conn.execute(
      `DELETE FROM pega_data.ahwork_ac WHERE pyid LIKE '${prefix}-%'`
    )
    await conn.commit()
  } finally {
    await conn.close()
  }
}

export async function countSourceRows() {
  const conn = await getPool('pega').getConnection()

  try {
    const result = await conn.execute(
      `SELECT COUNT(*) FROM pega_data.ahwork_ac`
    )

    return Number(result.rows[0][0])
  } finally {
    await conn.close()
  }
}

function splitMv(mv) {
  const [owner, name] = mv.split('.').map((part) => part.toUpperCase())

  return { owner, name }
}

export async function mvExists({ mv, pool }) {
  const { owner, name } = splitMv(mv)
  const conn = await getPool(pool).getConnection()

  try {
    const result = await conn.execute(
      `SELECT COUNT(*) FROM all_mviews WHERE owner = :owner AND mview_name = :name`,
      { owner, name }
    )

    return Number(result.rows[0][0]) > 0
  } finally {
    await conn.close()
  }
}

export async function getMvCreatedAt({ mv, pool }) {
  const { owner, name } = splitMv(mv)
  const conn = await getPool(pool).getConnection()

  try {
    const result = await conn.execute(
      `SELECT created FROM all_objects
       WHERE owner = :owner AND object_name = :name AND object_type = 'MATERIALIZED VIEW'`,
      { owner, name }
    )

    return result.rows[0]?.[0]
  } finally {
    await conn.close()
  }
}

export async function dropMaterializedView({ mv, pool }) {
  // Connect as the MV owner — DROP MATERIALIZED VIEW in another schema
  // requires DROP ANY MATERIALIZED VIEW (DBA-level). As the owner of the
  // object, apha_poc can drop without that privilege.
  const { owner, name } = splitMv(mv)
  const ownerPool = getPool(pool)

  const connection = await oracledb.getConnection({
    user: config.get('changeDetection.mvOwnerUser'),
    password: config.get('changeDetection.mvOwnerPassword'),
    connectString: ownerPool.connectString
  })

  try {
    await connection.execute(
      `BEGIN
         EXECUTE IMMEDIATE 'DROP MATERIALIZED VIEW ${owner}.${name}';
       EXCEPTION
         WHEN OTHERS THEN
           IF SQLCODE = -12003 THEN NULL; -- ORA-12003: MV does not exist
           ELSE RAISE;
           END IF;
       END;`
    )
  } finally {
    await connection.close()
  }
}
