/**
 * Reads rollups back out of the telemetry table and shapes them into the API
 * DTOs. The mapping functions are pure (unit tested); `TelemetryQuery` does the I/O.
 */
import { QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  type AppSummary,
  bucketStart,
  type CostResponse,
  type CustomMetricPoint,
  type CustomMetricsResponse,
  type CustomMetricStats,
  type ErrorGroup,
  type ErrorStatus,
  type JobStats,
  LATENCY_BUCKETS_MS,
  type LimitPoint,
  type LimitsResponse,
  type LimitStats,
  type MetricsPoint,
  type MetricsResponse,
  percentile,
  RESOLUTION_MS,
  type Resolution,
  type RouteStats,
  telemetryKeys,
  type UptimePoint,
} from '@ericminassian/platform-core';
import { Clock, Context, Effect, Layer } from 'effect';
import { Aws, AwsError, tryAws } from '../aws.ts';
import { Settings } from '../config.ts';

type Item = Record<string, unknown>;
const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const HIST_LEN = LATENCY_BUCKETS_MS.length + 1;

export function histogramOf(item: Item): number[] {
  return Array.from({ length: HIST_LEN }, (_, i) => num(item[`l${i}`]));
}

function addHist(into: number[], from: readonly number[]): void {
  for (let i = 0; i < HIST_LEN; i++) into[i] = (into[i] ?? 0) + (from[i] ?? 0);
}

/** Picks a resolution that keeps a chart to a few hundred points. */
export function autoResolution(fromMs: number, toMs: number): Resolution {
  const span = toMs - fromMs;
  if (span <= 6 * 3_600_000) return '1m';
  if (span <= 14 * 86_400_000) return '1h';
  return '1d';
}

export interface TimeRange {
  from: number;
  to: number;
  res: Resolution;
}

/** Parses `from`/`to` (ISO or epoch ms, or relative like `24h`) and `res` query params. */
export function parseRange(
  q: { from?: string; to?: string; range?: string; res?: string },
  now = Date.now(),
): TimeRange {
  const parse = (v: string | undefined): number | undefined => {
    if (!v) return undefined;
    if (/^\d+$/.test(v)) return Number(v);
    const t = Date.parse(v);
    return Number.isNaN(t) ? undefined : t;
  };
  const rel = (v: string | undefined): number | undefined => {
    const m = v?.match(/^(\d+)(m|h|d)$/);
    if (!m) return undefined;
    const n = Number(m[1]);
    return n * (m[2] === 'm' ? 60_000 : m[2] === 'h' ? 3_600_000 : 86_400_000);
  };
  const to = parse(q.to) ?? now;
  const from = parse(q.from) ?? to - (rel(q.range) ?? 24 * 3_600_000);
  const res = q.res === '1m' || q.res === '1h' || q.res === '1d' ? q.res : autoResolution(from, to);
  return { from, to, res };
}

/** Dense series: one point per bucket in range, zero-filled. */
export function toMetricsPoints(items: readonly Item[], range: TimeRange): MetricsPoint[] {
  const byTs = new Map(items.map((i) => [String(i.sk), i]));
  const step = RESOLUTION_MS[range.res];
  const points: MetricsPoint[] = [];
  const end = bucketStart(range.to, range.res);
  for (let t = bucketStart(range.from, range.res); t <= end && points.length < 2000; t += step) {
    const ts = telemetryKeys.time(t);
    const i = byTs.get(ts) ?? {};
    const hist = histogramOf(i);
    points.push({
      ts,
      req: num(i.req),
      s2xx: num(i.s2xx),
      s3xx: num(i.s3xx),
      s4xx: num(i.s4xx),
      s5xx: num(i.s5xx),
      p50: percentile(hist, 50),
      p95: percentile(hist, 95),
      p99: percentile(hist, 99),
      cold: num(i.cold),
    });
  }
  return points;
}

