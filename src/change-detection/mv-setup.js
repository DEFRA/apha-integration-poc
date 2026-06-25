import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import oracledb from 'oracledb'

import { config } from '#/config.js'
import { getPool } from '#/oracledb.js'

const SQL_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'materialised-views'
)

/**
 * Self-serve deployment of materialised views.
 *
 * On detector start, before any sweep, this checks whether the source's
 * configured MV exists in the database. If it does, we skip silently and
 * carry on. If it does not, we read the matching SQL file from
 * `materialised-views/<sourceName>.sql` and execute it as the MV owner
 * (not the detector's pool user) — Oracle's cross-schema rules require
 * the owner to be the session user during a CREATE MATERIALIZED VIEW whose
 * defining query references another schema.
 *
 * Schema drift is NOT detected: if the MV exists but the SQL file has
 * changed, the file change is ignored. To pick up a new definition, drop
 * the MV manually and the next detector start will recreate it.
 */
export async function ensureMaterializedView({
  sourceName,
  sourceConfig,
  logger
}) {
  const { owner, name } = parseMvIdentifier(sourceConfig.mv, sourceName)

  if (await mvExists({ pool: sourceConfig.pool, owner, name })) {
    logger.info(
      { source: sourceName, mv: `${owner}.${name}` },
      'Materialised view already exists; skipping deploy'
    )

    return { created: false }
  }

  const sql = await readMvSql(sourceName)

  await runAsMvOwner(sourceConfig.pool, async (connection) => {
    logger.info(
      { source: sourceName, mv: `${owner}.${name}` },
      'Materialised view missing; deploying from SQL file'
    )

    await connection.execute(sql)
  })

  logger.info(
    { source: sourceName, mv: `${owner}.${name}` },
    'Materialised view deployed'
  )

  return { created: true }
}

function parseMvIdentifier(mvFqn, sourceName) {
  // `APHA_POC.AHWORK_AC_MV` → { owner: 'APHA_POC', name: 'AHWORK_AC_MV' }.
  const parts = mvFqn.split('.')

  if (parts.length !== 2) {
    throw new Error(
      `Source "${sourceName}" has invalid mv config "${mvFqn}". Expected "<owner>.<name>".`
    )
  }

  return { owner: parts[0].toUpperCase(), name: parts[1].toUpperCase() }
}

async function mvExists({ pool, owner, name }) {
  const connection = await getPool(pool).getConnection()

  try {
    const result = await connection.execute(
      `SELECT COUNT(*) FROM all_mviews WHERE owner = :owner AND mview_name = :name`,
      { owner, name }
    )

    return Number(result.rows[0][0]) > 0
  } finally {
    await connection.close().catch(() => {})
  }
}

async function readMvSql(sourceName) {
  const sqlPath = path.join(SQL_DIR, `${sourceName}.sql`)

  let raw

  try {
    raw = await readFile(sqlPath, 'utf-8')
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(
        `No materialised-view SQL file found for source "${sourceName}" (expected at ${sqlPath}). Create the file or remove the source from changeDetection.sources.`
      )
    }

    throw err
  }

  // node-oracledb's execute() runs ONE statement and chokes on a trailing
  // semicolon. SQL files conventionally end with one, so strip it (along
  // with any trailing comments / whitespace).
  const stripped = raw
    .replace(/--[^\n]*$/gm, '') // strip line comments
    .trim()
    .replace(/;\s*$/, '')

  if (!stripped) {
    throw new Error(
      `Materialised-view SQL file for source "${sourceName}" is empty (${sqlPath}).`
    )
  }

  return stripped
}

async function runAsMvOwner(poolName, fn) {
  // We connect as the MV owner — NOT the detector's pool user — because
  // Oracle's CREATE MATERIALIZED VIEW privilege check parses the defining
  // query under the session user's identity. ALTER SESSION SET CURRENT_SCHEMA
  // alone is not enough for cross-schema SELECTs.
  const pool = getPool(poolName)

  const connection = await oracledb.getConnection({
    user: config.get('changeDetection.mvOwnerUser'),
    password: config.get('changeDetection.mvOwnerPassword'),
    connectString: pool.connectString
  })

  try {
    return await fn(connection)
  } finally {
    await connection.close().catch(() => {})
  }
}
