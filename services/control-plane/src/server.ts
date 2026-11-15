/**
 * Control plane HTTP API (`/v1/*`, the `PlatformApi` contract) and console
 * sign-in (`/auth/*`). The console SPA itself is static (web/dist) and served
 * by the router; the platform's server wrapper adds health, telemetry and traces.
 */
import { toFetchHandler } from '@ericminassian/platform';
import { Layer } from 'effect';
import { HttpLive } from './api/http.ts';
import { Artifacts } from './artifacts.ts';
import { Tokens } from './auth.ts';
import { DataBrowser } from './data.ts';
import { Dns } from './dns.ts';
import { GitHub } from './github.ts';
import { WorkerJobs } from './jobs/call.ts';
import { AppQueues } from './jobs/queues.ts';
import { AppRealtime } from './jobs/realtime.ts';
import { BaseLive } from './layers.ts';
import { Logs } from './logs.ts';
import { AppSecrets } from './secrets.ts';
import { TelemetryQuery } from './telemetry/query.ts';

/** The API on AWS. `src/dev.ts` serves the same layer locally. */
export const ServerLive = HttpLive.pipe(
  Layer.provide(
    Layer.mergeAll(
      AppQueues.layer,
      AppRealtime.layer,
      AppSecrets.layer,
      Artifacts.layer,
      DataBrowser.layer,
      Dns.layer,
      GitHub.layer,
      Logs.layer,
      TelemetryQuery.layer,
      Tokens.layer,
      WorkerJobs.layer,
    ),
  ),
  Layer.provide(BaseLive),
);

export default toFetchHandler(ServerLive);
