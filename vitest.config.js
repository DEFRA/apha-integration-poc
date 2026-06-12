import { defineConfig, configDefaults } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    clearMocks: true,
    fileParallelism: false,
    // The change-detection suites are integration tests against a real
    // Oracle: their hooks drain in-flight sweeps, unsubscribe CQN and close
    // pools, which can exceed the 10s default on slow runners.
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.js'],
      exclude: [...configDefaults.exclude, 'coverage']
    },
    setupFiles: ['.vite/mongo-memory-server.js', '.vite/setup-files.js']
  }
})
