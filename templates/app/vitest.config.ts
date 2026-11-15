import { configDefaults, defineConfig } from 'vitest/config';

// Unit tests: fast, no emulator. `*.integration.test.ts` runs under `plat test`.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: [...configDefaults.exclude, '**/*.integration.test.ts'],
  },
});
