import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/integration/**', 'node_modules', 'dist'],
    setupFiles: ['tests/_helpers/setup.ts'],
    // Capped so a run holds about 4.5 GB on a shared machine instead of one
    // worker per core.
    maxWorkers: 3,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', 'src/ZenohClient.ts'],
    },
  },
});
