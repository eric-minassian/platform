/**
 * Telemetry contract. The runtime SDK writes one JSON object per line to
 * stdout; Lambda ships it to CloudWatch Logs; one account-level subscription
 * filter forwards the interesting kinds to the telemetry processor, which
 * aggregates rollups into the telemetry table. Logs Insights covers the rest
 * (search, traces) on demand. No CloudWatch custom metrics are ever created.
 */
import { Schema } from 'effect';

export const TelemetryKind = Schema.Literals(['req', 'err', 'job', 'span', 'log', 'metric', 'env']);
export type TelemetryKind = typeof TelemetryKind.Type;

const base = {
  /** Marker so the subscription filter only matches platform lines. */
  _p: Schema.Literal(1),
  /** Epoch milliseconds. */
  ts: Schema.Finite,
  app: Schema.String,
  stage: Schema.String,
  /** Deployment id. */
  rev: Schema.String,
  trace: Schema.optional(Schema.String),
  span: Schema.optional(Schema.String),
  parent: Schema.optional(Schema.String),
};

export const RequestEvent = Schema.Struct({
  ...base,
  t: Schema.Literal('req'),
  method: Schema.String,
  /** Route pattern when known (`/api/todos/:id`), else the raw path. */
  route: Schema.String,
  path: Schema.String,
  status: Schema.Finite,
  /** Duration in ms. */
  dur: Schema.Finite,
  bytes: Schema.optional(Schema.Finite),
  country: Schema.optional(Schema.String),
  /** Hashed user id when signed in. */
  user: Schema.optional(Schema.String),
  cold: Schema.optional(Schema.Boolean),
});
export type RequestEvent = typeof RequestEvent.Type;

export const ErrorEvent = Schema.Struct({
  ...base,
  t: Schema.Literal('err'),
  source: Schema.Literals(['http', 'job', 'unhandled', 'log']),
  name: Schema.String,
  message: Schema.String,
  stack: Schema.optional(Schema.String),
  route: Schema.optional(Schema.String),
  job: Schema.optional(Schema.String),
  fingerprint: Schema.String,
});
export type ErrorEvent = typeof ErrorEvent.Type;

export const JobEvent = Schema.Struct({
  ...base,
  t: Schema.Literal('job'),
  kind: Schema.Literals(['queue', 'event', 'cron', 'invoke']),
  name: Schema.String,
  status: Schema.Literals(['ok', 'error']),
  dur: Schema.Finite,
  attempt: Schema.optional(Schema.Finite),
});
export type JobEvent = typeof JobEvent.Type;

export const SpanEvent = Schema.Struct({
  ...base,
  t: Schema.Literal('span'),
  /** `db.get`, `db.query`, `queue.send`, `events.publish`, `storage.put`, `fetch`, ... */
  op: Schema.String,
  name: Schema.optional(Schema.String),
  dur: Schema.Finite,
  status: Schema.Literals(['ok', 'error']),
  /** Start offset relative to the trace root, ms. */
  start: Schema.optional(Schema.Finite),
});
export type SpanEvent = typeof SpanEvent.Type;

/** A log line; any other fields are the structured fields it was logged with. */
export const LogEvent = Schema.StructWithRest(
  Schema.Struct({
    ...base,
    t: Schema.Literal('log'),
    level: Schema.Literals(['debug', 'info', 'warn', 'error']),
    msg: Schema.String,
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);
export type LogEvent = typeof LogEvent.Type;

export const MetricEvent = Schema.Struct({
  ...base,
  t: Schema.Literal('metric'),
  name: Schema.String,
  value: Schema.Finite,
  unit: Schema.optional(Schema.String),
});
export type MetricEvent = typeof MetricEvent.Type;

export const EnvEvent = Schema.Struct({
  ...base,
  t: Schema.Literal('env'),
  event: Schema.Literals(['start', 'stop']),
  runtime: Schema.Literals(['web', 'worker']),
  initMs: Schema.optional(Schema.Finite),
});
export type EnvEvent = typeof EnvEvent.Type;

/** One telemetry line, as the SDK writes it and the telemetry processor reads it. */
export const TelemetryEvent = Schema.Union([
  RequestEvent,
  ErrorEvent,
  JobEvent,
  SpanEvent,
  LogEvent,
  MetricEvent,
  EnvEvent,
]);
export type TelemetryEvent = typeof TelemetryEvent.Type;

/** Account-level subscription filter: only aggregate-worthy kinds reach the processor. */
export const TELEMETRY_FILTER_PATTERN =
  '{ ($._p = 1) && (($.t = "req") || ($.t = "err") || ($.t = "job") || ($.t = "metric") || ($.t = "env")) }';

export function isTelemetryEvent(v: unknown): v is TelemetryEvent {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as { _p?: unknown })._p === 1 &&
    typeof (v as { t?: unknown }).t === 'string'
  );
}

