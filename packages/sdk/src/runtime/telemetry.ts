import { format } from 'node:util';
import {
  type ErrorEvent,
  errorFingerprint,
  newSpanId,
  SLOW_TRACE_MS,
  type TelemetryEvent,
  type TelemetryKind,
  traceSampled,
} from '@ericminassian/platform-core';
import { tryBindings } from './bindings.ts';
import { currentContext, type HeldSpans, type RequestContext, type SpanFields } from './context.ts';

/**
 * Telemetry writer. Every line is one core `TelemetryEvent` as JSON on stdout
 * (Lambda ships stdout to CloudWatch Logs; the account-level subscription
 * filter forwards `_p: 1` lines to the telemetry processor). Under `plat dev`
 * (`PLATFORM_LOG_PRETTY=1`) lines are printed compactly for humans instead.
 * Nothing here may ever throw into app code.
 *
 * A request's or job's spans are held until it ends (`endRoot`), which writes
 * them only when they're worth their bytes; see core's `TRACE_SAMPLE_RATE`.
 */

type Sink = (event: TelemetryEvent) => void;

// Captured before console is patched so telemetry never recurses through it.
const rawWrite = process.stdout.write.bind(process.stdout);
let sink: Sink | null = null;

/** Replace the output (tests). `null` restores stdout. */
export function setTelemetrySink(s: Sink | null): void {
  sink = s;
}

let sampled: (trace: string) => boolean = traceSampled;

/** Replace which traces keep their spans (tests). `null` restores core's `traceSampled`. */
export function setTraceSampler(s: ((trace: string) => boolean) | null): void {
  sampled = s ?? traceSampled;
}

/** Under `plat dev` a person reads every line and nothing is billed, so spans aren't held. */
const isPretty = () => process.env.PLATFORM_LOG_PRETTY === '1';

type Fields<K extends TelemetryKind> = Omit<
  Extract<TelemetryEvent, { t: K }>,
  '_p' | 'ts' | 'app' | 'stage' | 'rev' | 't'
> & {
  ts?: number;
};

export function emit<K extends TelemetryKind>(t: K, fields: Fields<K>): void {
  try {
    const b = tryBindings();
    const ctx = currentContext();
    const event = {
      _p: 1,
      t,
      ts: Date.now(),
      app: b?.app ?? process.env.PLATFORM_APP ?? 'unknown',
      stage: b?.stage ?? process.env.PLATFORM_STAGE ?? 'unknown',
      rev: b?.revision ?? 'unknown',
      ...(ctx ? { trace: ctx.trace } : {}),
      ...fields,
    } as unknown as TelemetryEvent;
    const line = compact(event);
    if (sink) sink(line);
    else rawWrite(`${isPretty() ? pretty(line) : JSON.stringify(line)}\n`);
  } catch {
    // never throw from telemetry
  }
}

/** Leaves out what a reader can tell without it: a `path` that is its `route`, a first `attempt`. */
function compact(event: TelemetryEvent): TelemetryEvent {
  if (event.t === 'req' && event.path === event.route) {
    const { path, ...rest } = event;
    return rest;
  }
  if (event.t === 'job' && event.attempt === 1) {
    const { attempt, ...rest } = event;
    return rest;
  }
  return event;
}

/** Time `fn` as a span (`db.get`, `queue.send`, ...) under the current trace. */
export async function span<T>(op: string, name: string | undefined, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  const ctx = currentContext();
  let status: 'ok' | 'error' = 'ok';
  try {
    return await fn();
  } catch (e) {
    status = 'error';
    throw e;
  } finally {
    // Spans only matter as part of a trace; skip them outside a request/job.
    if (ctx) emitSpan(ctx, op, name, t0, status);
  }
}

/** A request or job holds at most this many spans; it only counts the rest. */
export const MAX_HELD_SPANS = 500;

/**
 * A finished span of `ctx`'s trace that started at `t0` (`performance.now()`).
 * A request or job (`startRoot`) holds it until `endRoot`; any other context
 * writes it now.
 */
export function emitSpan(
  ctx: RequestContext,
  op: string,
  name: string | undefined,
  t0: number,
  status: 'ok' | 'error',
): void {
  const line: SpanFields = {
    ts: Date.now(),
    trace: ctx.trace,
    op,
    ...(name ? { name } : {}),
    dur: round(performance.now() - t0),
    status,
    span: newSpanId(),
    parent: ctx.span,
    start: round(t0 - ctx.startedAt),
  };
  const held = ctx.spans;
  if (!held || held.keep || isPretty()) return emit('span', line);
  // One that ends after its request or job (work it didn't wait for) follows the choice made then.
  if (held.ended) return;
  if (held.lines.length < MAX_HELD_SPANS) held.lines.push(line);
  else {
    held.unwritten += 1;
    held.unwrittenMs += line.dur;
  }
}

