import oracledb from 'oracledb'

import { config } from '#/config.js'
import { createChangeQuery } from '#/cqn.js'

const WORKORDERS_CHANGE_QUERY =
  'SELECT pyid, pystatuswork FROM pega_data.ahwork_ac'

export const cqn = {
  plugin: {
    name: 'cqn',
    version: '1.0.0',
    register: async function (server) {
      if (!config.get('cqn.enabled')) {
        return
      }

      if (oracledb.thin) {
        server.logger.warn(
          'CQN enabled but oracledb is in Thin mode; set ORACLE_CLIENT_LIB_DIR to enable Thick mode'
        )

        return
      }

      let subscription

      try {
        subscription = await createChangeQuery({
          pool: 'pega',
          query: WORKORDERS_CHANGE_QUERY
        })
      } catch (err) {
        server.logger.error({ err }, 'Failed to register CQN subscription')

        return
      }

      server.logger.info(
        { query: WORKORDERS_CHANGE_QUERY },
        'CQN subscription registered for workorders'
      )

      subscription.emitter.on('change', (event) => {
        server.logger.info({ event }, 'Workorder change detected')
      })

      subscription.emitter.on('deregistered', () => {
        server.logger.warn('CQN subscription was deregistered by the database')
      })

      server.events.on('stop', async () => {
        server.logger.info('Unsubscribing CQN subscription')

        try {
          await subscription.unsubscribe()
        } catch (err) {
          server.logger.error({ err }, 'Failed to unsubscribe CQN subscription')
        }
      })
    }
  }
}