/** Sums per-route items across buckets (sk = `<iso>#<METHOD> <route>`). */
export function toRouteStats(items: readonly Item[]): RouteStats[] {
  const acc = new Map<
    string,
    { method: string; route: string; req: number; s4xx: number; s5xx: number; hist: number[] }
  >();
  for (const i of items) {
    const key = String(i.sk).slice(String(i.sk).indexOf('#') + 1);
    let a = acc.get(key);
    if (!a) {
      a = {
        method: str(i.method),
        route: str(i.route, key),
        req: 0,
        s4xx: 0,
        s5xx: 0,
        hist: Array.from({ length: HIST_LEN }, () => 0),
      };
      acc.set(key, a);
    }
    a.req += num(i.req);
    a.s4xx += num(i.s4xx);
    a.s5xx += num(i.s5xx);
    addHist(a.hist, histogramOf(i));
  }
  return [...acc.values()]
    .map((a) => ({
      route: a.route,
      method: a.method,
      req: a.req,
      s4xx: a.s4xx,
      s5xx: a.s5xx,
      p50: percentile(a.hist, 50),
      p95: percentile(a.hist, 95),
    }))
    .toSorted((x, y) => y.req - x.req);
}

/** Sums per-job items (sk = `<iso>#<kind>:<name>`). `declared` adds never-run jobs from the manifest. */
export function toJobStats(
  items: readonly Item[],
  declared: readonly { kind: JobStats['kind']; name: string }[] = [],
): JobStats[] {
  const acc = new Map<
    string,
    { kind: JobStats['kind']; name: string; ok: number; error: number; hist: number[]; last: number }
  >();
  const get = (kind: JobStats['kind'], name: string) => {
    const key = `${kind}:${name}`;
    let a = acc.get(key);
    if (!a) {
      a = { kind, name, ok: 0, error: 0, hist: Array.from({ length: HIST_LEN }, () => 0), last: 0 };
      acc.set(key, a);
    }
    return a;
  };
  for (const d of declared) get(d.kind, d.name);
  for (const i of items) {
    const a = get(i.kind as JobStats['kind'], String(i.name));
    a.ok += num(i.ok);
    a.error += num(i.error);
    addHist(a.hist, histogramOf(i));
    a.last = Math.max(a.last, num(i.lastRun));
  }
  return [...acc.values()].map((a) => ({
    kind: a.kind,
    name: a.name,
    ok: a.ok,
    error: a.error,
    p95: percentile(a.hist, 95),
    ...(a.last ? { lastRun: new Date(a.last).toISOString() } : {}),
  }));
}

/** Items of a `<iso>#<name>` series family, by name and then bucket time. */
function byName(items: readonly Item[]): Map<string, Map<string, Item>> {
  const out = new Map<string, Map<string, Item>>();
  for (const i of items) {
    const sk = String(i.sk);
    const at = sk.indexOf('#');
    const name = str(i.name, sk.slice(at + 1));
    const buckets = out.get(name) ?? new Map<string, Item>();
    buckets.set(sk.slice(0, at), i);
    out.set(name, buckets);
  }
  return out;
}

/** The bucket start times of `range`, as the telemetry table's ISO keys. */
function bucketTimes(range: TimeRange): string[] {
  const step = RESOLUTION_MS[range.res];
  const end = bucketStart(range.to, range.res);
  const times: string[] = [];
  for (let t = bucketStart(range.from, range.res); t <= end && times.length < 2000; t += step)
    times.push(telemetryKeys.time(t));
  return times;
}

/**
 * Per-metric totals and zero-filled series from custom metric items
 * (sk = `<iso>#<metric>`), by name. The unit is the latest one recorded.
 */
