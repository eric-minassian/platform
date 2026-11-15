import { defineConfig } from 'vitest/config';

// Integration tests: `plat test` starts the AWS Emulator, provisions this app
// (stage `test`) and runs these with the same environment deployed code gets.
export default defineConfig({
  test: {
    include: ['test/**/*.integration.test.ts'],
    testTimeout: 30_000,
  },
});
