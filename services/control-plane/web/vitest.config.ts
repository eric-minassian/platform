import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/** The console's tests: pages rendered in jsdom against the demo API, in process. */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    name: 'console',
    environment: 'jsdom',
    environmentOptions: { jsdom: { url: 'http://console.test/' } },
    include: ['src/**/*.test.tsx'],
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    testTimeout: 20_000,
  },
});
