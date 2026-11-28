/**
 * Control plane HTTP API (`/v1/*`, the `PlatformApi` contract) and console
 * sign-in (`/auth/*`). The console SPA itself is static (web/dist) and served
 * by the router; the platform's server wrapper adds health, telemetry and traces.
 */
import { Queues, toFetchHandler } from '@ericminassian/platform';
import { Layer } from 'effect';
import { AlertRules } from './alerts/rules.ts';
import { HttpLive } from './api/http.ts';
import { Artifacts } from './artifacts.ts';
import { Tokens } from './auth.ts';
import { DataBrowser } from './data.ts';
import { Dns } from './dns.ts';
import { EdgeFloor } from './edge-floor.ts';
import { AppEmail } from './email.ts';
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
      AlertRules.layer,
      AppEmail.layer,
      AppQueues.layer,
      AppRealtime.layer,
      AppSecrets.layer,
      Artifacts.layer,
      DataBrowser.layer,
      Dns.layer,
      EdgeFloor.layer,
      GitHub.layer,
      Logs.layer,
      TelemetryQuery.layer,
      Tokens.layer,
      WorkerJobs.layer.pipe(Layer.provide(Queues.layer)),
    ),
  ),
  Layer.provide(BaseLive),
);

export default toFetchHandler(ServerLive);
