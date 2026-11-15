import { defineConfig } from 'vitest/config';

// Needs the AWS Emulator binary (PATH or PLAT_EMULATOR_BIN); skipped otherwise.
export default defineConfig({
  test: {
    include: ['test/**/*.integration.test.ts'],
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
