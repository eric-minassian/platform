import { format } from 'node:util';
import {
  type ErrorEvent,
  errorFingerprint,
  newSpanId,
  type TelemetryEvent,
  type TelemetryKind,
} from '@ericminassian/platform-core';
import { tryBindings } from './bindings.ts';
import { currentContext } from './context.ts';

/**
 * Telemetry writer. Every line is one core `TelemetryEvent` as JSON on stdout
 * (Lambda ships stdout to CloudWatch Logs; the account-level subscription
 * filter forwards `_p: 1` lines to the telemetry processor). Under `plat dev`
 * (`PLATFORM_LOG_PRETTY=1`) lines are printed compactly for humans instead.
 * Nothing here may ever throw into app code.
 */

type Sink = (event: TelemetryEvent) => void;

// Captured before console is patched so telemetry never recurses through it.
const rawWrite = process.stdout.write.bind(process.stdout);
let sink: Sink | null = null;

/** Replace the output (tests). `null` restores stdout. */
export function setTelemetrySink(s: Sink | null): void {
  sink = s;
}

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
    if (sink) sink(event);
    else rawWrite(`${process.env.PLATFORM_LOG_PRETTY === '1' ? pretty(event) : JSON.stringify(event)}\n`);
  } catch {
    // never throw from telemetry
  }
}

/** Time `fn` as a span (`db.get`, `queue.send`, ...) under the current trace. */
export async function span<T>(op: string, name: string | undefined, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  const ctx = currentContext();
  const id = newSpanId();
  let status: 'ok' | 'error' = 'ok';
  try {
    return await fn();
  } catch (e) {
    status = 'error';
    throw e;
  } finally {
    // Spans only matter as part of a trace; skip them outside a request/job.
    if (ctx)
      emit('span', {
        op,
        ...(name ? { name } : {}),
        dur: round(performance.now() - t0),
        status,
        span: id,
        parent: ctx.span,
        start: round(t0 - ctx.startedAt),
      });
  }
}

/** Emit an `err` event for a thrown value. */
export function emitError(
  err: unknown,
  source: ErrorEvent['source'],
  extra: { route?: string; job?: string } = {},
): void {
  const e = toError(err);
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
  error: (msg: string, fields?: Record<string, unknown> | unknown) => logAt('error', msg, fields),
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
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (!currentContext()) return original(input, init);
    let name = 'fetch';
    try {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      name = `${method.toUpperCase()} ${url.host}`;
    } catch {}
    return span('fetch', name, () => original(input, init));
  }) as typeof fetch;
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

function pretty(e: TelemetryEvent): string {
  const time = new Date(e.ts).toISOString().slice(11, 23);
  const c = (color: keyof typeof COLORS, s: string) => `${COLORS[color]}${s}${COLORS.reset}`;
  switch (e.t) {
    case 'req': {
      const color = e.status >= 500 ? 'red' : e.status >= 400 ? 'yellow' : 'green';
      return `${c('dim', time)} ${c(color, String(e.status))} ${e.method} ${e.path} ${c('dim', `${e.dur}ms${e.cold ? ' cold' : ''}`)}`;
    }
    case 'err':
      return `${c('dim', time)} ${c('red', `✖ ${e.name}: ${e.message}`)}${e.stack ? `\n${c('dim', e.stack.split('\n').slice(1, 6).join('\n'))}` : ''}`;
    case 'job':
      return `${c('dim', time)} ${c(e.status === 'ok' ? 'cyan' : 'red', `${e.kind}:${e.name}`)} ${e.status} ${c('dim', `${e.dur}ms`)}`;
    case 'span':
      return `${c('dim', `${time}   ↳ ${e.op}${e.name ? ` ${e.name}` : ''} ${e.dur}ms${e.status === 'error' ? ' error' : ''}`)}`;
    case 'log': {
      const { _p, t, ts, app, stage, rev, trace, span: _s, parent, level, msg, ...rest } = e;
      const extra = Object.keys(rest).length ? ` ${c('dim', safeStringify(rest))}` : '';
      const color = level === 'error' ? 'red' : level === 'warn' ? 'yellow' : 'reset';
      return `${c('dim', time)} ${c(color, msg)}${extra}`;
    }
    case 'metric':
      return `${c('dim', `${time} metric ${e.name}=${e.value}${e.unit ? ` ${e.unit}` : ''}`)}`;
    case 'env':
      return `${c('dim', `${time} ${e.runtime} ${e.event}${e.initMs !== undefined ? ` (${e.initMs}ms)` : ''}`)}`;
  }
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