/** Keeps a request's or job's spans: writes those it holds, and the rest as they end. */
function keepSpans(held: HeldSpans): void {
  held.keep = true;
  for (const line of held.lines) emit('span', line);
  held.lines = [];
}

/**
 * Ends the request or job `ctx` is the root of (`startRoot`) by writing its
 * `req` or `job` line. Its spans are written first if it failed (a 5xx, a
 * failed job, or an `err` line while it ran), took `SLOW_TRACE_MS` or longer,
 * or its trace is sampled; otherwise they're dropped and the line counts them
 * (`calls`, `callMs`). The line names its own `span` id only when spans that
 * point to it are written.
 */
export function endRoot<K extends 'req' | 'job'>(
  ctx: RequestContext,
  t: K,
  fields: Fields<K> & { readonly status: number | 'ok' | 'error'; readonly dur: number },
): void {
  const held = ctx.spans;
  if (!held) return emit(t, { ...fields, span: ctx.span });
  if (!held.ended) {
    held.ended = true;
    const failed = typeof fields.status === 'number' ? fields.status >= 500 : fields.status === 'error';
    if (failed || fields.dur >= SLOW_TRACE_MS || sampled(ctx.trace)) keepSpans(held);
    for (const line of held.lines) {
      held.unwritten += 1;
      held.unwrittenMs += line.dur;
    }
    held.lines = [];
  }
  emit(t, {
    ...fields,
    ...(held.keep || isPretty() ? { span: ctx.span } : {}),
    ...(held.unwritten > 0 ? { calls: held.unwritten, callMs: Math.round(held.unwrittenMs) } : {}),
  });
}

/** Emit an `err` event for a thrown value. */
export function emitError(
  err: unknown,
  source: ErrorEvent['source'],
  extra: { route?: string; job?: string } = {},
): void {
  const e = toError(err);
  // An error keeps the spans of the request or job it happened in, written before it.
  const held = currentContext()?.spans;
  if (held && !held.keep) keepSpans(held);
  emit('err', {
    source,
    name: e.name,
    message: e.message,
    ...(e.stack ? { stack: e.stack } : {}),
    ...extra,
    fingerprint: errorFingerprint(e.name, e.message, e.stack),
  });
}

export function toError(err: unknown): Error {
  if (err instanceof Error) return err;
  return new Error(typeof err === 'string' ? err : safeStringify(err));
}

// ---------------------------------------------------------------- metrics & log

export const metrics = {
  count(name: string, n = 1): void {
    emit('metric', { name, value: n, unit: 'count' });
  },
  value(name: string, value: number, unit?: string): void {
    emit('metric', { name, value, ...(unit ? { unit } : {}) });
  },
};

type Level = 'debug' | 'info' | 'warn' | 'error';

