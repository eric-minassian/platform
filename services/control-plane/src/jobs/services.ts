/**
 * A stage's long-running services (ECS on Fargate): what ECS reports, CPU and
 * memory from CloudWatch, container starts and failed runs from telemetry,
 * and start, stop and restart. The engine calls behind them are plain ECS and
 * Scheduler calls, so unlike KVS writes (jobs/call.ts) they run in the API.
 */
import type { MetricDataResult } from '@aws-sdk/client-cloudwatch';
import {
  type AlwaysOnCost,
  bucketStart,
  type ContainersRuntimeConfig,
  describeContainerSize,
  estimateContainerCost,
  names,
  RESOLUTION_MS,
  type ResolvedManifest,
  type ServiceActionResponse,
  type ServiceInfo,
  type ServiceState,
  type ServicesResponse,
  telemetryKeys,
} from '@ericminassian/platform-core';
import type { ServiceRuntimeState } from '@ericminassian/platform-engine';
import { Clock, Context, Effect, Layer, Schema } from 'effect';
import { Aws } from '../aws.ts';
import { cloudWatchRange, readMetrics } from '../cloudwatch.ts';
import { Settings } from '../config.ts';
import { StageEngine } from '../deploy.ts';
import { type ServiceRuns, TelemetryQuery, type TimeRange } from '../telemetry/query.ts';

type ServiceConfig = ResolvedManifest['services'][string];
type UsagePoint = ServiceInfo['points'][number];

/** ECS or Scheduler refused a start, stop or restart; `message` is the engine's reason. */
export class ServiceActionFailed extends Schema.TaggedError<
  ServiceActionFailed,
  { readonly brand: unique symbol }
>()('ServiceActionFailed', { message: Schema.String }) {}

/**
 * The stage declares the service but ECS has none to act on: its deploy
 * hasn't created it (or the platform has no container compute).
 */
export class ServiceMissing extends Schema.TaggedError<ServiceMissing, { readonly brand: unique symbol }>()(
  'ServiceMissing',
  { message: Schema.String },
) {}

/** How long after a task stopped on a failure a service still short of tasks counts as failing. */
export const FAILING_WINDOW_MS = 15 * 60_000;

/**
 * Stops someone or something asked for: a deploy or restart replacing the
 * task, a scale-down, Spot reclaiming its capacity, Fargate retiring the host.
 */
const REQUESTED_STOP =
  /scaling activity|stopped by user|user ?initiated|spot (task was )?interrupt|termination ?notice|being retired/i;

/** Whether a task stopped because the service failed: it exited non-zero, or never got to run. */
export function stoppedOnFailure(stop: { readonly reason: string; readonly exitCode?: number }): boolean {
  if (REQUESTED_STOP.test(stop.reason)) return false;
  return stop.exitCode !== 0;
}

/** The state the console and CLI show for a service, from what ECS reports (pure). */
export function serviceState(service: ServiceRuntimeState | undefined, now: number): ServiceState {
  // Declared but unknown to ECS: the platform has no container compute, or the
  // ECS service was removed outside a deploy. Nothing starts it before the
  // next deploy, so it is stopped rather than starting.
  if (!service || service.desired === 0) return 'stopped';
  if (service.rollout === 'failed') return 'failing';
  const { lastStop } = service;
  if (
    service.running < service.desired &&
    lastStop &&
    stoppedOnFailure(lastStop) &&
    now - Date.parse(lastStop.at) < FAILING_WINDOW_MS
  )
    return 'failing';
  // ECS reports no rollout for some deployment setups; then the task count decides.
  if (service.running >= service.desired && service.rollout !== 'in_progress') return 'running';
  return 'starting';
}

