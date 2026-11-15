import { defineConfig } from 'vitest/config';

/** Runs against a real AWS Emulator (set PLAT_EMULATOR_BIN or install `aws-emulator`). */
export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    testTimeout: 300_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
