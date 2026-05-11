import { Db, MongoClient } from 'mongodb'
import { LockManager } from 'mongo-locks'

describe('#mongoDb', () => {
  let server

  describe('Set up', () => {
    beforeAll(async () => {
      // Dynamic import needed due to config being updated by vitest-mongodb
      const { createServer } = await import('#/server.js')

      server = await createServer()
      await server.initialize()
    })

    afterAll(async () => {
      await server.stop({ timeout: 1000 })
    })

    test('Server should have expected MongoDb decorators', () => {
      expect(server.db).toBeInstanceOf(Db)
      expect(server.mongoClient).toBeInstanceOf(MongoClient)
      expect(server.locker).toBeInstanceOf(LockManager)
    })

    test('MongoDb should have expected database name', () => {
      expect(server.db.databaseName).toBe('apha-integration-poc')
    })

    test('MongoDb should have expected namespace', () => {
      expect(server.db.namespace).toBe('apha-integration-poc')
    })
  })

  describe('Shut down', () => {
    beforeAll(async () => {
      // Dynamic import needed due to config being updated by vitest-mongodb
      const { createServer } = await import('#/server.js')

      server = await createServer()
      await server.initialize()
    })

    test('Should close Mongo client on server stop', async () => {
      const closeSpy = vi.spyOn(server.mongoClient, 'close')
      await server.stop({ timeout: 1000 })

      expect(closeSpy).toHaveBeenCalledWith()
    })

    test('Should not throw if Mongo client close rejects', async () => {
      // Dynamic import needed due to config being updated by vitest-mongodb
      const { createServer } = await import('#/server.js')
      const secondServer = await createServer()
      await secondServer.initialize()

      vi.spyOn(secondServer.mongoClient, 'close').mockRejectedValueOnce(
        new Error('close failed')
      )

      await expect(
        secondServer.stop({ timeout: 1000 })
      ).resolves.toBeUndefined()
    })
  })
})