// ---------------------------------------------------------------------------
// Latency histogram (fixed buckets so rollups can be summed with DynamoDB ADD)
// ---------------------------------------------------------------------------

/** Upper bounds in ms; the last bucket is open-ended. */
export const LATENCY_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000] as const;

export function latencyBucket(ms: number): number {
  for (let i = 0; i < LATENCY_BUCKETS_MS.length; i++) if (ms <= LATENCY_BUCKETS_MS[i]!) return i;
  return LATENCY_BUCKETS_MS.length;
}

/** Approximate percentile (upper bound of the bucket containing it). `hist[i]` = count in bucket i. */
export function percentile(hist: readonly number[], p: number): number | null {
  const total = hist.reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  const target = Math.ceil((p / 100) * total);
  let seen = 0;
  for (let i = 0; i < hist.length; i++) {
    seen += hist[i] ?? 0;
    if (seen >= target)
      return LATENCY_BUCKETS_MS[i] ?? LATENCY_BUCKETS_MS[LATENCY_BUCKETS_MS.length - 1]! * 2;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rollups (telemetry table layout)
// ---------------------------------------------------------------------------

export const Resolution = Schema.Literals(['1m', '1h', '1d']);
export type Resolution = typeof Resolution.Type;

export const RESOLUTION_MS: Record<Resolution, number> = { '1m': 60_000, '1h': 3_600_000, '1d': 86_400_000 };

/** How long each resolution is kept (DynamoDB TTL). */
export const RESOLUTION_TTL_DAYS: Record<Resolution, number> = { '1m': 3, '1h': 35, '1d': 400 };

export function bucketStart(ts: number, res: Resolution): number {
  return Math.floor(ts / RESOLUTION_MS[res]) * RESOLUTION_MS[res];
}

/**
 * Telemetry table keys. `pk` groups one series family for one stage at one
 * resolution; `sk` starts with the bucket time so a Query with `BETWEEN`
 * returns a time range.
 *
 * - `m#<app>#<stage>#<res>`  sk `<iso>`           whole-stage HTTP: req, s2xx, s3xx, s4xx, s5xx, lat[], cold
 * - `r#<app>#<stage>#<res>`  sk `<iso>#<route>`   per-route HTTP (same fields, plus method)
 * - `j#<app>#<stage>#<res>`  sk `<iso>#<kind>:<name>`  jobs: ok, error, lat[]
 * - `c#<app>#<stage>#<res>`  sk `<iso>#<metric>`  custom metrics: count, sum, min, max
 * - `e#<app>#<stage>`        sk `<fingerprint>`   error groups: count, firstSeen, lastSeen, sample, status
 * - `u#<app>#<stage>`        sk `<iso>`           uptime checks: ok, status, ms
 */
export const telemetryKeys = {
  stage: (app: string, stage: string, res: Resolution) => `m#${app}#${stage}#${res}`,
  route: (app: string, stage: string, res: Resolution) => `r#${app}#${stage}#${res}`,
  job: (app: string, stage: string, res: Resolution) => `j#${app}#${stage}#${res}`,
  metric: (app: string, stage: string, res: Resolution) => `c#${app}#${stage}#${res}`,
  errors: (app: string, stage: string) => `e#${app}#${stage}`,
  uptime: (app: string, stage: string) => `u#${app}#${stage}`,
  time: (ts: number) => new Date(ts).toISOString(),
} as const;

// ---------------------------------------------------------------------------
// Error fingerprinting (Sentry-style grouping)
// ---------------------------------------------------------------------------

/** Normalize volatile parts (ids, numbers, quoted values) so similar errors group together. */
export function normalizeErrorMessage(message: string): string {
  return message
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/\b[0-9a-f]{16,}\b/gi, '<hex>')
    .replace(/(["'`]).*?\1/g, '<str>')
    .replace(/\d+/g, '<n>')
    .slice(0, 300);
}

/** First stack frame that is app code (not node internals or node_modules). */
export function topFrame(stack: string | undefined): string {
  if (!stack) return '';
  for (const line of stack.split('\n').slice(1)) {
    const l = line.trim();
    if (!l.startsWith('at ')) continue;
    if (l.includes('node:') || l.includes('node_modules')) continue;
    return l.replace(/:\d+:\d+\)?$/, '').replace(/^at /, '');
  }
  return '';
}

/** Stable short hash (FNV-1a 32-bit, hex) — no crypto dependency so the SDK stays tiny. */
export function fingerprint(parts: readonly string[]): string {
  let h = 0x811c9dc5;
  for (const ch of parts.join('|')) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export function errorFingerprint(name: string, message: string, stack?: string): string {
  return fingerprint([name, normalizeErrorMessage(message), topFrame(stack)]);
}