export function toCustomMetricStats(items: readonly Item[], range: TimeRange): CustomMetricStats[] {
  const times = bucketTimes(range);
  return [...byName(items)]
    .map(([name, buckets]) => {
      const points: CustomMetricPoint[] = times.map((ts) => {
        const i = buckets.get(ts);
        return { ts, count: num(i?.count), sum: num(i?.sum) };
      });
      const unit = [...buckets.values()].map((i) => i.unit).findLast((u) => typeof u === 'string');
      return {
        name,
        ...(typeof unit === 'string' ? { unit } : {}),
        count: points.reduce((a, p) => a + p.count, 0),
        sum: points.reduce((a, p) => a + p.sum, 0),
        points,
      };
    })
    .toSorted((x, y) => x.name.localeCompare(y.name));
}

/**
 * Per-limit totals and zero-filled series from rate limit items
 * (sk = `<iso>#<limit>`), most denied first.
 */
export function toLimitStats(items: readonly Item[], range: TimeRange): LimitStats[] {
  const times = bucketTimes(range);
  return [...byName(items)]
    .map(([name, buckets]) => {
      const points: LimitPoint[] = times.map((ts) => {
        const i = buckets.get(ts);
        return { ts, allowed: num(i?.allowed), denied: num(i?.denied) };
      });
      return {
        name,
        allowed: points.reduce((a, p) => a + p.allowed, 0),
        denied: points.reduce((a, p) => a + p.denied, 0),
        points,
      };
    })
    .toSorted((x, y) => y.denied - x.denied || y.allowed - x.allowed || x.name.localeCompare(y.name));
}

export function toErrorGroup(i: Item): ErrorGroup {
  return {
    fingerprint: String(i.sk),
    stage: str(i.stage),
    name: str(i.name, 'Error'),
    message: str(i.message),
    source: str(i.source),
    count: num(i.count),
    firstSeen: str(i.firstSeen),
    lastSeen: str(i.lastSeen),
    status: i.status === 'resolved' || i.status === 'ignored' ? i.status : 'open',
    sample: (i.sample as ErrorGroup['sample']) ?? {},
  };
}

/** Last-hour health summary for an app's prod stage (from 1m buckets). */
export function summarizeHealth(
  points: readonly MetricsPoint[],
  items: readonly Item[],
  up: boolean | null,
): NonNullable<AppSummary['health']> {
  const req = points.reduce((a, p) => a + p.req, 0);
  const errors = points.reduce((a, p) => a + p.s5xx, 0);
  const hist = Array.from({ length: HIST_LEN }, () => 0);
  for (const i of items) addHist(hist, histogramOf(i));
  return {
    up,
    reqPerMin: points.length ? Math.round((req / points.length) * 100) / 100 : 0,
    errorRate: req ? errors / req : 0,
    p95: percentile(hist, 95),
  };
}

// ------------------------------------------------------------------ I/O

const isoRange = (r: TimeRange): [string, string] => [
  telemetryKeys.time(bucketStart(r.from, r.res)),
  `${telemetryKeys.time(r.to)}\uffff`,
];

/** Routes/jobs/metrics/limits series only exist at 1h and 1d. */
const seriesRange = (r: TimeRange): TimeRange => ({ ...r, res: r.res === '1m' ? '1h' : r.res });

