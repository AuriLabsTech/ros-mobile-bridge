import { defineConfig } from 'vitest/config';

/**
 * Integration suite: opt-in (`npm run test:integration`), requires Docker.
 * Kept out of the default `vitest.config.ts` include so `npm test` stays
 * hermetic. Files run serially: both transports share one bridge container.
 */
export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],
    setupFiles: ['tests/integration/setup.ts'],
    globalSetup: ['tests/integration/globalSetup.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
