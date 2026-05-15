import oracledb from 'oracledb'

import { config } from '#/config.js'
import { createLogger } from '#/common/helpers/logging/logger.js'
import { startProxyForwarders } from '#/oracle-proxy-forwarder.js'

const logger = createLogger()

let forwarders

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

  // In the deployed CDP environment, OracleDB egress is forced through Squid.
  // Thin mode honours `httpsProxy`/`httpsProxyPort` pool attrs and tunnels
  // through the proxy natively (the apha-integration-bridge uses this). Thick
  // mode (which we run here for CQN) does NOT — those attrs are documented as
  // Thin-mode-only — so we run an in-process HTTP-CONNECT forwarder per
  // unique upstream and rewrite each pool's connectString to localhost.
  const proxyUrl = config.get('httpProxy')
  let httpsProxy
  let httpsProxyPort

  if (proxyUrl) {
    const url = new URL(proxyUrl)

    httpsProxy = url.hostname
    httpsProxyPort = Number(url.port)
  }

  const pools = config.get('oracledb')
  const useForwarder = Boolean(proxyUrl) && !oracledb.thin

  if (useForwarder) {
    forwarders = await startProxyForwarders({
      targets: Object.values(pools).map((cfg) => cfg.host),
      proxy: { host: httpsProxy, port: httpsProxyPort },
      logger
    })
  }

  for (const [name, cfg] of Object.entries(pools)) {
    logger.info(`Creating OracleDB pool "${name}" (alias: ${cfg.poolAlias})`)

    const effectiveHost = useForwarder ? forwarders.map[cfg.host] : cfg.host

    const poolOptions = {
      user: cfg.username,
      password: cfg.password,
      connectString: `${effectiveHost}/${cfg.dbname}`,
      poolMin: cfg.poolMin,
      poolMax: cfg.poolMax,
      poolTimeout: cfg.poolTimeout,
      poolAlias: cfg.poolAlias
    }

    // Thin-mode-only: native CONNECT tunnel. Thick mode ignores these — the
    // forwarder above is what tunnels Thick-mode connections through Squid.
    if (!useForwarder && httpsProxy && httpsProxyPort) {
      poolOptions.httpsProxy = httpsProxy
      poolOptions.httpsProxyPort = httpsProxyPort
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

  if (forwarders) {
    await forwarders.close()
    forwarders = undefined
    logger.info('Closed OracleDB CONNECT-tunnel forwarders')
  }
}

export function getPool(name) {
  const alias = config.get(`oracledb.${name}.poolAlias`)

  return oracledb.getPool(alias)
}
