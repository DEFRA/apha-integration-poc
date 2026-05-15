import oracledb from 'oracledb'

import { config } from '#/config.js'
import { createLogger } from '#/common/helpers/logging/logger.js'

const logger = createLogger()

export async function initOracleDb() {
  const libDir = config.get('oracleClientLibDir')

  if (libDir && oracledb.thin) {
    // On Linux, passing libDir to initOracleClient segfaults — the Instant
    // Client must instead be discoverable via LD_LIBRARY_PATH (set in the
    // Dockerfile). libDir is only used for Thick mode on macOS/Windows.
    const onLinux = process.platform === 'linux'

    logger.info(
      `Initialising oracledb Thick mode (${onLinux ? 'via LD_LIBRARY_PATH' : `libDir: ${libDir}`})`
    )

    oracledb.initOracleClient(onLinux ? {} : { libDir })
  }

  const pools = config.get('oracledb')

  for (const [name, cfg] of Object.entries(pools)) {
    logger.info(`Creating OracleDB pool "${name}" (alias: ${cfg.poolAlias})`)

    const poolOptions = {
      user: cfg.username,
      password: cfg.password,
      connectString: `${cfg.host}/${cfg.dbname}`,
      poolMin: cfg.poolMin,
      poolMax: cfg.poolMax,
      poolTimeout: cfg.poolTimeout,
      poolAlias: cfg.poolAlias
    }

    // Thick mode unlocks CQN; `events: true` lets the pool's connections receive callbacks.
    if (!oracledb.thin) {
      poolOptions.events = true
    }

    await oracledb.createPool(poolOptions)
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
