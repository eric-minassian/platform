/**
 * Local API for console development: `node src/dev.ts` serves the Hono app on
 * http://127.0.0.1:8787 (the Vite dev server proxies `/v1` and `/auth` here).
 *
 * Needs AWS access to a platform (real account or the emulator) plus:
 *   PLATFORM_RUNTIME_CONFIG  JSON PlatformRuntimeConfig (skips SSM)
 *   PLATFORM_SESSION_KEY     ≥ 32 chars (skips SSM)
 *   PLATFORM_DEV_USER        GitHub username to act as (skips sign-in; dev only)
 */
import { serve } from '@hono/node-server';
import { setDevAuth } from './auth.ts';
import app from './server.ts';

const port = Number(process.env.PORT ?? 8787);
if (process.env.PLATFORM_DEV_USER) setDevAuth(process.env.PLATFORM_DEV_USER);
process.env.PLATFORM_CONSOLE_URL ??= 'http://localhost:5173';

serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, (info) => {
  console.log(
    `control plane API on http://127.0.0.1:${info.port}${process.env.PLATFORM_DEV_USER ? ` (acting as ${process.env.PLATFORM_DEV_USER})` : ''}`,
  );
});
