/**
 * Control plane worker: the deployer, stage destroyer, scheduled jobs, and the
 * telemetry processor (target of the account-level log subscription).
 */
import { defineWorker } from '@ericminassian/platform';
import { Effect, Layer, Schema } from 'effect';
import { Artifacts } from './artifacts.ts';
import { Deployer, StageEngine } from './deploy.ts';
import { AppEmail } from './email.ts';
import { GitHub } from './github.ts';
import { WorkerJobs } from './jobs/call.ts';
import { CostCollector } from './jobs/cost.ts';
import { Pinger } from './jobs/pinger.ts';
import { RealtimeKey } from './jobs/realtime.ts';
import { Reaper } from './jobs/reaper.ts';
import { StorageExpiry } from './jobs/storage.ts';
import { Watchdog } from './jobs/watchdog.ts';
import { BaseLive } from './layers.ts';
import { aggregate, parseLogMessage } from './telemetry/aggregate.ts';
import { TelemetryWriter } from './telemetry/write.ts';

const WorkerLive = Layer.mergeAll(
  CostCollector.layer,
  Deployer.layer,
  Pinger.layer,
  RealtimeKey.layer,
  Reaper.layer,
  StorageExpiry.layer,
  TelemetryWriter.layer,
  Watchdog.layer,
).pipe(
  Layer.provide(
    Layer.mergeAll(AppEmail.layer, Artifacts.layer, GitHub.layer, StageEngine.layer, WorkerJobs.layer),
  ),
  Layer.provideMerge(BaseLive),
);

/** What the API sends with each job (see api/deployments.ts and jobs/call.ts). */
const DeployJob = Schema.Struct({ id: Schema.String });
const StageJob = Schema.Struct({ app: Schema.String, stage: Schema.String });
const RollbackJob = Schema.Struct({ ...StageJob.fields, deploymentId: Schema.optional(Schema.String) });

export default defineWorker({
  layer: WorkerLive,
  invoke: {
    deploy: (payload) =>
      Effect.flatMap(Schema.decodeUnknownEffect(DeployJob)(payload), ({ id }) =>
        Deployer.use((d) => d.run(id)),
      ),
    destroy: (payload) =>
      Effect.flatMap(Schema.decodeUnknownEffect(StageJob)(payload), ({ app, stage }) =>
        Deployer.use((d) => d.destroy(app, stage)),
      ),
    // Called synchronously by the API (see jobs/call.ts for why it runs here).
    rollback: (payload) =>
      Effect.flatMap(Schema.decodeUnknownEffect(RollbackJob)(payload), ({ app, stage, deploymentId }) =>
        Deployer.use((d) => d.rollback(app, stage, deploymentId)),
      ),
  },
  crons: {
    pinger: () => Pinger.use((p) => p.run),
    watchdog: () => Watchdog.use((w) => w.run),
    cost: () => CostCollector.use((c) => c.run()),
    reaper: () => Reaper.use((r) => r.run),
    'realtime-key': () => RealtimeKey.use((k) => k.run),
    'storage-expiry': () => StorageExpiry.use((s) => s.run),
  },
  logs: (batch) =>
    Effect.gen(function* () {
      const events = batch.logEvents.flatMap((e) => parseLogMessage(e.message) ?? []);
      if (events.length === 0) return;
      const newGroups = yield* TelemetryWriter.use((w) => w.apply(aggregate(events)));
      if (newGroups.length) {
        yield* Effect.logInfo('new error groups').pipe(
          Effect.annotateLogs({ count: newGroups.length, logGroup: batch.logGroup }),
        );
      }
    }),
});
