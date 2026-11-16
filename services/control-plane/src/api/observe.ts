/**
 * Observability endpoints: metrics, routes, jobs, queues, realtime, email,
 * custom metrics, rate limits, services, errors, uptime, cost, logs, traces.
 */
import type { AlwaysOnCost, JobStats } from '@ericminassian/platform-core';
import { BadRequest, NotFound, PlatformApi } from '@ericminassian/platform-core/platform-api';
import { Cause, Clock, Effect, Option, Stream } from 'effect';
import { HttpApiBuilder } from 'effect/http-api';
import { AppEmail } from '../email.ts';
import { AppQueues } from '../jobs/queues.ts';
import { AppRealtime } from '../jobs/realtime.ts';
import { AppServices, alwaysOnCosts } from '../jobs/services.ts';
import { Logs, logGroupOf } from '../logs.ts';
import { Store } from '../store.ts';
import { parseRange, TelemetryQuery } from '../telemetry/query.ts';
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
     * The services of the app's stages that run them all the time: not
     * previews (they stop theirs minutes after a deploy), nor stages on their
     * way out.
     */
    const alwaysOn = Effect.fnUntraced(function* (app: string) {
      const stages = (yield* store.listStages(app)).filter(
        (s) => !s.preview && s.status !== 'destroyed' && s.status !== 'destroying' && s.currentDeployment,
      );
      const costs = yield* Effect.forEach(
        stages,
        Effect.fnUntraced(function* (s) {
          const live = Option.getOrUndefined(yield* store.getDeployment(s.currentDeployment ?? ''));
          return alwaysOnCosts(s.stage, live?.manifest?.services ?? {});
        }),
        { concurrency: 'unbounded' },
      );
      return costs.flat() satisfies AlwaysOnCost[];
    });

    return handlers.handleAll({
      metrics: ({ params, query }) =>
        Effect.gen(function* () {
          const { app, stage } = yield* scope(params.app, query.stage);
          return yield* telemetry.metrics(app, stage, yield* rangeOf(query));
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
          const [cost, running] = yield* Effect.all(
            [telemetry.cost(app.name, Math.max(1, Math.min(query.days || 35, 400))), alwaysOn(app.name)],
            { concurrency: 'unbounded' },
          );
          return { ...cost, alwaysOn: running };
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
            limit: query.limit,
            nextToken: query.next,
          });
        }),

      tail: ({ params, query }) =>
        Effect.gen(function* () {
          const { app, stage } = yield* scope(params.app, query.stage);
          // Refused before the event stream opens, so a bad name is a 400 rather than an `error` event.
          if (query.stream && !logGroupOf(app, stage, query.stream))
            return yield* BadRequest.of('stream must be web, worker or service:<name>');
          return logs.tail({ app, stage, q: query.q, stream: query.stream }).pipe(
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
    });
  }),
);