/** One service's row (pure): its declared size, ECS state, usage, starts and failed runs. */
export function toServiceInfo(input: {
  readonly name: string;
  readonly config: ServiceConfig;
  readonly runtime: ServiceRuntimeState | undefined;
  readonly points: ReadonlyArray<UsagePoint>;
  readonly runs: ServiceRuns | undefined;
  readonly now: number;
}): ServiceInfo {
  const { name, config, runtime: ecs } = input;
  return {
    name,
    cpu: config.cpu,
    memoryMb: config.memoryMb,
    spot: config.spot,
    state: serviceState(ecs, input.now),
    desired: ecs?.desired ?? 0,
    running: ecs?.running ?? 0,
    pending: ecs?.pending ?? 0,
    ...(ecs?.deploymentId ? { deployment: ecs.deploymentId } : {}),
    ...(ecs?.startedAt ? { startedAt: ecs.startedAt } : {}),
    ...(ecs?.stopsAt ? { stopsAt: ecs.stopsAt } : {}),
    ...(ecs?.lastStop ? { lastStop: ecs.lastStop } : {}),
    events: ecs?.events ?? [],
    starts: input.runs?.starts ?? 0,
    failedRuns: input.runs?.failedRuns ?? 0,
    points: [...input.points],
    monthly: estimateContainerCost(config),
  };
}

/** What each of a stage's services costs a month if it runs all month (pure). */
export function alwaysOnCosts(stage: string, services: ResolvedManifest['services']): AlwaysOnCost[] {
  return Object.entries(services).map(([name, config]) => ({
    stage,
    kind: 'service',
    name,
    detail: describeContainerSize(config),
    monthly: estimateContainerCost(config),
  }));
}

/**
 * ECS's free per-service metrics (`AWS/ECS`, no Container Insights), both as
 * a percentage of the task's size: ids `c<i>` (CPU) and `m<i>` (memory) for
 * the `i`th service.
 */
export function usageQueries(
  cluster: string,
  app: string,
  stage: string,
  services: ReadonlyArray<string>,
  range: TimeRange,
) {
  return services.flatMap((key, i) =>
    (
      [
        ['c', 'CPUUtilization'],
        ['m', 'MemoryUtilization'],
      ] as const
    ).map(([prefix, metric]) => ({
      Id: `${prefix}${i}`,
      MetricStat: {
        Metric: {
          Namespace: 'AWS/ECS',
          MetricName: metric,
          Dimensions: [
            { Name: 'ClusterName', Value: cluster },
            { Name: 'ServiceName', Value: names.service(app, stage, key) },
          ],
        },
        Period: RESOLUTION_MS[range.res] / 1000,
        Stat: 'Average',
      },
    })),
  );
}

/** Dense CPU and memory series per service, null where CloudWatch has no datapoint (pure). */
export function toUsagePoints(
  results: ReadonlyArray<MetricDataResult>,
  services: ReadonlyArray<string>,
  range: TimeRange,
): Map<string, UsagePoint[]> {
  const step = RESOLUTION_MS[range.res];
  const end = bucketStart(range.to, range.res);
  const buckets: number[] = [];
  for (let t = bucketStart(range.from, range.res); t <= end && buckets.length < 2000; t += step)
    buckets.push(t);
  const series = services.map(() => ({ cpu: new Map<number, number>(), memory: new Map<number, number>() }));
  for (const r of results) {
    const target = series[Number(r.Id?.slice(1))];
    if (!target) continue;
    const values = r.Id?.startsWith('c') ? target.cpu : target.memory;
    (r.Timestamps ?? []).forEach((when, i) => {
      const value = r.Values?.[i];
      if (value !== undefined)
        values.set(bucketStart(new Date(when).getTime(), range.res), Math.round(value * 10) / 10);
    });
  }
  return new Map(
    services.map((key, i) => {
      const { cpu, memory } = series[i]!;
      return [
        key,
        buckets.map((t) => ({
          ts: telemetryKeys.time(t),
          cpu: cpu.get(t) ?? null,
          memory: memory.get(t) ?? null,
        })),
      ];
    }),
  );
}

