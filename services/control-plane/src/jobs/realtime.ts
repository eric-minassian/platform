/**
 * Realtime (AppSync Events): the daily job that keeps the public subscribe key
 * alive, and a stage's activity read from CloudWatch on demand.
 */
import {
  GetMetricDataCommand,
  type MetricDataQuery,
  type MetricDataResult,
} from '@aws-sdk/client-cloudwatch';
import {
  bucketStart,
  names,
  RESOLUTION_MS,
  type RealtimePoint,
  type RealtimeStatsResponse,
  type ResolvedManifest,
  telemetryKeys,
} from '@ericminassian/platform-core';
import type { EngineLogEntry } from '@ericminassian/platform-engine';
import { Clock, Context, Effect, Layer, Option } from 'effect';
import { Aws, tryAws } from '../aws.ts';
import { Settings } from '../config.ts';
import { type DeployFailed, StageEngine } from '../deploy.ts';
import type { TimeRange } from '../telemetry/query.ts';

// ---------------------------------------------------------------- the public key

export class RealtimeKey extends Context.Service<
  RealtimeKey,
  {
    /**
     * Daily. AppSync API keys expire after at most a year and public stages'
     * browsers subscribe with one, so the engine extends it (to a year from
     * now) and rewrites the router's realtime entry. Nothing to do on a
     * platform without an Event API.
     */
    readonly run: Effect.Effect<{ readonly realtime: boolean }, DeployFailed>;
  }
>()('@ericminassian/platform-control-plane/RealtimeKey') {
  static readonly layer: Layer.Layer<RealtimeKey, never, Settings | StageEngine> = Layer.effect(
    RealtimeKey,
    Effect.gen(function* () {
      const settings = yield* Settings;
      const engine = yield* StageEngine;

      const run = Effect.gen(function* () {
        const runtime = yield* settings.runtime;
        if (!runtime.realtime) {
          yield* Effect.logInfo('the platform has no Event API; no realtime key to keep');
          return { realtime: false };
        }
        // The engine reports progress through a synchronous callback; log it once it's done.
        const entries: EngineLogEntry[] = [];
        const entry = yield* engine
          .ensureRealtime(runtime, (e) => entries.push(e))
          .pipe(Effect.ensuring(Effect.forEach(entries, logEngineEntry, { discard: true })));
        return { realtime: Option.isSome(entry) };
      }).pipe(Effect.withSpan('RealtimeKey.run'));

      return RealtimeKey.of({ run });
    }),
  );
}

const logEngineEntry = (e: EngineLogEntry) =>
  e.level === 'error'
    ? Effect.logError(e.msg)
    : e.level === 'warn'
      ? Effect.logWarning(e.msg)
      : Effect.logInfo(e.msg);

// ---------------------------------------------------------------- activity

/**
 * The per-namespace AppSync metrics, and the series each adds to. AppSync
 * reports deliveries (`OutboundMessages`) and connections only for the whole
 * Event API, so how many browsers an app reaches can't be shown per app.
 */
export const REALTIME_METRICS: ReadonlyArray<readonly [keyof Omit<RealtimePoint, 'ts'>, string]> = [
  ['events', 'InboundMessages'],
  ['publishes', 'PublishSuccess'],
  ['subscribes', 'SubscribeSuccess'],
  ['errors', 'PublishClientError'],
  ['errors', 'SubscribeClientError'],
  ['errors', 'PublishServerError'],
  ['errors', 'SubscribeServerError'],
];

/**
 * CloudWatch keeps 1-minute data for 15 days, so a range reaching further
 * back is read hourly.
 */
export function cloudWatchRange(range: TimeRange, now: number): TimeRange {
  return range.res === '1m' && range.from < now - 15 * 86_400_000 ? { ...range, res: '1h' } : range;
}

/** One `Sum` query per metric, ids `m<index into REALTIME_METRICS>`. */
export function realtimeQueries(apiId: string, namespace: string, range: TimeRange): MetricDataQuery[] {
  return REALTIME_METRICS.map(([, metric], i) => ({
    Id: `m${i}`,
    MetricStat: {
      Metric: {
        Namespace: 'AWS/AppSync',
        MetricName: metric,
        Dimensions: [
          { Name: 'EventAPIId', Value: apiId },
          { Name: 'ChannelNamespaceName', Value: namespace },
        ],
      },
      Period: RESOLUTION_MS[range.res] / 1000,
      Stat: 'Sum',
    },
  }));
}

