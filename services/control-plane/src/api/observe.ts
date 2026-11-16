/**
 * Observability endpoints: metrics, routes, jobs, queues, realtime, email,
 * custom metrics, rate limits, services, errors and their occurrences,
 * uptime, cost, logs (search, stats, context, tail, Logs Insights), traces.
 */
import {
  checkSeriesQuery,
  type JobStats,
  QUERY_RESOLUTION_MS,
  QueryResolution,
  REALTIME_MEASURES,
  SERVICE_MEASURES,
  type StageCompute,
} from '@ericminassian/platform-core';
import { BadRequest, NotFound, PlatformApi } from '@ericminassian/platform-core/platform-api';
import { Cause, Clock, Effect, Option, Schema, Stream } from 'effect';
import { HttpApiBuilder } from 'effect/http-api';
import { AppEmail } from '../email.ts';
import { checkLogFilters } from '../insights.ts';
import { AppQueues } from '../jobs/queues.ts';
import { AppRealtime } from '../jobs/realtime.ts';
import { AppServices, alwaysOnCosts } from '../jobs/services.ts';
import { Logs, logGroupOf } from '../logs.ts';
import { type DeploymentItem, type StageItem, stageCompute } from '../records.ts';
import { Store } from '../store.ts';
import { parseRange, parseSeriesRange, storedHorizonMs, TelemetryQuery } from '../telemetry/query.ts';
import { Access, stageParam } from './access.ts';

interface RangeQuery {
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly range?: string | undefined;
  readonly res?: string | undefined;
}

/** `?range=`/`?from=&to=` and `?res=`, relative to now. */
const rangeOf = (query: RangeQuery, defaultRange?: string) =>
  Effect.map(Clock.currentTimeMillis, (now) =>
    parseRange({ from: query.from, to: query.to, range: query.range ?? defaultRange, res: query.res }, now),
  );

const isQueryResolution = Schema.is(QueryResolution);
const isRealtimeMeasure = (m: string | undefined): m is (typeof REALTIME_MEASURES)[number] =>
  REALTIME_MEASURES.some((x) => x === m);
const isServiceMeasure = (m: string | undefined): m is (typeof SERVICE_MEASURES)[number] =>
  SERVICE_MEASURES.some((x) => x === m);

/** A stage's server on the Cost tab: its mode and setting, and the chooser's latest estimate (pure). */
export function stageComputeCost(stage: StageItem, live: DeploymentItem | undefined): StageCompute[] {
  const web = live?.manifest?.web;
  const compute = stageCompute(stage);
  if (!web?.server || !compute) return [];
  return [
    {
      stage: stage.stage,
      setting: web.compute,
      compute,
      ...(stage.computeEstimate ? { estimate: stage.computeEstimate } : {}),
      ...(stage.computeStreak ? { streak: stage.computeStreak } : {}),
    },
  ];
}

/** Lines of context on each side of a line, by default and at most. */
const DEFAULT_CONTEXT_LINES = 50;
const MAX_CONTEXT_LINES = 200;

const contextCount = (n: number | undefined) =>
  n === undefined ? DEFAULT_CONTEXT_LINES : n >= 0 && n <= MAX_CONTEXT_LINES ? n : undefined;

/** A line's time as `logContext` takes it: epoch ms (as the console sends it) or ISO. */
export function lineTime(ts: string): number | undefined {
  const t = /^\d+$/.test(ts) ? Number(ts) : Date.parse(ts);
  return Number.isFinite(t) ? t : undefined;
}

/** What a live tail sends when it stops on an error: the reason, as the CLI and console show it. */
const tailError = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.squash(cause);
  if (error instanceof Error) return `${'code' in error ? String(error.code) : error.name}: ${error.message}`;
  return String(error);
};

