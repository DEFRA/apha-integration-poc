import oracledb from 'oracledb'

/**
 * Refresh a REFRESH-COMPLETE-ON-DEMAND materialised view.
 *
 * Called at the start of every sweep so the detector reads a freshly
 * synchronised mirror of the source. Refresh is a transactionally consistent
 * operation in Oracle — the MV either fully reflects a point in time or it
 * doesn't change at all.
 *
 * The MV name accepts schema.name; DBMS_MVIEW.REFRESH parses that itself.
 */
export async function refreshMv(connection, mvName) {
  await connection.execute(
    `BEGIN DBMS_MVIEW.REFRESH(:name, method => 'C'); END;`,
    { name: { val: mvName, dir: oracledb.BIND_IN, type: oracledb.STRING } }
  )
}
