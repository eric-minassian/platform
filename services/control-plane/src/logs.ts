/**
 * Log search, live tail and traces over an app stage's CloudWatch log groups
 * (`/platform/apps/<app>/<stage>/{web,worker}`).
 */
import {
  FilterLogEventsCommand,
  GetQueryResultsCommand,
  type LiveTailSessionLogEvent,
  StartLiveTailCommand,
  StartQueryCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import { type LogLine, type LogsResponse, names, type TelemetryEvent } from '@ericminassian/platform-core';
import { BadRequest } from '@ericminassian/platform-core/platform-api';
import { absurd, Clock, Context, Effect, Layer, Schedule, Stream } from 'effect';
import { Aws, AwsError, toAwsError, tryAws } from './aws.ts';
import { Settings } from './config.ts';
import { parseLogMessage } from './telemetry/aggregate.ts';

const STREAMS = ['web', 'worker'] as const;
export type LogStream = (typeof STREAMS)[number];

/**
 * The Lambda runtime writes its own JSON records (`platform.initReport`,
 * `platform.invokeSummary` every minute for Web Functions, `platform.report`
 * for workers) into the same log group. They are kept, but summarized as
 * `system` lines so the console and CLI can hide them by default.
 */
export function runtimeRecord(message: string): string | undefined {
  if (!message.includes('"platform.')) return undefined;
  let rec: { type?: unknown; record?: Record<string, unknown> };
  try {
    rec = JSON.parse(message) as typeof rec;
  } catch {
    return undefined;
  }
  if (typeof rec.type !== 'string' || !rec.type.startsWith('platform.')) return undefined;
  const r = rec.record ?? {};
  const m = (r.metrics ?? {}) as Record<string, number | undefined>;
  const mb = m.maxMemoryUsageMb ?? m.maxMemoryUsedMB;
  const mem = mb !== undefined ? `, ${mb} MB` : '';
  switch (rec.type) {
    case 'platform.invokeSummary':
      return `runtime: ${m.requests ?? 0} requests in the last minute, ${m.cpuTimeMs ?? 0} ms CPU${mem}`;
    case 'platform.initReport': {
      const status = typeof r.status === 'string' ? ` ${r.status}` : '';
      return `runtime: init${status} in ${m.totalDurationMs ?? m.initDurationMs ?? '?'} ms${mem}`;
    }
    case 'platform.report':
      return `runtime: invocation ${m.durationMs ?? '?'} ms (billed ${m.billedDurationMs ?? '?'} ms)${mem}`;
    default:
      return `runtime: ${rec.type.slice('platform.'.length)}`;
  }
}

/** Turns one raw log message into a LogLine, unwrapping platform telemetry when present. */
export function toLogLine(stream: LogStream, timestamp: number, message: string): LogLine {
  const runtime = runtimeRecord(message);
  if (runtime) return { ts: new Date(timestamp).toISOString(), stream, level: 'system', message: runtime };
  const event = parseLogMessage(message);
  if (!event) return { ts: new Date(timestamp).toISOString(), stream, message: message.trimEnd() };
  const level =
    event.t === 'log'
      ? event.level
      : event.t === 'err'
        ? 'error'
        : event.t === 'req' && event.status >= 500
          ? 'error'
          : 'info';
  return {
    ts: new Date(event.ts || timestamp).toISOString(),
    stream,
    level,
    message: describe(event),
    ...(event.trace ? { trace: event.trace } : {}),
    event,
  };
}

/** One-line human summary of a telemetry event. */
export function describe(e: TelemetryEvent): string {
  switch (e.t) {
    case 'req':
      return `${e.method} ${e.path} ${e.status} ${e.dur}ms${e.cold ? ' (cold)' : ''}`;
    case 'err':
      return `${e.name}: ${e.message}`;
    case 'job':
      return `${e.kind} ${e.name} ${e.status} ${e.dur}ms`;
    case 'span':
      return `${e.op}${e.name ? ` ${e.name}` : ''} ${e.dur}ms ${e.status}`;
    case 'log':
      return e.msg;
    case 'metric':
      return `metric ${e.name}=${e.value}${e.unit ?? ''}`;
    case 'env':
      return `${e.runtime} environment ${e.event}${e.initMs ? ` (init ${e.initMs}ms)` : ''}`;
    default:
      return absurd(e);
  }
}

/** Plain text becomes a quoted term; `{ ... }` JSON patterns pass through. */
export function toFilterPattern(q: string | undefined): string | undefined {
  const s = q?.trim();
  if (!s) return undefined;
  if (s.startsWith('{') || s.startsWith('"') || s.startsWith('?')) return s;
  return `"${s.replace(/"/g, '\\"')}"`;
}

/** Which stream each page continues from (`next` is this, as base64url JSON). */
interface Cursor {
  web?: string;
  worker?: string;
}

/** Logs Insights query states that won't change any more. */
const FINISHED = new Set(['Complete', 'Failed', 'Cancelled', 'Timeout']);

const encodeCursor = (c: Cursor) => Buffer.from(JSON.stringify(c)).toString('base64url');
const decodeCursor = (token: string) => JSON.parse(Buffer.from(token, 'base64url').toString()) as Cursor;

export class Logs extends Context.Service<
  Logs,
  {
    /** Newest first, across the web and worker log groups. */
    search(options: {
      readonly app: string;
      readonly stage: string;
      readonly from: number;
      readonly to: number;
      readonly q?: string | undefined;
      readonly stream?: LogStream | undefined;
      readonly limit?: number | undefined;
      readonly nextToken?: string | undefined;
    }): Effect.Effect<LogsResponse, BadRequest>;
    /** New log lines as they arrive (CloudWatch Live Tail), for up to 15 minutes. */
    tail(options: {
      readonly app: string;
      readonly stage: string;
      readonly q?: string | undefined;
    }): Stream.Stream<LogLine, AwsError>;
    /** Every telemetry event carrying `trace`, oldest first (Logs Insights over web + worker). */
    trace(options: {
      readonly app: string;
      readonly stage: string;
      readonly trace: string;
      readonly from: number;
      readonly to: number;
    }): Effect.Effect<ReadonlyArray<TelemetryEvent>, BadRequest>;
  }
>()('@ericminassian/platform-control-plane/Logs') {
  static readonly layer: Layer.Layer<Logs, never, Aws | Settings> = Layer.effect(
    Logs,
    Effect.gen(function* () {
      const aws = yield* Aws;
      const settings = yield* Settings;

      const search = Effect.fn('Logs.search')(
        function* (options: {
          readonly app: string;
          readonly stage: string;
          readonly from: number;
          readonly to: number;
          readonly q?: string | undefined;
          readonly stream?: LogStream | undefined;
          readonly limit?: number | undefined;
          readonly nextToken?: string | undefined;
        }) {
          const limit = Math.min(options.limit ?? 200, 1000);
          const nextToken = options.nextToken;
          const cursor = nextToken
            ? yield* Effect.try({
                try: () => decodeCursor(nextToken),
                catch: () => BadRequest.of('invalid next token'),
              })
            : {};
          const streams = options.stream ? [options.stream] : STREAMS;
          const pattern = toFilterPattern(options.q);
          const pages = yield* Effect.forEach(
            // A continued search only reads the streams that had more.
            streams.filter((stream) => !nextToken || cursor[stream]),
            (stream) =>
              tryAws(() =>
                aws.logs().send(
                  new FilterLogEventsCommand({
                    logGroupName: names.logGroup(options.app, options.stage, stream),
                    startTime: options.from,
                    endTime: options.to,
                    limit,
                    ...(pattern ? { filterPattern: pattern } : {}),
                    ...(cursor[stream] ? { nextToken: cursor[stream] } : {}),
                  }),
                ),
              ).pipe(
                // A stage that never logged on this stream has no log group yet.
                Effect.catchIf(AwsError.is('ResourceNotFoundException'), () =>
                  Effect.succeed({ events: [], nextToken: undefined }),
                ),
                Effect.map((res) => ({ stream, res })),
              ),
            { concurrency: 'unbounded' },
          );
          const next: Cursor = {};
          const lines: LogLine[] = [];
          for (const { stream, res } of pages) {
            for (const e of res.events ?? [])
              lines.push(toLogLine(stream, e.timestamp ?? 0, e.message ?? ''));
            if (res.nextToken) next[stream] = res.nextToken;
          }
          lines.sort((a, b) => b.ts.localeCompare(a.ts));
          return {
            lines: lines.slice(0, limit),
            ...(Object.keys(next).length > 0 ? { nextToken: encodeCursor(next) } : {}),
          } satisfies LogsResponse;
        },
        Effect.catchTag('AwsError', Effect.die),
      );

      const tail = (options: {
        readonly app: string;
        readonly stage: string;
        readonly q?: string | undefined;
      }) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const { accountId, region } = yield* settings.runtime;
            const arn = (stream: LogStream) =>
              `arn:aws:logs:${region}:${accountId}:log-group:${names.logGroup(options.app, options.stage, stream)}`;
            const pattern = toFilterPattern(options.q);
            // Aborted when the stream ends: the client went away, or 15 minutes passed.
            const session = yield* Effect.acquireRelease(
              Effect.sync(() => new AbortController()),
              (controller) => Effect.sync(() => controller.abort()),
            );
            const res = yield* tryAws(() =>
              aws.logs().send(
                new StartLiveTailCommand({
                  logGroupIdentifiers: STREAMS.map(arn),
                  ...(pattern ? { logEventFilterPattern: pattern } : {}),
                }),
                { abortSignal: session.signal },
              ),
            );
            if (!res.responseStream) return Stream.empty;
            return Stream.fromAsyncIterable(res.responseStream, toAwsError).pipe(
              Stream.flatMap((event) => Stream.fromIterable(event.sessionUpdate?.sessionResults ?? [])),
              Stream.mapEffect((r: LiveTailSessionLogEvent) =>
                Effect.map(Clock.currentTimeMillis, (now) =>
                  toLogLine(
                    r.logGroupIdentifier?.endsWith('/worker') ? 'worker' : 'web',
                    r.timestamp ?? now,
                    r.message ?? '',
                  ),
                ),
              ),
            );
          }),
        ).pipe(Stream.interruptWhen(Effect.sleep('15 minutes')));

      const trace = Effect.fn('Logs.trace')(
        function* (options: {
          readonly app: string;
          readonly stage: string;
          readonly trace: string;
          readonly from: number;
          readonly to: number;
        }) {
          if (!/^[0-9a-f-]{8,64}$/i.test(options.trace)) return yield* BadRequest.of('invalid trace id');
          const start = yield* tryAws(() =>
            aws.logs().send(
              new StartQueryCommand({
                logGroupNames: STREAMS.map((s) => names.logGroup(options.app, options.stage, s)),
                startTime: Math.floor(options.from / 1000),
                endTime: Math.ceil(options.to / 1000),
                queryString: `fields @timestamp, @message | filter @message like "${options.trace}" | sort @timestamp asc | limit 1000`,
              }),
            ),
          );
          const queryId = start.queryId;
          if (!queryId) return [];
          const done = yield* tryAws(() => aws.logs().send(new GetQueryResultsCommand({ queryId }))).pipe(
            Effect.delay('750 millis'),
            Effect.repeat({ until: (res) => FINISHED.has(res.status ?? ''), schedule: Schedule.forever }),
            Effect.timeoutOrElse({
              duration: '25 seconds',
              orElse: () => BadRequest.of('trace query timed out'),
            }),
          );
          if (done.status !== 'Complete') return yield* BadRequest.of(`trace query ${done.status}`);
          const events: TelemetryEvent[] = [];
          for (const row of done.results ?? []) {
            const msg = row.find((f) => f.field === '@message')?.value;
            const e = msg ? parseLogMessage(msg) : null;
            if (e && e.trace === options.trace) events.push(e);
          }
          return events.toSorted((a, b) => a.ts - b.ts);
        },
        // Logs Insights refuses some queries (an unknown log group, a range too
        // long); the caller gets its reason.
        Effect.catchTag('AwsError', (e) => BadRequest.of(e.message)),
      );

      return Logs.of({ search, tail, trace });
    }),
  );
}
