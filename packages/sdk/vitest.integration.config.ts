import { defineConfig } from 'vitest/config';

// Runs against a real AWS Emulator (see test/integration/setup.ts). The global
// setup starts it before test workers spawn, so they inherit NODE_EXTRA_CA_CERTS.
export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    globalSetup: ['test/integration/setup.ts'],
    pool: 'forks',
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
