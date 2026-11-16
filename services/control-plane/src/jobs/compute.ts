/**
 * The compute chooser (daily). For each prod stage with a server, it prices
 * a month of its recent traffic in both modes (core `simulateWebCompute`)
 * and keeps the estimate on the stage, for the console's Cost tab and `plat
 * apps show`. A stage on `web.compute: 'auto'` whose other mode has been 25%
 * cheaper three days running switches: the platform creates a deployment of
 * the live deployment's build in the other mode (actor `platform`), and the
 * deployer runs it like any other.
 */
import { GetMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import {
  COMPUTE_SWITCH_RULE,
  type ComputeEstimate,
  type ComputeStreak,
  DEFAULT_INIT_MS,
  INSTANCE_DEFAULT_MEMORY_MB,
  type MinuteTraffic,
  names,
  newDeploymentId,
  nextComputeStreak,
  PROD_STAGE,
  RESOLUTION_TTL_DAYS,
  simulateWebCompute,
  supportsRequestMode,
  type WebCompute,
  requestModeBlocked,
} from '@ericminassian/platform-core';
import { Clock, Context, DateTime, Effect, Layer, Option } from 'effect';
import { Artifacts } from '../artifacts.ts';
import { Aws, accountConcurrency, tryAws } from '../aws.ts';
import { type DeploymentItem, type StageItem, stageCompute } from '../records.ts';
import { Store } from '../store.ts';
import { TelemetryQuery } from '../telemetry/query.ts';
import { WorkerJobs } from './call.ts';

/** Days of traffic each estimate covers: the last week, or what minute rollups keep of it. */
export const TRAFFIC_DAYS = Math.min(7, RESOLUTION_TTL_DAYS['1m']);

export type ComputeDecision =
  | { readonly skip: string }
  | {
      readonly current: WebCompute;
      readonly estimate: ComputeEstimate;
      /** Undefined clears the stage's streak. */
      readonly streak?: ComputeStreak;
      /** Set when the stage should switch now (it's on `auto`). */
      readonly switchTo?: WebCompute;
    };

/** Why a prod stage has nothing to compare, if it hasn't. */
export function computeSkip(stage: StageItem, live: DeploymentItem): string | undefined {
  if (!live.manifest?.web?.server) return 'no server';
  // A build that only runs as a Web Function has nothing to compare.
  if (!supportsRequestMode(live.sdk)) return 'built with an SDK before request mode';
  if (!stageCompute(stage)) return 'no server deployed';
  return undefined;
}

/** Today's estimate and step of the switching rule for one prod stage (pure). */
export function decideCompute(input: {
  readonly stage: StageItem;
  readonly live: DeploymentItem;
  readonly traffic: { readonly minutes: ReadonlyArray<MinuteTraffic>; readonly initMs?: number };
  /** Peak memory of the stage's Web Function environments, when CloudWatch has it. */
  readonly instanceMemoryMb?: number;
  /** The account's Lambda concurrency limit, when known: too low, and nothing switches to request mode. */
  readonly accountConcurrency?: number;
  readonly now: number;
}): ComputeDecision {
  const skip = computeSkip(input.stage, input.live);
  const web = input.live.manifest?.web;
  const current = stageCompute(input.stage);
  if (skip || !web || !current) return { skip: skip ?? 'no server' };
  const from = input.now - TRAFFIC_DAYS * 86_400_000;
  const simulated = simulateWebCompute({
    minutes: input.traffic.minutes,
    from,
    to: input.now,
    requestMemoryMb: web.memoryMb,
    instanceMemoryMb: input.instanceMemoryMb ?? INSTANCE_DEFAULT_MEMORY_MB,
    maxConcurrencyPerEnvironment: web.concurrency,
    initMs: input.traffic.initMs ?? DEFAULT_INIT_MS,
  });
  const estimate: ComputeEstimate = { at: new Date(input.now).toISOString(), ...simulated };
  if (web.compute !== 'auto') return { current, estimate };
  const step = nextComputeStreak({
    current,
    estimate,
    streak: input.stage.computeStreak,
    day: estimate.at.slice(0, 10),
  });
  // The estimate stays, so the console shows what request mode would save once the account can run it.
  if (step.switchTo === 'request' && requestModeBlocked(input.accountConcurrency))
    return { current, estimate, ...(step.streak ? { streak: step.streak } : {}) };
  return { current, estimate, ...step };
}

/** What the platform records as a switch's message. */
export function switchMessage(from: WebCompute, to: WebCompute, estimate: ComputeEstimate): string {
  const usd = (n: number) => `$${n < 1 ? n.toFixed(4) : n.toFixed(2)}`;
  return `Compute switch to ${to} mode: ≈ ${usd(estimate[to].monthlyUsd)} a month against ≈ ${usd(estimate[from].monthlyUsd)} in ${from} mode, from the last ${estimate.days} days of traffic`;
}

export class ComputeChooser extends Context.Service<
  ComputeChooser,
  {
    /** Estimates every prod stage with a server, and switches those due; answers what it did. */
    readonly run: Effect.Effect<{ readonly estimated: number; readonly switched: ReadonlyArray<string> }>;
  }
>()('@ericminassian/platform-control-plane/ComputeChooser') {
  static readonly layer: Layer.Layer<
    ComputeChooser,
    never,
    Artifacts | Aws | Store | TelemetryQuery | WorkerJobs
  > = Layer.effect(
    ComputeChooser,
    Effect.gen(function* () {
      const artifacts = yield* Artifacts;
      const aws = yield* Aws;
      const jobs = yield* WorkerJobs;
      const store = yield* Store;
      const telemetry = yield* TelemetryQuery;

      /** Peak memory a Web Function environment of the stage used in the window (CloudWatch). */
      const instanceMemory = Effect.fnUntraced(function* (
        app: string,
        stage: string,
        from: number,
        to: number,
      ) {
        const period = Math.ceil((to - from) / 60_000) * 60;
        const res = yield* tryAws(() =>
          aws.cloudwatch().send(
            new GetMetricDataCommand({
              StartTime: new Date(from),
              EndTime: new Date(to),
              MetricDataQueries: [
                {
                  Id: 'memory',
                  MetricStat: {
                    Metric: {
                      Namespace: 'AWS/Lambda/Web',
                      MetricName: 'EnvironmentMaxMemoryUsage',
                      Dimensions: [{ Name: 'FunctionName', Value: names.webFunction(app, stage) }],
                    },
                    Period: period,
                    Stat: 'Maximum',
                  },
                },
              ],
            }),
          ),
        );
        const values = res.MetricDataResults?.[0]?.Values ?? [];
        return values.length ? Math.max(...values) : undefined;
      });

      /** A deployment of the live build in `to` mode, queued for the deployer. False if its build expired. */
      const switchTo = Effect.fnUntraced(function* (
        stage: StageItem,
        live: DeploymentItem,
        from: WebCompute,
        to: WebCompute,
        estimate: ComputeEstimate,
      ) {
        // A switch of a switch runs the same build: artifacts stay under the deployment that uploaded them.
        const source = live.computeSwitchOf ?? live.id;
        const ref = { app: stage.app, stage: stage.stage, deployment: source };
        const [manifest, server] = yield* Effect.all([
          artifacts.locate(ref, 'manifest.json'),
          artifacts.locate(ref, 'server.zip'),
        ]).pipe(Effect.orDie);
        if (Option.isNone(manifest) || Option.isNone(server)) {
          yield* Effect.logWarning("can't switch compute: the live deployment's build has expired").pipe(
            Effect.annotateLogs({ app: stage.app, stage: stage.stage, deployment: source }),
          );
          return false;
        }
        const id = newDeploymentId();
        yield* store.createDeployment({
          id,
          app: stage.app,
          stage: stage.stage,
          status: 'queued',
          actor: 'platform',
          ...(live.commit ? { commit: live.commit } : {}),
          ...(live.ref ? { ref: live.ref } : {}),
          message: switchMessage(from, to, estimate),
          ...(live.manifest ? { manifest: live.manifest } : {}),
          ...(live.sdk ? { sdk: live.sdk } : {}),
          compute: to,
          computeSwitchOf: source,
          events: [],
          createdAt: DateTime.formatIso(yield* DateTime.now),
        });
        yield* store.updateStage(stage.app, stage.stage, { status: 'deploying' });
        yield* jobs.start({ kind: 'deploy', id });
        yield* Effect.logInfo('switching compute').pipe(
          Effect.annotateLogs({ app: stage.app, stage: stage.stage, from, to, deployment: id }),
        );
        return true;
      });

      const choose = Effect.fnUntraced(function* (stage: StageItem, now: number) {
        const live = Option.getOrUndefined(yield* store.getDeployment(stage.currentDeployment ?? ''));
        if (!live) return false;
        if (computeSkip(stage, live)) {
          if (stage.computeEstimate || stage.computeStreak)
            yield* store.updateStage(stage.app, stage.stage, {
              computeEstimate: undefined,
              computeStreak: undefined,
            });
          return false;
        }
        const from = now - TRAFFIC_DAYS * 86_400_000;
        const traffic = yield* telemetry.stageTraffic(stage.app, stage.stage, from, now);
        const instanceMemoryMb = yield* instanceMemory(stage.app, stage.stage, from, now).pipe(
          Effect.catch((e) =>
            Effect.logWarning('could not read Web Function memory', e.message).pipe(Effect.as(undefined)),
          ),
        );
        const concurrency = yield* Effect.provideService(accountConcurrency, Aws, aws);
        const decision = decideCompute({
          stage,
          live,
          traffic,
          ...(instanceMemoryMb !== undefined ? { instanceMemoryMb } : {}),
          ...(concurrency !== undefined ? { accountConcurrency: concurrency } : {}),
          now,
        });
        if ('skip' in decision) return false;
        let switched = false;
        if (decision.switchTo)
          switched = yield* switchTo(stage, live, decision.current, decision.switchTo, decision.estimate);
        yield* store.updateStage(stage.app, stage.stage, {
          computeEstimate: decision.estimate,
          // A switch that couldn't run (its build expired) stays due, for tomorrow's run.
          computeStreak:
            decision.switchTo && !switched
              ? {
                  to: decision.switchTo,
                  days: COMPUTE_SWITCH_RULE.days,
                  day: decision.estimate.at.slice(0, 10),
                }
              : decision.streak,
        });
        return switched;
      });

      const run = Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const stages = (yield* store.listAllStages).filter(
          // A stage that is deploying gets its estimate tomorrow, so a switch never races a deploy.
          (s) => s.stage === PROD_STAGE && s.status === 'active' && s.currentDeployment,
        );
        const results = yield* Effect.forEach(
          stages,
          (s) =>
            choose(s, now).pipe(
              Effect.map((switched) => ({ stage: s, switched })),
              Effect.annotateLogs({ app: s.app, stage: s.stage }),
            ),
          { concurrency: 4 },
        );
        return {
          estimated: results.length,
          switched: results.filter((r) => r.switched).map((r) => `${r.stage.app}/${r.stage.stage}`),
        };
      }).pipe(Effect.withSpan('ComputeChooser.run'));

      return ComputeChooser.of({ run });
    }),
  );
}
