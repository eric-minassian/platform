/** Observability endpoints: metrics, routes, jobs, queues, errors, uptime, cost, logs, traces. */
import type { JobStats } from '@ericminassian/platform-core';
import { NotFound, PlatformApi } from '@ericminassian/platform-core/platform-api';
import { Cause, Clock, Effect, Option, Stream } from 'effect';
import { HttpApiBuilder } from 'effect/http-api';
import { AppQueues } from '../jobs/queues.ts';
import { Logs } from '../logs.ts';
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
    const logs = yield* Logs;
    const queues = yield* AppQueues;
    const telemetry = yield* TelemetryQuery;

    /** The app and validated stage an endpoint reads. */
    const scope = Effect.fnUntraced(function* (app: string, stage: string | undefined) {
      const found = yield* access.memberApp(app);
      return { app: found.app.name, stage: yield* stageParam(stage) };
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
          return yield* telemetry.cost(app.name, Math.max(1, Math.min(query.days || 35, 400)));
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
          return logs.tail({ app, stage, q: query.q }).pipe(
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
