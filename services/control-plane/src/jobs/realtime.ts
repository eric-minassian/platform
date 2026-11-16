/**
 * Realtime (AppSync Events): the daily job that keeps the public subscribe key
 * alive, and a stage's activity read from CloudWatch on demand.
 */
import type { MetricDataQuery, MetricDataResult } from '@aws-sdk/client-cloudwatch';
import {
  names,
  REALTIME_MEASURES,
  type RealtimePoint,
  type RealtimeStatsResponse,
  type ResolvedManifest,
  type SeriesResponse,
  seriesUnit,
  telemetryKeys,
} from '@ericminassian/platform-core';
import type { EngineLogEntry } from '@ericminassian/platform-engine';
import { Clock, Context, Effect, Layer, Option } from 'effect';
import { Aws } from '../aws.ts';
import {
  cloudWatchRange,
  cloudWatchSeriesRes,
  denseSeries,
  readMetrics,
  readMetricsBetween,
  sumQueries,
} from '../cloudwatch.ts';
import { Settings } from '../config.ts';
import { type DeployFailed, StageEngine } from '../deploy.ts';
import { ALL_SERIES, type SeriesRange, seriesBuckets, type TimeRange } from '../telemetry/query.ts';

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

/** One `Sum` query per metric, ids `m<index into REALTIME_METRICS>`. */
export function realtimeQueries(apiId: string, namespace: string, range: TimeRange): MetricDataQuery[] {
  return sumQueries(
    'AWS/AppSync',
    REALTIME_METRICS.map(([, metric]) => metric),
    [
      { Name: 'EventAPIId', Value: apiId },
      { Name: 'ChannelNamespaceName', Value: namespace },
    ],
    range,
  );
}

/** Dense series (one zero-filled point per bucket in range) and totals (pure). */
export function toRealtimeSeries(
  results: ReadonlyArray<MetricDataResult>,
  range: TimeRange,
): Pick<RealtimeStatsResponse, 'points' | 'totals'> {
  return denseSeries(
    results,
    range,
    REALTIME_METRICS.map(([series]) => series),
  );
}

/** A realtime measure as the explorer charts it: `events`, `publishes`, `subscribes` or `errors`. */
export type RealtimeMeasure = (typeof REALTIME_MEASURES)[number];

/** One `Sum` query per AppSync metric behind `measure`, one period per bucket, ids `m<i>`. */
export function realtimeSeriesQueries(
  apiId: string,
  namespace: string,
  measure: RealtimeMeasure,
  periodSeconds: number,
): MetricDataQuery[] {
  return REALTIME_METRICS.filter(([series]) => series === measure).map(([, metric], i) => ({
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
      Period: periodSeconds,
      Stat: 'Sum',
    },
  }));
}

/** A realtime measure's sums per bucket, every metric behind it added and 0 where CloudWatch has none (pure). */
export function toRealtimeSeriesResponse(
  results: ReadonlyArray<MetricDataResult>,
  range: SeriesRange,
  note?: string,
): SeriesResponse {
  const { times, slot, step } = seriesBuckets(range);
  const values = times.map(() => 0);
  for (const r of results) {
    (r.Timestamps ?? []).forEach((when, i) => {
      const index = slot.get(Math.floor(new Date(when).getTime() / step) * step);
      if (index !== undefined) values[index]! += r.Values?.[i] ?? 0;
    });
  }
  return {
    res: range.res,
    timestamps: times.map((t) => telemetryKeys.time(t)),
    unit: seriesUnit({ metric: 'realtime', stat: 'sum' }),
    series: [{ key: ALL_SERIES, values }],
    ...(note ? { note } : {}),
  };
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
    /** One measure of the stage's activity over `range`, for the explorer: zeros without an Event API. */
    series(
      app: string,
      stage: string,
      measure: RealtimeMeasure,
      range: SeriesRange,
    ): Effect.Effect<SeriesResponse>;
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
        const results = yield* readMetrics(
          aws,
          realtimeQueries(api.apiId, names.realtimeNamespace(app, stage), range),
          range,
        ).pipe(Effect.orDie);
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

      const series = Effect.fn('AppRealtime.series')(function* (
        app: string,
        stage: string,
        measure: RealtimeMeasure,
        requested: SeriesRange,
      ) {
        const cw = cloudWatchSeriesRes(requested.res, requested.from, yield* Clock.currentTimeMillis);
        const range = { ...requested, res: cw.res };
        const { realtime: api } = yield* settings.runtime;
        const { times, step } = seriesBuckets(range);
        const first = times[0];
        const last = times.at(-1);
        if (!api || first === undefined || last === undefined)
          return toRealtimeSeriesResponse([], range, cw.note);
        const queries = realtimeSeriesQueries(
          api.apiId,
          names.realtimeNamespace(app, stage),
          measure,
          step / 1000,
        );
        const results = yield* readMetricsBetween(aws, queries, first, last + step).pipe(Effect.orDie);
        return toRealtimeSeriesResponse(results, range, cw.note);
      });

      return AppRealtime.of({ stats, series });
    }),
  );
}