function logAt(level: Level, msg: string, fields?: unknown): void {
  if (
    level === 'error' &&
    (fields instanceof Error || (fields && typeof fields === 'object' && 'stack' in fields))
  ) {
    const e = toError(fields);
    emit('log', { level, msg, error: { name: e.name, message: e.message, stack: e.stack } });
    emitError(e, 'log', jobOrRoute());
    return;
  }
  const extra =
    fields && typeof fields === 'object'
      ? (fields as Record<string, unknown>)
      : fields === undefined
        ? {}
        : { value: fields };
  emit('log', { ...extra, level, msg });
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => logAt('debug', msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => logAt('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => logAt('warn', msg, fields),
  error: (msg: string, fields?: unknown) => logAt('error', msg, fields),
};

function jobOrRoute(): { route?: string; job?: string } {
  const ctx = currentContext();
  if (!ctx) return {};
  return { ...(ctx.route ? { route: ctx.route } : {}), ...(ctx.job ? { job: ctx.job } : {}) };
}

// ---------------------------------------------------------------- console capture

let consolePatched = false;
const originalConsole: Partial<Record<keyof Console, unknown>> = {};

/** Route console.* through telemetry so app logs carry the trace id. */
export function installConsoleCapture(): void {
  if (consolePatched) return;
  consolePatched = true;
  const map: Array<[keyof Console, Level]> = [
    ['log', 'info'],
    ['info', 'info'],
    ['debug', 'debug'],
    ['warn', 'warn'],
    ['error', 'error'],
  ];
  for (const [method, level] of map) {
    originalConsole[method] = console[method];
    (console as unknown as Record<string, (...a: unknown[]) => void>)[method] = (...args: unknown[]) => {
      emit('log', { level, msg: format(...args) });
    };
  }
}

// ---------------------------------------------------------------- fetch spans

let fetchPatched = false;
let originalFetch: typeof fetch | undefined;

/** Record outgoing `fetch` calls as spans (method + host only; no URLs with secrets). */
export function installFetchInstrumentation(): void {
  if (fetchPatched || typeof globalThis.fetch !== 'function') return;
  fetchPatched = true;
  originalFetch = globalThis.fetch;
  const original = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (!currentContext()) return original(input, init);
    let name = 'fetch';
    try {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      name = `${method.toUpperCase()} ${url.host}`;
    } catch {}
    return span('fetch', name, () => original(input, init));
  };
}

/**
 * `fetch` without the span wrapper, for SDK calls that record their own span
 * (`realtime.publish`), so a trace doesn't show the same request twice.
 */
export function uninstrumentedFetch(): typeof fetch {
  return fetchPatched && originalFetch ? originalFetch : globalThis.fetch;
}

/** Undo console/fetch patching (tests). */
export function uninstallInstrumentation(): void {
  if (consolePatched) {
    for (const [k, v] of Object.entries(originalConsole))
      (console as unknown as Record<string, unknown>)[k] = v;
    consolePatched = false;
  }
  if (fetchPatched && originalFetch) {
    globalThis.fetch = originalFetch;
    fetchPatched = false;
  }
}

// ---------------------------------------------------------------- pretty printing

const COLORS = {
  dim: '\x1b[2m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  cyan: '\x1b[36m',
  reset: '\x1b[0m',
};

/** One telemetry line for humans (`PLATFORM_LOG_PRETTY=1`). */
export function pretty(e: TelemetryEvent): string {
  const time = new Date(e.ts).toISOString().slice(11, 23);
  const c = (color: keyof typeof COLORS, s: string) => `${COLORS[color]}${s}${COLORS.reset}`;
  switch (e.t) {
    case 'req': {
      const color = e.status >= 500 ? 'red' : e.status >= 400 ? 'yellow' : 'green';
      return `${c('dim', time)} ${c(color, String(e.status))} ${e.method} ${e.path ?? e.route} ${c('dim', `${e.dur}ms${e.cold ? ' cold' : ''}`)}`;
    }
    case 'err':
      return `${c('dim', time)} ${c('red', `✖ ${e.name}: ${e.message}`)}${e.stack ? `\n${c('dim', e.stack.split('\n').slice(1, 6).join('\n'))}` : ''}`;
    case 'job':
      return `${c('dim', time)} ${c(e.status === 'ok' ? 'cyan' : 'red', `${e.kind}:${e.name}`)} ${e.status} ${c('dim', duration(e.dur))}`;
    case 'span':
      return c(
        'dim',
        `${time}   ↳ ${e.op}${e.name ? ` ${e.name}` : ''} ${e.dur}ms${e.status === 'error' ? ' error' : ''}`,
      );
    case 'log': {
      const { _p, t, ts, app, stage, rev, trace, span: _s, parent, level, msg, ...rest } = e;
      const extra = Object.keys(rest).length ? ` ${c('dim', safeStringify(rest))}` : '';
      const color = level === 'error' ? 'red' : level === 'warn' ? 'yellow' : 'reset';
      return `${c('dim', time)} ${c(color, msg)}${extra}`;
    }
    case 'metric':
      return c('dim', `${time} metric ${e.name}=${e.value}${e.unit ? ` ${e.unit}` : ''}`);
    case 'limit':
      return e.ok ? c('dim', `${time} limit ${e.name} ok`) : c('yellow', `${time} limit ${e.name} over`);
    case 'env': {
      const detail = e.initMs !== undefined ? ` (${e.initMs}ms)` : '';
      return c('dim', `${time} ${e.runtime} ${e.event}${detail}`);
    }
    default:
      return e satisfies never;
  }
}

/** `12.3ms`, `4.2s`, `3m 05s`. */
function duration(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m ${String(Math.floor((ms % 60_000) / 1_000)).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

function round(ms: number): number {
  return Math.round(ms * 10) / 10;
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