export const ObserveLive = HttpApiBuilder.group(
  PlatformApi,
  'observe',
  Effect.fn(function* (handlers) {
    const access = yield* Access;
    const email = yield* AppEmail;
    const logs = yield* Logs;
    const queues = yield* AppQueues;
    const realtime = yield* AppRealtime;
    const services = yield* AppServices;
    const store = yield* Store;
    const telemetry = yield* TelemetryQuery;

    /** The app and validated stage an endpoint reads. */
    const scope = Effect.fnUntraced(function* (app: string, stage: string | undefined) {
      const found = yield* access.memberApp(app);
      return { app: found.app.name, stage: yield* stageParam(stage) };
    });

    /**
     * The app's stages that run all the time, with their live deployments:
     * not previews (they stop their services minutes after a deploy and run
     * servers in request mode), nor stages on their way out.
     */
    const liveStages = Effect.fnUntraced(function* (app: string) {
      const stages = (yield* store.listStages(app)).filter(
        (s) => !s.preview && s.status !== 'destroyed' && s.status !== 'destroying' && s.currentDeployment,
      );
      return yield* Effect.forEach(
        stages,
        Effect.fnUntraced(function* (stage) {
          const live = Option.getOrUndefined(yield* store.getDeployment(stage.currentDeployment ?? ''));
          return { stage, live };
        }),
        { concurrency: 'unbounded' },
      );
    });

    return handlers.handleAll({
      metrics: ({ params, query }) =>
        Effect.gen(function* () {
          const { app, stage } = yield* scope(params.app, query.stage);
          return yield* telemetry.metrics(app, stage, yield* rangeOf(query));
        }),

      series: ({ params, query }) =>
        Effect.gen(function* () {
          const app = (yield* access.memberApp(params.app)).app.name;
          const q = query.q;
          // The path's app is the one the caller may read; a query naming another is a mistake.
          if (q.app !== undefined && q.app !== app)
            return yield* BadRequest.of(`the query reads app ${q.app}, not ${app}`);
          if (q.stage !== undefined && query.stage !== undefined && q.stage !== query.stage)
            return yield* BadRequest.of(`the query reads stage ${q.stage}, not ${query.stage}`);
          const stage = yield* stageParam(query.stage ?? q.stage);
          const problem = checkSeriesQuery(q);
          if (problem) return yield* BadRequest.of(problem);
          if (query.res !== undefined && !isQueryResolution(query.res))
            return yield* BadRequest.of(`res is one of ${Object.keys(QUERY_RESOLUTION_MS).join(', ')}`);
          const now = yield* Clock.currentTimeMillis;
          // CloudWatch keeps minute data for 15 days, the rollups for 3.
          const cloudWatch = q.metric === 'realtime' || q.metric === 'service';
          const range = parseSeriesRange(
            query,
            query.res,
            now,
            cloudWatch ? 15 * 86_400_000 : storedHorizonMs('1m'),
          );
          const measure = q.filter?.measure;
          if (q.metric === 'realtime' && isRealtimeMeasure(measure))
            return yield* realtime.series(app, stage, measure, range);
          if (q.metric === 'service' && isServiceMeasure(measure)) {
            const declared = Object.keys(
              Option.getOrUndefined(yield* access.liveManifest(app, stage))?.services ?? {},
            );
            return yield* services.series(
              app,
              stage,
              q.filter?.names?.length ? q.filter.names : declared,
              { measure, stat: q.stat === 'max' ? 'max' : 'avg', grouped: q.groupBy === 'name' },
              range,
            );
          }
          return yield* telemetry.series(app, stage, q, range);
        }),

      routes: ({ params, query }) =>
        Effect.gen(function* () {
          const { app, stage } = yield* scope(params.app, query.stage);
          return yield* telemetry.routes(app, stage, yield* rangeOf(query));
        }),

      jobs: ({ params, query }) =>
        Effect.gen(function* () {
          const { app, stage } = yield* scope(params.app, query.stage);
          const manifest = Option.getOrUndefined(yield* access.liveManifest(app, stage));
          const declared: Array<{ kind: JobStats['kind']; name: string }> = manifest
            ? [
                ...Object.keys(manifest.queues).map((name) => ({ kind: 'queue' as const, name })),
                ...manifest.events.map((name) => ({ kind: 'event' as const, name })),
                ...Object.keys(manifest.crons).map((name) => ({ kind: 'cron' as const, name })),
              ]
            : [];
          return {
            jobs: yield* telemetry.jobs(app, stage, yield* rangeOf(query), declared),
            crons: manifest
              ? Object.entries(manifest.crons).map(([name, cron]) => ({ name, schedule: cron.schedule }))
              : [],
          };
        }),

      queues: ({ params, query }) =>
        Effect.gen(function* () {
          const { app, stage } = yield* scope(params.app, query.stage);
          const manifest = yield* access.liveManifest(app, stage);
          return yield* queues.stats(
            app,
            stage,
            Option.match(manifest, { onNone: () => [], onSome: (m) => Object.keys(m.queues) }),
          );
        }),

      deadLetters: ({ params, query }) =>
        Effect.gen(function* () {
          const { app, stage } = yield* scope(params.app, query.stage);
          return yield* queues.deadLetters(app, stage);
        }),

      services: ({ params, query }) =>
        Effect.gen(function* () {
          const { app, stage } = yield* scope(params.app, query.stage);
          const manifest = Option.getOrUndefined(yield* access.liveManifest(app, stage));
          return yield* services.stats(app, stage, manifest?.services ?? {}, yield* rangeOf(query));
        }),

      realtime: ({ params, query }) =>
        Effect.gen(function* () {
          const { app, stage } = yield* scope(params.app, query.stage);
          const manifest = Option.getOrUndefined(yield* access.liveManifest(app, stage));
          return yield* realtime.stats(app, stage, manifest?.realtime, yield* rangeOf(query));
        }),

      email: ({ params, query }) =>
        Effect.gen(function* () {
          const { app, stage } = yield* scope(params.app, query.stage);
          const manifest = Option.getOrUndefined(yield* access.liveManifest(app, stage));
          return yield* email.stats(app, stage, manifest?.email, yield* rangeOf(query));
        }),

      customMetrics: ({ params, query }) =>
        Effect.gen(function* () {
          const { app, stage } = yield* scope(params.app, query.stage);
          return yield* telemetry.customMetrics(app, stage, yield* rangeOf(query));
        }),

      limits: ({ params, query }) =>
        Effect.gen(function* () {
          const { app, stage } = yield* scope(params.app, query.stage);
          return yield* telemetry.limits(app, stage, yield* rangeOf(query));
        }),

      errors: ({ params, query }) =>
        Effect.gen(function* () {
          const { app, stage } = yield* scope(params.app, query.stage);
          const groups = yield* telemetry.errors(app, stage);
          return query.status ? groups.filter((g) => g.status === query.status) : groups;
        }),

      updateError: ({ params, query, payload }) =>
        Effect.gen(function* () {
          const { app, stage } = yield* scope(params.app, query.stage);
          const updated = yield* telemetry.setErrorStatus(app, stage, params.fingerprint, payload.status);
          if (!updated) return yield* NotFound.of(`error group ${params.fingerprint}`);
          return { status: payload.status };
        }),

      uptime: ({ params, query }) =>
        Effect.gen(function* () {
          const { app, stage } = yield* scope(params.app, query.stage);
          return yield* telemetry.uptime(app, stage, yield* rangeOf(query));
        }),

      cost: ({ params, query }) =>
        Effect.gen(function* () {
          const { app } = yield* access.memberApp(params.app);
          const [cost, live] = yield* Effect.all(
            [telemetry.cost(app.name, Math.max(1, Math.min(query.days || 35, 400))), liveStages(app.name)],
            { concurrency: 'unbounded' },
          );
          return {
            ...cost,
            alwaysOn: live.flatMap((l) => alwaysOnCosts(l.stage.stage, l.live?.manifest?.services ?? {})),
            compute: live.flatMap((l) => stageComputeCost(l.stage, l.live)),
          };
        }),

      logs: ({ params, query }) =>
        Effect.gen(function* () {
          const { app, stage } = yield* scope(params.app, query.stage);
          const range = yield* rangeOf(query);
          return yield* logs.search({
            app,
            stage,
            from: range.from,
            to: range.to,
            q: query.q,
            stream: query.stream,
            filters: query.f,
            limit: query.limit,
            nextToken: query.next,
          });
        }),

      tail: ({ params, query }) =>
        Effect.gen(function* () {
          const { app, stage } = yield* scope(params.app, query.stage);
          // Refused before the event stream opens, so a bad name is a 400 rather than an `error` event.
          for (const stream of [...(query.stream ? [query.stream] : []), ...(query.f?.streams ?? [])])
            if (!logGroupOf(app, stage, stream))
              return yield* BadRequest.of('stream must be web, worker or service:<name>');
          const problem = checkLogFilters(query.f);
          if (problem) return yield* BadRequest.of(problem);
          return logs.tail({ app, stage, q: query.q, stream: query.stream, filters: query.f }).pipe(
            Stream.map((line) => ({ event: 'line' as const, data: line })),
            // The tail ends with the reason it stopped; a client that left needs none.
            Stream.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Stream.empty
                : Stream.make({ event: 'error' as const, data: tailError(cause) }),
            ),
          );
        }),

      trace: ({ params, query }) =>
        Effect.gen(function* () {
          const { app, stage } = yield* scope(params.app, query.stage);
          const range = yield* rangeOf(query, '7d');
          const events = yield* logs.trace({
            app,
            stage,
            trace: params.trace,
            from: range.from,
            to: range.to,
          });
          return { trace: params.trace, events };
        }),

      traces: ({ params, query }) =>
        Effect.gen(function* () {
          const { app, stage } = yield* scope(params.app, query.stage);
          const range = yield* rangeOf(query);
          return yield* logs.traces({
            app,
            stage,
            from: range.from,
            to: range.to,
            filters: query.f,
            limit: query.limit,
          });
        }),

      logStats: ({ params, query }) =>
        Effect.gen(function* () {
          const { app, stage } = yield* scope(params.app, query.stage);
          const range = yield* rangeOf(query);
          return yield* logs.stats({
            app,
            stage,
            from: range.from,
            to: range.to,
            q: query.q,
            stream: query.stream,
            filters: query.f,
          });
        }),

      logContext: ({ params, query }) =>
        Effect.gen(function* () {
          const { app, stage } = yield* scope(params.app, query.stage);
          const ts = lineTime(query.ts);
          if (ts === undefined) return yield* BadRequest.of('ts must be epoch milliseconds or an ISO time');
          const before = contextCount(query.before);
          const after = contextCount(query.after);
          if (before === undefined || after === undefined)
            return yield* BadRequest.of(`before and after count lines, up to ${MAX_CONTEXT_LINES}`);
          return yield* logs.context({ app, stage, stream: query.stream, ts, before, after });
        }),

      insights: ({ params, payload }) =>
        Effect.gen(function* () {
          const { app, stage } = yield* scope(params.app, payload.stage);
          const range = yield* rangeOf(payload, '1h');
          return yield* logs.insights({ app, stage, query: payload.query, from: range.from, to: range.to });
        }),

      errorOccurrences: ({ params, query }) =>
        Effect.gen(function* () {
          const { app, stage } = yield* scope(params.app, query.stage);
          const range = yield* rangeOf(query, '7d');
          return yield* logs.errorOccurrences({
            app,
            stage,
            fingerprint: params.fingerprint,
            from: range.from,
            to: range.to,
          });
        }),
    });
  }),
);
