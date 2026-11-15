import { defineConfig, devices } from '@playwright/test';

// Browser tests (`pnpm test:e2e`). CI runs them with BASE_URL set: against each
// PR's preview, and against production after each deploy. Without BASE_URL they
// run against `plat dev`, started here unless it's already running.
const baseURL = process.env.BASE_URL ?? 'http://localhost:3000';

export default defineConfig({
  testDir: 'e2e',
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL,
    // CI uploads test-results/ (traces included) when a run fails.
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: process.env.BASE_URL
    ? undefined
    : {
        command: 'pnpm dev',
        url: baseURL,
        reuseExistingServer: true,
        timeout: 120_000,
        // `plat dev` stops the emulator and its other children on SIGTERM.
        gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
      },
});