/** Cost items: pk `cost#<app>` (or `cost#_total`), sk `YYYY-MM-DD`, written by the cost job. */
export const costKey = (app: string) => `cost#${app}`;

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export class TelemetryQuery extends Context.Service<
  TelemetryQuery,
  {
    metrics(app: string, stage: string, range: TimeRange): Effect.Effect<MetricsResponse>;
    routes(app: string, stage: string, range: TimeRange): Effect.Effect<ReadonlyArray<RouteStats>>;
    /** `declared` adds the manifest's jobs that never ran. */
    jobs(
      app: string,
      stage: string,
      range: TimeRange,
      declared: ReadonlyArray<{ kind: JobStats['kind']; name: string }>,
    ): Effect.Effect<ReadonlyArray<JobStats>>;
    /** `Metrics.count`/`value` series per name, at 1h or 1d. */
    customMetrics(app: string, stage: string, range: TimeRange): Effect.Effect<CustomMetricsResponse>;
    /** Rate limit checks per limit, at 1h or 1d. */
    limits(app: string, stage: string, range: TimeRange): Effect.Effect<LimitsResponse>;
    /** Most recently seen first. */
    errors(app: string, stage: string): Effect.Effect<ReadonlyArray<ErrorGroup>>;
    /** Triage from the console (the one write the API makes here); false when there's no such group. */
    setErrorStatus(
      app: string,
      stage: string,
      fingerprint: string,
      status: ErrorStatus,
    ): Effect.Effect<boolean>;
    uptime(app: string, stage: string, range: TimeRange): Effect.Effect<ReadonlyArray<UptimePoint>>;
    /** Daily cost over the last `days` days (default 35). */
    cost(app: string, days?: number): Effect.Effect<CostResponse>;
    /** Last-hour health of an app's prod stage. */
    health(app: string, up: boolean | null): Effect.Effect<NonNullable<AppSummary['health']>>;
  }
