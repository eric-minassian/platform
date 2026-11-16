import { defineApp, queue } from '@ericminassian/platform/config';
import type { StageJob } from './src/jobs/call.ts';

const app = defineApp({
  name: 'platform',
  description: 'The platform control plane: console, API, deployer and telemetry.',
  web: {
    server: 'src/server.ts',
    static: 'web/dist',
    build: 'pnpm web:build',
    dev: { command: 'pnpm web:dev' },
    spa: true,
    serverRoutes: ['/v1/', '/auth/'],
    timeoutSeconds: 120,
  },
  // The telemetry processor, crons and rollbacks: mostly waiting on DynamoDB and HTTP, so little
  // memory (Lambda bills GB-seconds). Below 512 MB this bundle's cold start, CPU-bound, drags.
  worker: { entry: 'src/worker.ts', timeoutSeconds: 300, memoryMb: 512 },
  queues: {
    // Deploys and destroys, in a function of their own: Lambda's full 15 minutes, and room for
    // artifacts and service images. One run each: the watchdog fails a deploy whose run died, and
    // a deploy is retried by deploying again, never behind the author's back.
    stages: queue<StageJob>({ memoryMb: 1024, timeoutSeconds: 900, maxAttempts: 1 }),
  },
  auth: false,
  crons: {
    pinger: '*/5 * * * *',
    watchdog: '*/5 * * * *',
    cost: '0 7 * * *',
    reaper: '0 8 * * *',
    // Extends realtime's public subscribe key (AppSync keys last at most a year).
    'realtime-key': '0 9 * * *',
    // Deletes files of stores with `expireAfterDays`.
    'storage-expiry': '30 9 * * *',
  },
});

export default app;

declare module '@ericminassian/platform/config' {
  interface Register {
    app: typeof app;
  }
}
