/**
 * Local API for console development: `node src/dev.ts` serves the API on
 * http://127.0.0.1:8787 (the Vite dev server proxies `/v1` and `/auth` here).
 *
 * Needs AWS access to a platform (real account or the emulator) plus:
 *   PLATFORM_RUNTIME_CONFIG  JSON PlatformRuntimeConfig (skips SSM)
 *   PLATFORM_SESSION_KEY     ≥ 32 chars (skips SSM)
 *   PLATFORM_DEV_USER        GitHub username to act as (skips sign-in; dev only)
 */
import { toFetchHandler } from '@ericminassian/platform';
import { startServer } from '@ericminassian/platform/server';
import { BINDINGS_ENV, type Bindings, names } from '@ericminassian/platform-core';
import { Layer, Option } from 'effect';
import { DevUser } from './auth.ts';
import { ServerLive } from './server.ts';

const port = process.env.PORT ?? '8787';
process.env.PORT = port;
process.env.PLATFORM_CONSOLE_URL ??= 'http://localhost:5173';
process.env.PLATFORM_LOG_PRETTY ??= '1';
// The platform's server wrapper serves a stage described by its bindings;
// outside `plat dev` there is none, so describe this local API.
process.env[BINDINGS_ENV] ??= JSON.stringify({
  v: 1,
  app: 'platform',
  stage: 'local',
  host: `127.0.0.1:${port}`,
  url: `http://127.0.0.1:${port}`,
  revision: 'dev',
  region: process.env.AWS_REGION ?? 'us-east-1',
  queues: {},
  secrets: {
    path: names.secretsPath('platform', 'local'),
    sharedPath: names.sharedSecretsPath('platform'),
    names: [],
  },
} satisfies Bindings);

const devUser = Option.fromNullishOr(process.env.PLATFORM_DEV_USER);
await startServer(toFetchHandler(ServerLive.pipe(Layer.provide(Layer.succeed(DevUser, devUser)))));
console.log(
  `control plane API on http://127.0.0.1:${port}${Option.match(devUser, {
    onNone: () => '',
    onSome: (user) => ` (acting as ${user})`,
  })}`,
);
