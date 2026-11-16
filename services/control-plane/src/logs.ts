/**
 * Log search, stats, context, live tail, traces and Logs Insights over an app
 * stage's CloudWatch log groups (`/platform/apps/<app>/<stage>/{web,worker}`,
 * and `services/<name>` for each long-running service). The Insights queries
 * themselves are built in insights.ts.
 */
import {
  DescribeLogGroupsCommand,
  type FilteredLogEvent,
  FilterLogEventsCommand,
  GetQueryResultsCommand,
  type GetQueryResultsCommandOutput,
  type LiveTailSessionLogEvent,
  StartLiveTailCommand,
  StartQueryCommand,
  StopQueryCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import {
  autoQueryResolution,
  type ErrorOccurrencesResponse,
  type InsightsResponse,
  type LogContextResponse,
  type LogFilters,
  type LogLine,
  type LogStatsResponse,
  type LogStream,
  type LogsResponse,
  names,
  RESOURCE_KEY_PATTERN,
  type TelemetryEvent,
  type TraceFilters,
  type TracesResponse,
} from '@ericminassian/platform-core';
import { BadRequest, NotFound } from '@ericminassian/platform-core/platform-api';
import { absurd, Clock, Context, Effect, Layer, Schedule, Schema, Stream } from 'effect';
import { Aws, AwsError, toAwsError, tryAws } from './aws.ts';
import { Settings } from './config.ts';
import {
  checkLogFilters,
  checkTraceFilters,
  checkUserQuery,
  contextLines,
  decodeInsightsCursor,
  encodeInsightsCursor,
  FINGERPRINT_PATTERN,
  fetchCount,
  hasStructuredFilters,
  insightsTime,
  logStatsOf,
  matchesLogFilters,
  occurrencesOf,
  occurrencesQueries,
  pageRows,
  type Row,
  resultTable,
  rowKey,
  searchQuery,
  searchTerms,
  statsQueries,
  str,
  TRACE_ID_PATTERN,
  telemetryLevel,
  traceSummary,
  tracesQuery,
} from './insights.ts';
import { parseLogMessage } from './telemetry/aggregate.ts';

const SERVICE_STREAM = 'service:';

/** The log group a stream is read from; none for a name that isn't one of the stage's streams. */
export function logGroupOf(app: string, stage: string, stream: LogStream): string | undefined {
  if (stream === 'web' || stream === 'worker') return names.logGroup(app, stage, stream);
  if (!stream.startsWith(SERVICE_STREAM)) return undefined;
  const key = stream.slice(SERVICE_STREAM.length);
  return RESOURCE_KEY_PATTERN.test(key) ? names.serviceLogGroup(app, stage, key) : undefined;
}

/** The stream a log group belongs to, from its name or ARN (Live Tail reports either; Logs Insights' `@log` is `<account>:<name>`). */
export function streamOfLogGroup(group: string): LogStream {
  const service = /\/services\/([^/:]+)(?::\*)?$/.exec(group);
  if (service) return `${SERVICE_STREAM}${service[1]}`;
  return /\/worker(?::\*)?$/.test(group) ? 'worker' : 'web';
}

/**
 * The stream of a log group under the stage's prefix (the rest of its name):
 * `web`, `worker` or `services/<name>`. `web.local` (Web Function
 * environments) and anything else is none.
 */
function streamUnderStage(rest: string): LogStream | undefined {
  if (rest === 'web' || rest === 'worker') return rest;
  if (!rest.startsWith('services/')) return undefined;
  const key = rest.slice('services/'.length);
  return RESOURCE_KEY_PATTERN.test(key) ? `${SERVICE_STREAM}${key}` : undefined;
}

/** The streams a search reads: those both `stream` and `filters.streams` allow (undefined: every one). */
export function selectedStreams(
  stream: LogStream | undefined,
  filters: LogFilters | undefined,
): ReadonlyArray<LogStream> | undefined {
  const listed = filters?.streams?.length ? [...new Set(filters.streams)] : undefined;
  if (stream === undefined) return listed;
  if (!listed) return [stream];
  return listed.includes(stream) ? [stream] : [];
}

/** Live Tail follows at most 10 log groups per session. */
const LIVE_TAIL_MAX_GROUPS = 10;

/**
 * The Lambda runtime writes its own JSON records (`platform.initReport`,
 * `platform.invokeSummary` every minute for Web Functions, `platform.report`
 * for workers) into the same log group. They are kept, but summarized as
 * `system` lines so the console and CLI can hide them by default. An SDK
 * line (`_p`) is never one, whatever fields it was logged with.
 */
export function runtimeRecord(message: string): string | undefined {
  if (!message.includes('"platform.')) return undefined;
  let rec: { type?: unknown; record?: Record<string, unknown>; _p?: unknown };
  try {
    rec = JSON.parse(message) as typeof rec;
  } catch {
    return undefined;
  }
  if (typeof rec.type !== 'string' || !rec.type.startsWith('platform.') || rec._p !== undefined)
    return undefined;
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

/**
 * Turns one raw log message into a LogLine, unwrapping platform telemetry
 * when present. Its level is what log filters select (`LEVEL_CONDITIONS`).
 */
export function toLogLine(stream: LogStream, timestamp: number, message: string): LogLine {
  const runtime = runtimeRecord(message);
  if (runtime) return { ts: new Date(timestamp).toISOString(), stream, level: 'system', message: runtime };
  const event = parseLogMessage(message);
  if (!event) return { ts: new Date(timestamp).toISOString(), stream, message: message.trimEnd() };
  return {
    ts: new Date(event.ts || timestamp).toISOString(),
    stream,
    level: telemetryLevel(event),
    message: describe(event),
    ...(event.trace ? { trace: event.trace } : {}),
    event,
  };
}

/** One-line human summary of a telemetry event. */
export function describe(e: TelemetryEvent): string {
  switch (e.t) {
    case 'req':
      return `${e.method} ${e.path ?? e.route} ${e.status} ${e.dur}ms${e.cold ? ' (cold)' : ''}`;
    case 'err':
      return `${e.name}: ${e.message}`;
    case 'job':
      return `${e.kind} ${e.name} ${e.status} ${e.dur}ms`;
    case 'span':
      return `${e.op}${e.name ? ` ${e.name}` : ''} ${e.dur}ms ${e.status}`;
    case 'log':
      return e.msg;
    case 'metric':
      return `metric ${e.name}=${e.value}${e.unit ? ` ${e.unit}` : ''}`;
    case 'limit':
      return `limit ${e.name} ${e.ok ? 'ok' : 'over'}`;
    case 'env':
      return e.runtime === 'service'
        ? `service ${e.name ?? ''} container ${e.event}${e.reason ? ` (${e.reason})` : ''}`
        : `${e.runtime} environment ${e.event}${e.initMs ? ` (init ${e.initMs}ms)` : ''}`;
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

/** Each stream's token for the next page of a filter pattern search (`next` is this, as base64url JSON). */
const Cursor = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String));
type Cursor = typeof Cursor.Type;

const encodeCursor = (c: Cursor) => Buffer.from(JSON.stringify(c)).toString('base64url');
const decodeCursor = Schema.decodeUnknownEffect(Cursor);

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/** A log event as FilterLogEvents returns it, with its time. */
export interface TimedEvent {
  readonly timestamp: number;
  readonly message: string;
}

/**
 * Reads up to `cap` events of one log group in `[start, end)`, oldest first;
 * `complete` when those were all of them.
 */
export type WindowReader<E> = (
  start: number,
  end: number,
  cap: number,
) => Effect.Effect<{ readonly events: ReadonlyArray<TimedEvent>; readonly complete: boolean }, E>;

/** How far back context looks before a line: windows ever further from it, nearest first. */
export const CONTEXT_WINDOWS_MS = [60_000, 600_000, 3_600_000, 6 * 3_600_000, 24 * 3_600_000] as const;
/** How many events one read of a window may take before it is split. */
export const CONTEXT_READ_CAP = 1_000;

/**
 * The last `n` events before `end`, oldest first. FilterLogEvents only reads
 * forward, so it reads widening windows back from `end` (`CONTEXT_WINDOWS_MS`)
 * until it has `n`, and a window too busy to read in one go
 * (`CONTEXT_READ_CAP`) is split in halves, later half first.
 */
export const lastEventsBefore = <E>(
  read: WindowReader<E>,
  end: number,
  n: number,
): Effect.Effect<ReadonlyArray<TimedEvent>, E> => {
  const lastIn = (lo: number, hi: number, k: number): Effect.Effect<ReadonlyArray<TimedEvent>, E> =>
    Effect.gen(function* () {
      const { events, complete } = yield* read(lo, hi, CONTEXT_READ_CAP);
      // A single millisecond with more lines than a read takes keeps those it read.
      if (complete || hi - lo <= 1) return events.slice(-k);
      const mid = Math.floor((lo + hi) / 2);
      const later = yield* lastIn(mid, hi, k);
      if (later.length >= k) return later;
      return [...(yield* lastIn(lo, mid, k - later.length)), ...later];
    });
  return Effect.gen(function* () {
    // Each window's lines, nearest window first.
    const windows: Array<ReadonlyArray<TimedEvent>> = [];
    let have = 0;
    let hi = end;
    for (const back of CONTEXT_WINDOWS_MS) {
      if (have >= n) break;
      const lo = end - back;
      const found = yield* lastIn(lo, hi, n - have);
      windows.push(found);
      have += found.length;
      hi = lo;
    }
    return windows.toReversed().flat().slice(-n);
  });
};

/** How many lines past the requested time are read to find the line logged at it. */
const ANCHOR_SLACK = 20;

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

interface SearchOptions {
  readonly app: string;
  readonly stage: string;
  readonly from: number;
  readonly to: number;
  /** Free text or a CloudWatch filter pattern; with structured filters, text only. */
  readonly q?: string | undefined;
  readonly stream?: LogStream | undefined;
  /** Any but `streams` runs the search on Logs Insights. */
  readonly filters?: LogFilters | undefined;
}

/** Logs Insights query states that won't change any more. */
const FINISHED = new Set(['Complete', 'Failed', 'Cancelled', 'Timeout']);

/** How long a request waits for its Logs Insights queries. */
const QUERY_TIMEOUT = '25 seconds';

const invalidStream = () => BadRequest.of('stream must be web, worker or service:<name>');

export class Logs extends Context.Service<
  Logs,
  {
    /**
     * Newest first, across the stage's log groups (or those `stream` and
     * `filters.streams` name). Structured filters run it on Logs Insights.
     */
    search(
      options: SearchOptions & {
        readonly limit?: number | undefined;
        readonly nextToken?: string | undefined;
      },
    ): Effect.Effect<LogsResponse, BadRequest>;
    /** Lines per bucket by level and the commonest field values, for the same search (Logs Insights). */
    stats(options: SearchOptions): Effect.Effect<LogStatsResponse, BadRequest>;
    /** The lines around the one logged at `ts` (epoch ms) on one stream, oldest first. */
    context(options: {
      readonly app: string;
      readonly stage: string;
      readonly stream: LogStream;
      readonly ts: number;
      readonly before: number;
      readonly after: number;
    }): Effect.Effect<LogContextResponse, BadRequest | NotFound>;
    /**
     * New log lines as they arrive (CloudWatch Live Tail), for up to 15
     * minutes. `q` is Live Tail's filter pattern; `filters` apply to the lines.
     */
    tail(options: {
      readonly app: string;
      readonly stage: string;
      readonly q?: string | undefined;
      /** Only this stream's log group. */
      readonly stream?: LogStream | undefined;
      readonly filters?: LogFilters | undefined;
    }): Stream.Stream<LogLine, AwsError | BadRequest>;
    /** Every telemetry event carrying `trace`, oldest first (Logs Insights over every stream). */
    trace(options: {
      readonly app: string;
      readonly stage: string;
      readonly trace: string;
      readonly from: number;
      readonly to: number;
    }): Effect.Effect<ReadonlyArray<TelemetryEvent>, BadRequest>;
    /** Requests and jobs that started traces, newest first (Logs Insights over their root lines). */
    traces(options: {
      readonly app: string;
      readonly stage: string;
      readonly from: number;
      readonly to: number;
      readonly filters?: TraceFilters | undefined;
      readonly limit?: number | undefined;
    }): Effect.Effect<TracesResponse, BadRequest>;
    /** A member's Logs Insights query on every log group of the stage, and nothing else. */
    insights(options: {
      readonly app: string;
      readonly stage: string;
      readonly query: string;
      readonly from: number;
      readonly to: number;
    }): Effect.Effect<InsightsResponse, BadRequest>;
    /** An error group's `err` lines per bucket and per deployment (Logs Insights). */
    errorOccurrences(options: {
      readonly app: string;
      readonly stage: string;
      readonly fingerprint: string;
      readonly from: number;
      readonly to: number;
    }): Effect.Effect<ErrorOccurrencesResponse, BadRequest>;
  }
>()('@ericminassian/platform-control-plane/Logs') {
  static readonly layer: Layer.Layer<Logs, never, Aws | Settings> = Layer.effect(
    Logs,
    Effect.gen(function* () {
      const aws = yield* Aws;
      const settings = yield* Settings;

      /**
       * Every stream of the stage with its log group: web and worker when the
       * stage has them, and each service log group, including those of
       * services a later deploy dropped (the engine removes service log
       * groups only with the stage).
       */
      const stageStreams = Effect.fnUntraced(function* (app: string, stage: string) {
        const prefix = names.logGroupPrefix(app, stage);
        const streams: Array<{ stream: LogStream; group: string }> = [];
        let nextToken: string | undefined;
        do {
          const res = yield* tryAws(() =>
            aws.logs().send(new DescribeLogGroupsCommand({ logGroupNamePrefix: prefix, nextToken })),
          );
          for (const { logGroupName: group } of res.logGroups ?? []) {
            const stream = group ? streamUnderStage(group.slice(prefix.length)) : undefined;
            if (group && stream) streams.push({ stream, group });
          }
          nextToken = res.nextToken;
        } while (nextToken);
        const order = (s: LogStream) => (s === 'web' ? 0 : s === 'worker' ? 1 : 2);
        return streams.toSorted(
          (a, b) => order(a.stream) - order(b.stream) || a.stream.localeCompare(b.stream),
        );
      });

      /** Each named stream with its log group; a name that isn't a stream fails with `invalid`. */
      const withGroups = (
        app: string,
        stage: string,
        streams: ReadonlyArray<LogStream>,
        invalid: () => BadRequest,
      ) =>
        Effect.forEach(streams, (stream) => {
          const group = logGroupOf(app, stage, stream);
          return group ? Effect.succeed({ stream, group }) : Effect.fail(invalid());
        });

      /** The log groups of the stage that `selected` (undefined: every stream) names and that exist. */
      const existingGroups = Effect.fnUntraced(function* (
        app: string,
        stage: string,
        selected: ReadonlyArray<LogStream> | undefined,
      ) {
        if (selected) yield* withGroups(app, stage, selected, invalidStream);
        const streams = yield* stageStreams(app, stage);
        return streams.filter((s) => !selected || selected.includes(s.stream)).map((s) => s.group);
      });

      /**
       * Runs a Logs Insights QL query on log groups and waits for it. One that
       * is interrupted (its caller's time ran out) is stopped: it would hold
       * one of the account's concurrent queries until it finished.
       */
      const runQuery = Effect.fnUntraced(function* (o: {
        readonly groups: ReadonlyArray<string>;
        readonly from: number;
        readonly to: number;
        readonly query: string;
      }) {
        const empty: GetQueryResultsCommandOutput = { $metadata: {}, results: [], status: 'Complete' };
        if (o.groups.length === 0) return empty;
        const { queryId } = yield* tryAws(() =>
          aws.logs().send(
            new StartQueryCommand({
              queryLanguage: 'CWLI',
              logGroupNames: [...o.groups],
              startTime: Math.floor(o.from / 1000),
              endTime: Math.ceil(o.to / 1000),
              queryString: o.query,
            }),
          ),
        );
        if (!queryId) return empty;
        const done = yield* tryAws(() => aws.logs().send(new GetQueryResultsCommand({ queryId }))).pipe(
          Effect.delay('750 millis'),
          Effect.repeat({ until: (res) => FINISHED.has(res.status ?? ''), schedule: Schedule.forever }),
          Effect.onInterrupt(() =>
            tryAws(() => aws.logs().send(new StopQueryCommand({ queryId }))).pipe(Effect.ignore),
          ),
        );
        if (done.status !== 'Complete')
          return yield* BadRequest.of(`the Logs Insights query ended ${done.status}`);
        return done;
      });

      /** A query's rows by field name. */
      const rowsOf = (res: GetQueryResultsCommandOutput): Row[] =>
        (res.results ?? []).map((row) =>
          Object.fromEntries(row.flatMap((f) => (f.field ? [[f.field, f.value ?? '']] : []))),
        );

      const timedOut = (what: string) => () =>
        BadRequest.of(`${what} took longer than 25 s; narrow the range or filters`);

      /** The search's structured filters and text as query terms, checked. */
      const checkSearch = Effect.fnUntraced(function* (options: SearchOptions) {
        const problem = checkLogFilters(options.filters);
        if (problem) return yield* BadRequest.of(problem);
        const text = searchTerms(options.q);
        if ('error' in text) return yield* BadRequest.of(text.error);
        const selected = selectedStreams(options.stream, options.filters);
        if (selected) yield* withGroups(options.app, options.stage, selected, invalidStream);
        return { terms: text.terms, selected };
      });

      /** A search with filters a filter pattern can't express: Logs Insights, newest first. */
      const insightsSearch = Effect.fn('Logs.insightsSearch')(
        function* (
          options: SearchOptions & { readonly limit: number; readonly nextToken?: string | undefined },
        ) {
          const { terms, selected } = yield* checkSearch(options);
          const cursor = options.nextToken
            ? yield* decodeInsightsCursor(options.nextToken).pipe(
                Effect.mapError(() => BadRequest.of('invalid next token')),
              )
            : undefined;
          const groups = yield* existingGroups(options.app, options.stage, selected);
          const to = Math.min(options.to, cursor?.b ?? options.to);
          const done = yield* runQuery({
            groups,
            from: options.from,
            to,
            query: searchQuery({
              filters: options.filters,
              terms,
              from: options.from,
              to,
              limit: fetchCount(options.limit, cursor),
            }),
          }).pipe(Effect.timeoutOrElse({ duration: QUERY_TIMEOUT, orElse: timedOut('the search') }));
          const rows = rowsOf(done).map((r) => ({
            ts: insightsTime(r['@timestamp']),
            key: rowKey(r['@log'] ?? '', r['@logStream'] ?? '', r['@message'] ?? ''),
            log: r['@log'] ?? '',
            message: r['@message'] ?? '',
          }));
          const page = pageRows(rows, cursor, options.limit);
          return {
            lines: page.rows.map((r) => toLogLine(streamOfLogGroup(r.log), r.ts, r.message)),
            ...(page.next ? { nextToken: encodeInsightsCursor(page.next) } : {}),
          } satisfies LogsResponse;
        },
        // Logs Insights refuses some queries (a range too long, too many at once); the caller gets its reason.
        Effect.catchTag('AwsError', (e) => BadRequest.of(e.message)),
      );

      /** A search CloudWatch filter patterns can express: FilterLogEvents on each log group. */
      const patternSearch = Effect.fn('Logs.patternSearch')(
        function* (
          options: SearchOptions & { readonly limit: number; readonly nextToken?: string | undefined },
        ) {
          const { app, stage, nextToken, limit } = options;
          const selected = selectedStreams(options.stream, options.filters);
          const invalidToken = () => BadRequest.of('invalid next token');
          const cursor: Cursor = nextToken
            ? yield* decodeCursor(Buffer.from(nextToken, 'base64url').toString()).pipe(
                Effect.mapError(invalidToken),
              )
            : {};
          const targets = nextToken
            ? // A continued search only reads the streams that had more.
              yield* withGroups(
                app,
                stage,
                Object.keys(cursor).filter((stream) => !selected || selected.includes(stream)),
                invalidToken,
              )
            : selected
              ? yield* withGroups(app, stage, selected, invalidStream)
              : yield* stageStreams(app, stage);
          const pattern = toFilterPattern(options.q);
          const pages = yield* Effect.forEach(
            targets,
            ({ stream, group }) =>
              tryAws(() =>
                aws.logs().send(
                  new FilterLogEventsCommand({
                    logGroupName: group,
                    startTime: options.from,
                    endTime: options.to,
                    limit,
                    ...(pattern ? { filterPattern: pattern } : {}),
                    ...(cursor[stream] ? { nextToken: cursor[stream] } : {}),
                  }),
                ),
              ).pipe(
                // A stage that never logged on this stream has no log group (yet, or any more).
                Effect.catchIf(AwsError.is('ResourceNotFoundException'), () =>
                  Effect.succeed({ events: [], nextToken: undefined }),
                ),
                Effect.map((res) => ({ stream, res })),
              ),
            { concurrency: 'unbounded' },
          );
          const next: Record<LogStream, string> = {};
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

      const search = Effect.fn('Logs.search')(function* (
        options: SearchOptions & {
          readonly limit?: number | undefined;
          readonly nextToken?: string | undefined;
        },
      ) {
        const limit = Math.max(1, Math.min(options.limit ?? 200, 1000));
        return hasStructuredFilters(options.filters)
          ? yield* insightsSearch({ ...options, limit })
          : yield* patternSearch({ ...options, limit });
      });

      const stats = Effect.fn('Logs.stats')(
        function* (options: SearchOptions) {
          const { terms, selected } = yield* checkSearch(options);
          const res = autoQueryResolution(
            options.from,
            options.to,
            yield* Clock.currentTimeMillis,
            Number.POSITIVE_INFINITY,
          );
          const groups = yield* existingGroups(options.app, options.stage, selected);
          const queries = statsQueries({
            filters: options.filters,
            terms,
            from: options.from,
            to: options.to,
            res,
          });
          const run = (query: string) =>
            Effect.map(runQuery({ groups, from: options.from, to: options.to, query }), rowsOf);
          const [levels, streams, routes, status, revs] = yield* Effect.all(
            [
              run(queries.levels),
              run(queries.streams),
              run(queries.routes),
              run(queries.status),
              run(queries.revs),
            ],
            { concurrency: 'unbounded' },
          ).pipe(Effect.timeoutOrElse({ duration: QUERY_TIMEOUT, orElse: timedOut('the log stats') }));
          return logStatsOf({
            res,
            from: options.from,
            to: options.to,
            levels,
            streams,
            routes,
            status,
            revs,
            streamOf: streamOfLogGroup,
          });
        },
        Effect.catchTag('AwsError', (e) => BadRequest.of(e.message)),
      );

      const context = Effect.fn('Logs.context')(
        function* (options: {
          readonly app: string;
          readonly stage: string;
          readonly stream: LogStream;
          readonly ts: number;
          readonly before: number;
          readonly after: number;
        }) {
          const group = logGroupOf(options.app, options.stage, options.stream);
          if (!group) return yield* invalidStream();
          const read: WindowReader<AwsError> = (start, end, cap) =>
            Effect.gen(function* () {
              const events: TimedEvent[] = [];
              let nextToken: string | undefined;
              // FilterLogEvents can answer a page with no events and a token; a busy window stops at `cap`.
              for (let page = 0; page < 50; page++) {
                const res = yield* tryAws(() =>
                  aws.logs().send(
                    new FilterLogEventsCommand({
                      logGroupName: group,
                      startTime: Math.max(0, start),
                      // Inclusive: [start, end) ends a millisecond before `end`.
                      endTime: end - 1,
                      limit: Math.min(Math.max(cap - events.length, 1), 10_000),
                      ...(nextToken ? { nextToken } : {}),
                    }),
                  ),
                ).pipe(
                  Effect.catchIf(AwsError.is('ResourceNotFoundException'), () =>
                    Effect.succeed({ events: [] as FilteredLogEvent[], nextToken: undefined }),
                  ),
                );
                for (const e of res.events ?? [])
                  events.push({ timestamp: e.timestamp ?? 0, message: e.message ?? '' });
                nextToken = res.nextToken;
                if (!nextToken || events.length >= cap) break;
              }
              return {
                events: events.toSorted((a, b) => a.timestamp - b.timestamp).slice(0, cap),
                complete: !nextToken && events.length <= cap,
              };
            });
          // One more line on each side, in case the anchor is the last line before `ts`.
          const [earlier, later] = yield* Effect.all(
            [
              lastEventsBefore(read, options.ts, options.before + 1),
              Effect.map(
                read(options.ts, options.ts + 24 * 3_600_000, options.after + 1 + ANCHOR_SLACK),
                (r) => r.events,
              ),
            ],
            { concurrency: 'unbounded' },
          );
          const lines = (events: ReadonlyArray<TimedEvent>) =>
            events.map((e) => toLogLine(options.stream, e.timestamp, e.message));
          const found = contextLines(lines(earlier), lines(later), options.ts, options);
          if (!found)
            return yield* NotFound.of(
              `log lines around ${new Date(options.ts).toISOString()} on ${options.stream}`,
            );
          return found;
        },
        Effect.catchTag('AwsError', Effect.die),
      );

      const tail = (options: {
        readonly app: string;
        readonly stage: string;
        readonly q?: string | undefined;
        readonly stream?: LogStream | undefined;
        readonly filters?: LogFilters | undefined;
      }) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const { accountId, region } = yield* settings.runtime;
            const problem = checkLogFilters(options.filters);
            if (problem) return yield* BadRequest.of(problem);
            const selected = selectedStreams(options.stream, options.filters);
            const groups = selected
              ? yield* withGroups(options.app, options.stage, selected, invalidStream)
              : yield* stageStreams(options.app, options.stage);
            if (groups.length === 0) return Stream.empty;
            const arn = (group: string) => `arn:aws:logs:${region}:${accountId}:log-group:${group}`;
            const pattern = toFilterPattern(options.q);
            // Aborted when the stream ends: the client went away, or 15 minutes passed.
            const session = yield* Effect.acquireRelease(
              Effect.sync(() => new AbortController()),
              (controller) => Effect.sync(() => controller.abort()),
            );
            const res = yield* tryAws(() =>
              aws.logs().send(
                new StartLiveTailCommand({
                  logGroupIdentifiers: groups.slice(0, LIVE_TAIL_MAX_GROUPS).map(({ group }) => arn(group)),
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
                    streamOfLogGroup(r.logGroupIdentifier ?? ''),
                    r.timestamp ?? now,
                    r.message ?? '',
                  ),
                ),
              ),
              Stream.filter((line) => matchesLogFilters(line, options.filters)),
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
          if (!TRACE_ID_PATTERN.test(options.trace)) return yield* BadRequest.of('invalid trace id');
          const groups = yield* existingGroups(options.app, options.stage, undefined);
          const done = yield* runQuery({
            groups,
            from: options.from,
            to: options.to,
            query: `fields @timestamp, @message | filter @message like ${str(options.trace)} | sort @timestamp asc | limit 1000`,
          }).pipe(
            Effect.timeoutOrElse({
              duration: QUERY_TIMEOUT,
              orElse: () => BadRequest.of('trace query timed out'),
            }),
          );
          const events: TelemetryEvent[] = [];
          for (const row of rowsOf(done)) {
            const e = row['@message'] ? parseLogMessage(row['@message']) : null;
            if (e && e.trace === options.trace) events.push(e);
          }
          return events.toSorted((a, b) => a.ts - b.ts);
        },
        // Logs Insights refuses some queries (an unknown log group, a range too
        // long); the caller gets its reason.
        Effect.catchTag('AwsError', (e) => BadRequest.of(e.message)),
      );

      const traces = Effect.fn('Logs.traces')(
        function* (options: {
          readonly app: string;
          readonly stage: string;
          readonly from: number;
          readonly to: number;
          readonly filters?: TraceFilters | undefined;
          readonly limit?: number | undefined;
        }) {
          const problem = checkTraceFilters(options.filters);
          if (problem) return yield* BadRequest.of(problem);
          const limit = Math.max(1, Math.min(options.limit ?? 200, 1000));
          const groups = yield* existingGroups(options.app, options.stage, undefined);
          const done = yield* runQuery({
            groups,
            from: options.from,
            to: options.to,
            // One more than asked for tells whether there were more.
            query: tracesQuery({
              filters: options.filters,
              from: options.from,
              to: options.to,
              limit: limit + 1,
            }),
          }).pipe(Effect.timeoutOrElse({ duration: QUERY_TIMEOUT, orElse: timedOut('the trace list') }));
          const rows = rowsOf(done);
          const summaries = rows.flatMap((r) => {
            const e = r['@message'] ? parseLogMessage(r['@message']) : null;
            const summary = e ? traceSummary(e) : undefined;
            return summary ? [summary] : [];
          });
          return {
            traces: summaries.slice(0, limit),
            truncated: rows.length > limit,
          } satisfies TracesResponse;
        },
        Effect.catchTag('AwsError', (e) => BadRequest.of(e.message)),
      );

      const insights = Effect.fn('Logs.insights')(
        function* (options: {
          readonly app: string;
          readonly stage: string;
          readonly query: string;
          readonly from: number;
          readonly to: number;
        }) {
          const problem = checkUserQuery(options.query);
          if (problem) return yield* BadRequest.of(problem);
          const groups = yield* existingGroups(options.app, options.stage, undefined);
          const done = yield* runQuery({
            groups,
            from: options.from,
            to: options.to,
            query: options.query,
          }).pipe(Effect.timeoutOrElse({ duration: QUERY_TIMEOUT, orElse: timedOut('the query') }));
          const { columns, rows } = resultTable(done.results ?? []);
          return {
            columns,
            rows,
            recordsMatched: done.statistics?.recordsMatched ?? 0,
            recordsScanned: done.statistics?.recordsScanned ?? 0,
            bytesScanned: done.statistics?.bytesScanned ?? 0,
          } satisfies InsightsResponse;
        },
        // A query Logs Insights refuses (bad syntax, too long a range) comes back with its reason.
        Effect.catchTag('AwsError', (e) => BadRequest.of(e.message)),
      );

      const errorOccurrences = Effect.fn('Logs.errorOccurrences')(
        function* (options: {
          readonly app: string;
          readonly stage: string;
          readonly fingerprint: string;
          readonly from: number;
          readonly to: number;
        }) {
          if (!FINGERPRINT_PATTERN.test(options.fingerprint))
            return yield* BadRequest.of('invalid fingerprint');
          const { from, to } = options;
          const res = autoQueryResolution(from, to, yield* Clock.currentTimeMillis, Number.POSITIVE_INFINITY);
          const groups = yield* existingGroups(options.app, options.stage, undefined);
          const queries = occurrencesQueries({ fingerprint: options.fingerprint, from, to, res });
          const run = (query: string) => Effect.map(runQuery({ groups, from, to, query }), rowsOf);
          const [buckets, revs] = yield* Effect.all([run(queries.buckets), run(queries.revs)], {
            concurrency: 'unbounded',
          }).pipe(
            Effect.timeoutOrElse({ duration: QUERY_TIMEOUT, orElse: timedOut('the error’s occurrences') }),
          );
          return occurrencesOf({ res, from, to, buckets, revs });
        },
        Effect.catchTag('AwsError', (e) => BadRequest.of(e.message)),
      );

      return Logs.of({ search, stats, context, tail, trace, traces, insights, errorOccurrences });
    }),
  );
}
