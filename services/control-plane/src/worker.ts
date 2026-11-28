/**
 * Control plane worker: scheduled jobs, rollbacks, and the telemetry processor
 * (target of the account-level log subscription). Deploys and destroys are
 * the `stages` queue's, which runs in a function of its own (plat.config.ts).
 */
import { defineWorker, Queues } from '@ericminassian/platform';
import { EDGE_FLOOR_JOB, names, platformNames } from '@ericminassian/platform-core';
import { Effect, Exit, Layer, Schema } from 'effect';
import { AlertEvaluator } from './alerts/evaluator.ts';
import { AlertRules } from './alerts/rules.ts';
import { Artifacts } from './artifacts.ts';
import { Settings } from './config.ts';
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
import { Store } from './store.ts';
import { aggregate, aggregateEdge, parseLogMessage } from './telemetry/aggregate.ts';
import { TelemetryQuery } from './telemetry/query.ts';
import { TelemetryWriter } from './telemetry/write.ts';

const WorkerLive = Layer.mergeAll(
  AlertEvaluator.layer,
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
      AlertRules.layer,
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

/** Whether the platform serves a stage (it hasn't been destroyed): the hosts the router's access log counts. */
const servedStages = Store.use((s) => s.listAllStages).pipe(
  Effect.map((stages) => {
    const served = new Set(
      stages.filter((s) => s.status !== 'destroyed').map((s) => names.base(s.app, s.stage)),
    );
    return (app: string, stage: string) => served.has(names.base(app, stage));
  }),
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
    alerts: () =>
      AlertEvaluator.use((e) => e.run).pipe(
        Effect.flatMap((r) =>
          r.changed ? Effect.logInfo('alert rules changed state').pipe(Effect.annotateLogs(r)) : Effect.void,
        ),
      ),
  },
  logs: (batch) =>
    Effect.gen(function* () {
      const messages = batch.logEvents.map((e) => e.message);
      // The router's access log has a subscription of its own (foundation/src/deploy.ts).
      const aggregation =
        batch.logGroup === platformNames.edgeLogGroup
          ? aggregateEdge(messages, (yield* Settings).platform, yield* servedStages)
          : aggregate(messages.flatMap((m) => parseLogMessage(m) ?? []));
      if (aggregation.events === 0) return;
      const newGroups = yield* TelemetryWriter.use((w) => w.apply(aggregation));
      if (newGroups.length) {
        yield* Effect.logInfo('new error groups').pipe(
          Effect.annotateLogs({ count: newGroups.length, logGroup: batch.logGroup }),
        );
      }
    }),
});