export class AppServices extends Context.Service<
  AppServices,
  {
    /** Each service the live deployment declares, as ECS runs it, with its usage over `range`. */
    stats(
      app: string,
      stage: string,
      declared: ResolvedManifest['services'],
      range: TimeRange,
    ): Effect.Effect<ServicesResponse>;
    /** Starts (stopping again after `minutes`, when given), stops or restarts one service. */
    control(input: {
      readonly app: string;
      readonly stage: string;
      readonly name: string;
      readonly action: 'start' | 'stop' | 'restart';
      readonly minutes?: number | undefined;
    }): Effect.Effect<ServiceActionResponse, ServiceActionFailed | ServiceMissing>;
  }
>()('@ericminassian/platform-control-plane/AppServices') {
  static readonly layer: Layer.Layer<AppServices, never, Aws | Settings | StageEngine | TelemetryQuery> =
    Layer.effect(
      AppServices,
      Effect.gen(function* () {
        const aws = yield* Aws;
        const settings = yield* Settings;
        const engine = yield* StageEngine;
        const telemetry = yield* TelemetryQuery;

        /**
         * One GetMetricData call ($0.01 per 1,000 metrics) covers every
         * service, and only runs when someone looks. The chart is secondary
         * to the service's state, so a failed read leaves it empty.
         */
        const usage = Effect.fnUntraced(
          function* (
            containers: ContainersRuntimeConfig | undefined,
            app: string,
            stage: string,
            services: ReadonlyArray<string>,
            range: TimeRange,
          ) {
            if (!containers) return toUsagePoints([], services, range);
            const queries = usageQueries(containers.cluster, app, stage, services, range);
            return toUsagePoints(yield* readMetrics(aws, queries, range), services, range);
          },
          (effect, _containers, _app, _stage, services, range) =>
            Effect.catchTag(effect, 'AwsError', (error) =>
              Effect.logWarning('reading service metrics failed').pipe(
                Effect.annotateLogs({ code: error.code, err: error.message }),
                Effect.as(toUsagePoints([], services, range)),
              ),
            ),
        );

        const stats = Effect.fn('AppServices.stats')(function* (
          app: string,
          stage: string,
          declared: ResolvedManifest['services'],
          requested: TimeRange,
        ) {
          const now = yield* Clock.currentTimeMillis;
          const range = cloudWatchRange(requested, now);
          const keys = Object.keys(declared);
          if (keys.length === 0)
            return { app, stage, res: range.res, services: [] } satisfies ServicesResponse;
          const platform = yield* settings.runtime;
          const [running, points, runs] = yield* Effect.all(
            [
              engine.describeServices({ app, stage, platform }).pipe(Effect.orDie),
              usage(platform.containers, app, stage, keys, range),
              telemetry.serviceRuns(app, stage, requested),
            ],
            { concurrency: 'unbounded' },
          );
          return {
            app,
            stage,
            res: range.res,
            services: Object.entries(declared).map(([name, config]) =>
              toServiceInfo({
                name,
                config,
                runtime: running.find((s) => s.name === name),
                points: points.get(name) ?? [],
                runs: runs.get(name),
                now,
              }),
            ),
          } satisfies ServicesResponse;
        });

        const control = Effect.fn('AppServices.control')(function* (input: {
          readonly app: string;
          readonly stage: string;
          readonly name: string;
          readonly action: 'start' | 'stop' | 'restart';
          readonly minutes?: number | undefined;
        }) {
          const platform = yield* settings.runtime;
          const { desired, stopsAt } = yield* engine
            .controlService({
              app: input.app,
              stage: input.stage,
              platform,
              name: input.name,
              action: input.action,
              ...(input.minutes !== undefined ? { minutes: input.minutes } : {}),
            })
            .pipe(
              Effect.mapError((e) =>
                // The engine's `ServiceNotFoundError`, which `DeployFailed` keeps as its cause.
                (e.cause as { name?: unknown } | undefined)?.name === 'ServiceNotFoundError'
                  ? new ServiceMissing({ message: e.message })
                  : new ServiceActionFailed({ message: e.message }),
              ),
            );
          return {
            name: input.name,
            desired,
            ...(stopsAt ? { stopsAt } : {}),
          } satisfies ServiceActionResponse;
        });

        return AppServices.of({ stats, control });
      }),
    );
}
