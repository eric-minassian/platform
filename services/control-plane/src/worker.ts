/**
 * Control plane worker: scheduled jobs, rollbacks, and the telemetry processor
 * (target of the account-level log subscription). Deploys and destroys are
 * the `stages` queue's, which runs in a function of its own (plat.config.ts).
 */
import { defineWorker, Queues } from '@ericminassian/platform';
import { EDGE_FLOOR_JOB } from '@ericminassian/platform-core';
import { Effect, Exit, Layer, Schema } from 'effect';
import { Artifacts } from './artifacts.ts';
import { Deployer, StageEngine } from './deploy.ts';
import { EdgeFloor } from './edge-floor.ts';
import { AppEmail } from './email.ts';
import { GitHub } from './github.ts';
import { StageJob, WorkerJobs } from './jobs/call.ts';
import { ComputeChooser } from './jobs/compute.ts';
import { CostCollector } from './jobs/cost.ts';
import { Pinger } from './jobs/pinger.ts';
import { RealtimeKey } from './jobs/realtime.ts';
import { Reaper } from './jobs/reaper.ts';
import { StorageExpiry } from './jobs/storage.ts';
import { Watchdog } from './jobs/watchdog.ts';
import { BaseLive } from './layers.ts';
import { aggregate, parseLogMessage } from './telemetry/aggregate.ts';
import { TelemetryQuery } from './telemetry/query.ts';
import { TelemetryWriter } from './telemetry/write.ts';

const WorkerLive = Layer.mergeAll(
  ComputeChooser.layer,
  CostCollector.layer,
  Deployer.layer,
  EdgeFloor.layer,
  Pinger.layer,
  RealtimeKey.layer,
  Reaper.layer,
  StorageExpiry.layer,
  TelemetryWriter.layer,
  Watchdog.layer,
).pipe(
  Layer.provide(
    Layer.mergeAll(
      AppEmail.layer,
      Artifacts.layer,
      GitHub.layer,
      StageEngine.layer,
      TelemetryQuery.layer,
      WorkerJobs.layer.pipe(Layer.provide(Queues.layer)),
    ),
  ),
  Layer.provideMerge(BaseLive),
);

/** What the API sends for a rollback (see jobs/call.ts). */
const RollbackJob = Schema.Struct({
  app: Schema.String,
  stage: Schema.String,
  deploymentId: Schema.optional(Schema.String),
});

export default defineWorker({
  layer: WorkerLive,
  queues: {
    stages: (message) =>
      Effect.flatMap(Schema.decodeUnknownEffect(StageJob)(message.body), (job) =>
        job.kind === 'deploy'
          ? Deployer.use((d) => d.run(job.id))
          : Deployer.use((d) => d.destroy(job.app, job.stage)),
      ),
  },
  invoke: {
    // Called synchronously by the API (see jobs/call.ts for why it runs here).
    rollback: (payload) =>
      Effect.flatMap(Schema.decodeUnknownEffect(RollbackJob)(payload), ({ app, stage, deploymentId }) =>
        Deployer.use((d) => d.rollback(app, stage, deploymentId)),
      ),
    // The edge floor's alarm went off (an EventBridge rule in the foundation stack).
    [EDGE_FLOOR_JOB]: () => EdgeFloor.use((f) => f.reconcile({ alarming: true })),
  },
  crons: {
    pinger: () => Pinger.use((p) => p.run),
    // Stuck deployments, and the edge floor where its alarm says (a missed alarm event, a
    // foundation deploy that took it off, an hour back under). Each runs whether or not the
    // other fails, and either failing fails the run.
    watchdog: () =>
      Effect.gen(function* () {
        const deployments = yield* Effect.exit(Watchdog.use((w) => w.run));
        const floor = yield* Effect.exit(EdgeFloor.use((f) => f.reconcile()));
        return yield* Exit.asVoidAll([deployments, floor]);
      }),
    cost: () => CostCollector.use((c) => c.run()),
    compute: () =>
      ComputeChooser.use((c) => c.run).pipe(
        Effect.flatMap((r) => Effect.logInfo('compute estimated').pipe(Effect.annotateLogs(r))),
      ),
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