>()('@ericminassian/platform-control-plane/TelemetryQuery') {
  static readonly layer: Layer.Layer<TelemetryQuery, never, Aws | Settings> = Layer.effect(
    TelemetryQuery,
    Effect.gen(function* () {
      const aws = yield* Aws;
      const settings = yield* Settings;

      const queryRange = Effect.fnUntraced(function* (pk: string, fromSk: string, toSk: string) {
        const { telemetryTable } = yield* settings.runtime;
        const items: Item[] = [];
        let ExclusiveStartKey: Record<string, unknown> | undefined;
        do {
          const res = yield* tryAws(() =>
            aws.ddb().send(
              new QueryCommand({
                TableName: telemetryTable,
                KeyConditionExpression: 'pk = :pk AND sk BETWEEN :a AND :b',
                ExpressionAttributeValues: { ':pk': pk, ':a': fromSk, ':b': toSk },
                ExclusiveStartKey,
              }),
            ),
          );
          items.push(...(res.Items ?? []));
          ExclusiveStartKey = res.LastEvaluatedKey;
        } while (ExclusiveStartKey && items.length < 20_000);
        return items;
      });

      const metrics = Effect.fn('TelemetryQuery.metrics')(function* (
        app: string,
        stage: string,
        range: TimeRange,
      ) {
        const [a, b] = isoRange(range);
        const items = yield* queryRange(telemetryKeys.stage(app, stage, range.res), a, b);
        return {
          app,
          stage,
          res: range.res,
          points: toMetricsPoints(items, range),
        } satisfies MetricsResponse;
      }, Effect.orDie);

      const routes = Effect.fn('TelemetryQuery.routes')(function* (
        app: string,
        stage: string,
        range: TimeRange,
      ) {
        const r = seriesRange(range);
        const [a, b] = isoRange(r);
        return toRouteStats(yield* queryRange(telemetryKeys.route(app, stage, r.res), a, b));
      }, Effect.orDie);

      const jobs = Effect.fn('TelemetryQuery.jobs')(function* (
        app: string,
        stage: string,
        range: TimeRange,
        declared: ReadonlyArray<{ kind: JobStats['kind']; name: string }>,
      ) {
        const r = seriesRange(range);
        const [a, b] = isoRange(r);
        return toJobStats(yield* queryRange(telemetryKeys.job(app, stage, r.res), a, b), declared);
      }, Effect.orDie);

      const customMetrics = Effect.fn('TelemetryQuery.customMetrics')(function* (
        app: string,
        stage: string,
        range: TimeRange,
      ) {
        const r = seriesRange(range);
        const [a, b] = isoRange(r);
        const items = yield* queryRange(telemetryKeys.metric(app, stage, r.res), a, b);
        return {
          app,
          stage,
          res: r.res,
          metrics: toCustomMetricStats(items, r),
        } satisfies CustomMetricsResponse;
      }, Effect.orDie);

      const limits = Effect.fn('TelemetryQuery.limits')(function* (
        app: string,
        stage: string,
        range: TimeRange,
      ) {
        const r = seriesRange(range);
        const [a, b] = isoRange(r);
        const items = yield* queryRange(telemetryKeys.limit(app, stage, r.res), a, b);
        return { app, stage, res: r.res, limits: toLimitStats(items, r) } satisfies LimitsResponse;
      }, Effect.orDie);

      const errors = Effect.fn('TelemetryQuery.errors')(function* (app: string, stage: string) {
        const { telemetryTable } = yield* settings.runtime;
        const res = yield* tryAws(() =>
          aws.ddb().send(
            new QueryCommand({
              TableName: telemetryTable,
              KeyConditionExpression: 'pk = :pk',
              ExpressionAttributeValues: { ':pk': telemetryKeys.errors(app, stage) },
            }),
          ),
        );
        return (res.Items ?? []).map(toErrorGroup).toSorted((x, y) => y.lastSeen.localeCompare(x.lastSeen));
      }, Effect.orDie);

      const setErrorStatus = Effect.fn('TelemetryQuery.setErrorStatus')(function* (
        app: string,
        stage: string,
        fingerprint: string,
        status: ErrorStatus,
      ) {
        const { telemetryTable } = yield* settings.runtime;
        return yield* tryAws(() =>
          aws.ddb().send(
            new UpdateCommand({
              TableName: telemetryTable,
              Key: { pk: telemetryKeys.errors(app, stage), sk: fingerprint },
              UpdateExpression: 'SET #s = :s',
              ConditionExpression: 'attribute_exists(pk)',
              ExpressionAttributeNames: { '#s': 'status' },
              ExpressionAttributeValues: { ':s': status },
            }),
          ),
        ).pipe(
          Effect.as(true),
          Effect.catchIf(AwsError.is('ConditionalCheckFailedException'), () => Effect.succeed(false)),
        );
      }, Effect.orDie);

      const uptime = Effect.fn('TelemetryQuery.uptime')(function* (
        app: string,
        stage: string,
        range: TimeRange,
      ) {
        const items = yield* queryRange(
          telemetryKeys.uptime(app, stage),
          telemetryKeys.time(range.from),
          `${telemetryKeys.time(range.to)}\uffff`,
        );
        return items.map((i): UptimePoint => ({
          ts: String(i.sk),
          ok: Boolean(i.ok),
          status: num(i.status),
          ms: num(i.ms),
        }));
      }, Effect.orDie);

      const cost = Effect.fn('TelemetryQuery.cost')(function* (app: string, days = 35) {
        const now = yield* Clock.currentTimeMillis;
        const today = day(now);
        const items = yield* queryRange(costKey(app), day(now - days * 86_400_000), today);
        const series = items.map((i) => ({ date: String(i.sk), usd: num(i.usd) }));
        const month = today.slice(0, 7);
        const monthToDateUsd = series.filter((d) => d.date.startsWith(month)).reduce((a, d) => a + d.usd, 0);
        return {
          app,
          currency: 'USD',
          days: series,
          monthToDateUsd: Math.round(monthToDateUsd * 100) / 100,
        } satisfies CostResponse;
      }, Effect.orDie);

      const health = Effect.fn('TelemetryQuery.health')(function* (app: string, up: boolean | null) {
        const now = yield* Clock.currentTimeMillis;
        const range: TimeRange = { from: now - 3_600_000, to: now, res: '1m' };
        const [a, b] = isoRange(range);
        const items = yield* queryRange(telemetryKeys.stage(app, 'prod', '1m'), a, b);
        return summarizeHealth(toMetricsPoints(items, range), items, up);
      }, Effect.orDie);

      return TelemetryQuery.of({
        metrics,
        routes,
        jobs,
        customMetrics,
        limits,
        errors,
        setErrorStatus,
        uptime,
        cost,
        health,
      });
    }),
  );
}