/** Dense series (one zero-filled point per bucket in range) and totals (pure). */
export function toRealtimeSeries(
  results: ReadonlyArray<MetricDataResult>,
  range: TimeRange,
): Pick<RealtimeStatsResponse, 'points' | 'totals'> {
  type Counts = { -readonly [K in keyof RealtimePoint]: RealtimePoint[K] };
  const step = RESOLUTION_MS[range.res];
  const byBucket = new Map<number, Counts>();
  const points: Counts[] = [];
  const end = bucketStart(range.to, range.res);
  for (let t = bucketStart(range.from, range.res); t <= end && points.length < 2000; t += step) {
    const point = { ts: telemetryKeys.time(t), events: 0, publishes: 0, subscribes: 0, errors: 0 };
    byBucket.set(t, point);
    points.push(point);
  }
  for (const r of results) {
    const series = REALTIME_METRICS[Number(r.Id?.slice(1))]?.[0];
    if (!series) continue;
    (r.Timestamps ?? []).forEach((when, i) => {
      const point = byBucket.get(bucketStart(new Date(when).getTime(), range.res));
      if (point) point[series] += r.Values?.[i] ?? 0;
    });
  }
  const totals = { events: 0, publishes: 0, subscribes: 0, errors: 0 };
  for (const p of points) {
    totals.events += p.events;
    totals.publishes += p.publishes;
    totals.subscribes += p.subscribes;
    totals.errors += p.errors;
  }
  return { points, totals };
}

export class AppRealtime extends Context.Service<
  AppRealtime,
  {
    /** The stage's publishes, subscribes and errors over `range`; `enabled: false` without `realtime`. */
    stats(
      app: string,
      stage: string,
      realtime: ResolvedManifest['realtime'],
      range: TimeRange,
    ): Effect.Effect<RealtimeStatsResponse>;
  }
>()('@ericminassian/platform-control-plane/AppRealtime') {
  static readonly layer: Layer.Layer<AppRealtime, never, Aws | Settings> = Layer.effect(
    AppRealtime,
    Effect.gen(function* () {
      const aws = yield* Aws;
      const settings = yield* Settings;

      const stats = Effect.fn('AppRealtime.stats')(function* (
        app: string,
        stage: string,
        realtime: ResolvedManifest['realtime'],
        requested: TimeRange,
      ) {
        const range = cloudWatchRange(requested, yield* Clock.currentTimeMillis);
        const { realtime: api } = yield* settings.runtime;
        if (!realtime || !api) {
          return {
            app,
            stage,
            enabled: false,
            channels: [],
            res: range.res,
            ...toRealtimeSeries([], range),
          } satisfies RealtimeStatsResponse;
        }
        const step = RESOLUTION_MS[range.res];
        const queries = realtimeQueries(api.apiId, names.realtimeNamespace(app, stage), range);
        // Usually one page: 7 metrics × at most 2,000 points stays under the 100,800 per call.
        const results: MetricDataResult[] = [];
        let NextToken: string | undefined;
        do {
          const res = yield* tryAws(() =>
            aws.cloudwatch().send(
              new GetMetricDataCommand({
                MetricDataQueries: queries,
                // Bucket-aligned, so CloudWatch's period boundaries match the series'.
                StartTime: new Date(bucketStart(range.from, range.res)),
                EndTime: new Date(bucketStart(range.to, range.res) + step),
                ScanBy: 'TimestampAscending',
                NextToken,
              }),
            ),
          ).pipe(Effect.orDie);
          results.push(...(res.MetricDataResults ?? []));
          NextToken = res.NextToken;
        } while (NextToken);
        return {
          app,
          stage,
          enabled: true,
          subscribe: realtime.subscribe,
          channels: realtime.channels,
          res: range.res,
          ...toRealtimeSeries(results, range),
        } satisfies RealtimeStatsResponse;
      });

      return AppRealtime.of({ stats });
    }),
  );
}
