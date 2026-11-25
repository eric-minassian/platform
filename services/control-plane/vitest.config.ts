import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'server', include: ['test/**/*.test.ts'], environment: 'node' } },
      './web/vitest.config.ts',
    ],
  },
});
