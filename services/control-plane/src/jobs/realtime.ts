/**
 * Realtime (AppSync Events): the daily job that keeps the public subscribe key
 * alive, and a stage's activity read from CloudWatch on demand.
 */
import type { MetricDataQuery, MetricDataResult } from '@aws-sdk/client-cloudwatch';
import {
  names,
  type RealtimePoint,
  type RealtimeStatsResponse,
  type ResolvedManifest,
} from '@ericminassian/platform-core';
import type { EngineLogEntry } from '@ericminassian/platform-engine';
import { Clock, Context, Effect, Layer, Option } from 'effect';
import { Aws } from '../aws.ts';
import { cloudWatchRange, denseSeries, readMetrics, sumQueries } from '../cloudwatch.ts';
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

      return AppRealtime.of({ stats });
    }),
  );
}
