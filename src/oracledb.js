import oracledb from 'oracledb'

import { config } from '#/config.js'
import { createLogger } from '#/common/helpers/logging/logger.js'

const logger = createLogger()

export async function initOracleDb() {
  const pools = config.get('oracledb')

  for (const [name, cfg] of Object.entries(pools)) {
    logger.info(`Creating OracleDB pool "${name}" (alias: ${cfg.poolAlias})`)

    await oracledb.createPool({
      user: cfg.username,
      password: cfg.password,
      connectString: `${cfg.host}/${cfg.dbname}`,
      poolMin: cfg.poolMin,
      poolMax: cfg.poolMax,
      poolTimeout: cfg.poolTimeout,
      poolAlias: cfg.poolAlias
    })
  }
}

export async function closeOracleDb() {
  const pools = config.get('oracledb')

  for (const [name, cfg] of Object.entries(pools)) {
    try {
      await oracledb.getPool(cfg.poolAlias).close(cfg.poolCloseWaitTime)

      logger.info(`Closed OracleDB pool "${name}"`)
    } catch (err) {
      logger.error({ err }, `Failed to close OracleDB pool "${name}"`)
    }
  }
}

export function getPool(name) {
  const alias = config.get(`oracledb.${name}.poolAlias`)

  return oracledb.getPool(alias)
}
