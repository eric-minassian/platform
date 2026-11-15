/**
 * Log search, live tail and traces over an app stage's CloudWatch log groups
 * (`/platform/apps/<app>/<stage>/{web,worker}`).
 */
import {
  type FilteredLogEvent,
  FilterLogEventsCommand,
  GetQueryResultsCommand,
  StartLiveTailCommand,
  StartQueryCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import { type LogLine, type LogsResponse, names, type TelemetryEvent } from '@eric-minassian/platform-core';
import { aws } from './aws.ts';
import { getRuntimeConfig } from './config.ts';
import { parseLogMessage } from './telemetry/aggregate.ts';

const STREAMS = ['web', 'worker'] as const;
type Stream = (typeof STREAMS)[number];

/** Turns one raw log message into a LogLine, unwrapping platform telemetry when present. */
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
    rec = JSON.parse(message);
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

export function toLogLine(stream: Stream, timestamp: number, message: string): LogLine {
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
  }
}

/** Plain text becomes a quoted term; `{ ... }` JSON patterns pass through. */
export function toFilterPattern(q: string | undefined): string | undefined {
  const s = q?.trim();
  if (!s) return undefined;
  if (s.startsWith('{') || s.startsWith('"') || s.startsWith('?')) return s;
  return `"${s.replace(/"/g, '\\"')}"`;
}

interface Cursor {
  web?: string;
  worker?: string;
}

export async function searchLogs(opts: {
  app: string;
  stage: string;
  from: number;
  to: number;
  q?: string;
  stream?: Stream;
  limit?: number;
  nextToken?: string;
}): Promise<LogsResponse> {
  const limit = Math.min(opts.limit ?? 200, 1000);
  const cursor: Cursor = opts.nextToken
    ? JSON.parse(Buffer.from(opts.nextToken, 'base64url').toString())
    : {};
  const streams = opts.stream ? [opts.stream] : STREAMS;
  const pattern = toFilterPattern(opts.q);
  const next: Cursor = {};
  const lines: LogLine[] = [];
  await Promise.all(
    streams.map(async (stream) => {
      if (opts.nextToken && !cursor[stream]) return;
      const res = await aws
        .logs()
        .send(
          new FilterLogEventsCommand({
            logGroupName: names.logGroup(opts.app, opts.stage, stream),
            startTime: opts.from,
            endTime: opts.to,
            limit,
            ...(pattern ? { filterPattern: pattern } : {}),
            ...(cursor[stream] ? { nextToken: cursor[stream] } : {}),
          }),
        )
        .catch((err: { name?: string }) => {
          if (err.name === 'ResourceNotFoundException')
            return { events: [] as FilteredLogEvent[], nextToken: undefined };
          throw err;
        });
      for (const e of res.events ?? []) lines.push(toLogLine(stream, e.timestamp ?? 0, e.message ?? ''));
      if (res.nextToken) next[stream] = res.nextToken;
    }),
  );
  lines.sort((a, b) => b.ts.localeCompare(a.ts));
  const hasMore = Object.keys(next).length > 0;
  return {
    lines: lines.slice(0, limit),
    ...(hasMore ? { nextToken: Buffer.from(JSON.stringify(next)).toString('base64url') } : {}),
  };
}

/** Streams new log lines (CloudWatch Live Tail) until `signal` aborts or ~15 minutes pass. */
export async function* tailLogs(opts: {
  app: string;
  stage: string;
  q?: string;
  signal: AbortSignal;
}): AsyncGenerator<LogLine> {
  const { accountId, region } = await getRuntimeConfig();
  const arn = (stream: Stream) =>
    `arn:aws:logs:${region}:${accountId}:log-group:${names.logGroup(opts.app, opts.stage, stream)}`;
  const pattern = toFilterPattern(opts.q);
  const stop = AbortSignal.any([opts.signal, AbortSignal.timeout(15 * 60_000)]);
  const res = await aws.logs().send(
    new StartLiveTailCommand({
      logGroupIdentifiers: STREAMS.map(arn),
      ...(pattern ? { logEventFilterPattern: pattern } : {}),
    }),
    { abortSignal: stop },
  );
  if (!res.responseStream) return;
  for await (const event of res.responseStream) {
    if (stop.aborted) return;
    for (const r of event.sessionUpdate?.sessionResults ?? []) {
      const stream: Stream = r.logGroupIdentifier?.endsWith('/worker') ? 'worker' : 'web';
      yield toLogLine(stream, r.timestamp ?? Date.now(), r.message ?? '');
    }
  }
}

/** Every telemetry event carrying `trace`, oldest first (Logs Insights over web + worker). */
export async function getTrace(opts: {
  app: string;
  stage: string;
  trace: string;
  from: number;
  to: number;
}): Promise<TelemetryEvent[]> {
  if (!/^[0-9a-f-]{8,64}$/i.test(opts.trace)) throw new Error('invalid trace id');
  const start = await aws.logs().send(
    new StartQueryCommand({
      logGroupNames: STREAMS.map((s) => names.logGroup(opts.app, opts.stage, s)),
      startTime: Math.floor(opts.from / 1000),
      endTime: Math.ceil(opts.to / 1000),
      queryString: `fields @timestamp, @message | filter @message like "${opts.trace}" | sort @timestamp asc | limit 1000`,
    }),
  );
  if (!start.queryId) return [];
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 750));
    const res = await aws.logs().send(new GetQueryResultsCommand({ queryId: start.queryId }));
    if (res.status === 'Complete') {
      const events: TelemetryEvent[] = [];
      for (const row of res.results ?? []) {
        const msg = row.find((f) => f.field === '@message')?.value;
        const e = msg ? parseLogMessage(msg) : null;
        if (e && e.trace === opts.trace) events.push(e);
      }
      return events.sort((a, b) => a.ts - b.ts);
    }
    if (res.status === 'Failed' || res.status === 'Cancelled' || res.status === 'Timeout') {
      throw new Error(`trace query ${res.status}`);
    }
  }
  throw new Error('trace query timed out');
}
