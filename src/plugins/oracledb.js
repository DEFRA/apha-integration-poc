import { closeOracleDb } from '#/oracledb.js'

export const oracleDb = {
  plugin: {
    name: 'oracledb',
    version: '1.0.0',
    register: function (server) {
      server.events.on('stop', async () => {
        server.logger.info('Closing OracleDB pools')

        await closeOracleDb()
      })
    }
  }
}
