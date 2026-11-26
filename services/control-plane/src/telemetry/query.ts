/**
 * Reads rollups back out of the telemetry table and shapes them into the API
 * DTOs. The mapping functions are pure (unit tested); `TelemetryQuery` does the I/O.
 */
import { QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  type AppSummary,
  autoQueryResolution,
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
  type MinuteTraffic,
  PROD_STAGE,
  percentile,
  QUERY_RESOLUTION_MS,
  type QueryResolution,
  RESOLUTION_MS,
  RESOLUTION_TTL_DAYS,
  type Resolution,
  type RouteStats,
  type SeriesGroupBy,
  type SeriesQuery,
  type SeriesResponse,
  type SeriesStat,
  STATUS_CLASSES,
  type StatusClass,
  seriesUnit,
  telemetryKeys,
  type UptimePoint,
} from '@ericminassian/platform-core';
import { absurd, Clock, Context, Effect, Layer, Option } from 'effect';
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

/**
 * A stage's busy minutes, as the compute chooser simulates them, and its
 * servers' average INIT (none until a start reported one). Rows written
 * before minute rollups summed handling time (`dur`) get it from their
 * latency histogram: each bucket's requests at its midpoint.
 */
export function toStageTraffic(items: readonly Item[]): { minutes: MinuteTraffic[]; initMs?: number } {
  let inits = 0;
  let initMs = 0;
  const minutes: MinuteTraffic[] = [];
  for (const i of items) {
    inits += num(i.webInits);
    initMs += num(i.webInitMs);
    const req = num(i.req);
    if (req <= 0) continue;
    const durMs =
      typeof i.dur === 'number'
        ? i.dur
        : histogramOf(i).reduce((sum, n, b) => sum + n * HIST_MIDPOINTS_MS[b]!, 0);
    minutes.push({ ts: Date.parse(String(i.sk)), req, durMs });
  }
  return { minutes, ...(inits > 0 ? { initMs: Math.round(initMs / inits) } : {}) };
}

/** Each latency bucket's midpoint; the open last one at 1.5× its lower bound. */
const HIST_MIDPOINTS_MS = [...LATENCY_BUCKETS_MS, LATENCY_BUCKETS_MS.at(-1)! * 2].map((upper, b, all) => {
  const lower = b === 0 ? 0 : all[b - 1]!;
  return b === all.length - 1 ? lower * 1.5 : (lower + upper) / 2;
});

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

/**
 * Sums per-job items (sk = `<iso>#<kind>:<name>`). `declared` adds never-run
 * jobs from the manifest. A service's row can hold only container starts;
 * without a run it isn't a job.
 */
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
  const listed = new Set(acc.keys());
  for (const i of items) {
    const a = get(i.kind as JobStats['kind'], String(i.name));
    a.ok += num(i.ok);
    a.error += num(i.error);
    addHist(a.hist, histogramOf(i));
    a.last = Math.max(a.last, num(i.lastRun));
  }
  return [...acc.entries()]
    .filter(([key, a]) => a.ok + a.error > 0 || listed.has(key))
    .map(([, a]) => ({
      kind: a.kind,
      name: a.name,
      ok: a.ok,
      error: a.error,
      p95: percentile(a.hist, 95),
      ...(a.last ? { lastRun: new Date(a.last).toISOString() } : {}),
    }));
}

export interface ServiceRuns {
  /** Containers of the service that started. */
  readonly starts: number;
  /** Runs of its `run` that failed (and were rerun). */
  readonly failedRuns: number;
}

/**
 * Starts and failed runs per service, from its job rows (`service:<name>`).
 * Rows of units of work it traced (`service:<name>/<unit>`) aren't runs.
 */
export function toServiceRuns(items: readonly Item[]): Map<string, ServiceRuns> {
  const out = new Map<string, ServiceRuns>();
  for (const i of items) {
    const name = str(i.name);
    if (i.kind !== 'service' || !name || name.includes('/')) continue;
    const prev = out.get(name) ?? { starts: 0, failedRuns: 0 };
    out.set(name, { starts: prev.starts + num(i.starts), failedRuns: prev.failedRuns + num(i.error) });
  }
  return out;
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

/** Daily edge rollups as page views and requests on each of `days` (UTC day starts), oldest first. */
export function toEdgeDays(
  items: readonly Item[],
  days: readonly number[],
): { readonly pageViews: number[]; readonly requests: number[] } {
  const slot = new Map(days.map((d, i) => [telemetryKeys.time(d), i]));
  const pageViews = days.map(() => 0);
  const requests = days.map(() => 0);
  for (const i of items) {
    const at = slot.get(String(i.sk));
    if (at === undefined) continue;
    pageViews[at] = num(i.pages);
    requests[at] = num(i.req);
  }
  return { pageViews, requests };
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

/**
 * An uptime row as the API shows it (pure). The pinger writes `source`; rows
 * from before it counted traffic have none and were all health checks.
 */
export function toUptimePoint(i: Item): UptimePoint {
  const ts = String(i.sk);
  const ok = Boolean(i.ok);
  return i.source === 'traffic'
    ? { ts, ok, source: 'traffic', req: num(i.req), s5xx: num(i.s5xx) }
    : { ts, ok, source: 'check', status: num(i.status), ms: num(i.ms) };
}

// ------------------------------------------------------------------ explorer series

/** A series query's range; `res` may be any of the explorer's resolutions. */
export interface SeriesRange {
  readonly from: number;
  readonly to: number;
  readonly res: QueryResolution;
}

/**
 * Parses `from`/`to`/`range` like `parseRange`; without `res`, picks one for
 * about `TARGET_POINTS` buckets given how far back minute data reaches.
 */
export function parseSeriesRange(
  q: { from?: string; to?: string; range?: string },
  res: QueryResolution | undefined,
  now: number,
  minuteHorizonMs: number,
): SeriesRange {
  const { from, to } = parseRange(q, now);
  return { from, to, res: res ?? autoQueryResolution(from, to, now, minuteHorizonMs) };
}

/** A series range's bucket starts, oldest first (at most 2,000), and each one's index. */
export function seriesBuckets(range: SeriesRange) {
  const step = QUERY_RESOLUTION_MS[range.res];
  const times: number[] = [];
  const end = Math.floor(range.to / step) * step;
  for (let t = Math.floor(range.from / step) * step; t <= end && times.length < 2000; t += step)
    times.push(t);
  return { step, times, slot: new Map(times.map((t, i) => [t, i])) };
}

/** How far back rows of a stored resolution reach (their TTL). */
export const storedHorizonMs = (res: Resolution): number => RESOLUTION_TTL_DAYS[res] * 86_400_000;

/** The stored rows each resolution is built from: 5m–30m are sums of minute rows. */
const STORED_RES: Record<QueryResolution, Resolution> = {
  '1m': '1m',
  '5m': '1m',
  '10m': '1m',
  '15m': '1m',
  '30m': '1m',
  '1h': '1h',
  '1d': '1d',
};

/**
 * The rows a series reads (`stored`) and the buckets it answers in: a range
 * that starts before the rows it would read expire is answered in the next
 * stored resolution up, and `note` says so.
 */
export function seriesPlan(
  range: SeriesRange,
  now: number,
): { readonly range: SeriesRange; readonly stored: Resolution; readonly note?: string } {
  let res = range.res;
  let note: string | undefined;
  if (STORED_RES[res] === '1m' && range.from < now - storedHorizonMs('1m')) {
    res = '1h';
    note = `minute data is kept for ${RESOLUTION_TTL_DAYS['1m']} days, so this range is in 1h buckets`;
  }
  if (res === '1h' && range.from < now - storedHorizonMs('1h')) {
    res = '1d';
    note = `hourly data is kept for ${RESOLUTION_TTL_DAYS['1h']} days, so this range is in 1d buckets`;
  }
  return { range: { ...range, res }, stored: STORED_RES[res], ...(note ? { note } : {}) };
}

/** The rollup family a query reads (`telemetryKeys`); none for the CloudWatch metrics. */
export type SeriesFamily = 'stage' | 'route' | 'job' | 'metric' | 'limit' | 'edge';

export function seriesFamily(q: SeriesQuery): SeriesFamily | undefined {
  switch (q.metric) {
    case 'requests':
    case 'latency':
    case 'cold_starts':
      return q.filter?.routes?.length || q.groupBy === 'route' ? 'route' : 'stage';
    case 'page_views':
    case 'edge_requests':
      return 'edge';
    case 'jobs':
    case 'job_duration':
      return 'job';
    case 'custom':
      return 'metric';
    case 'rate_limit':
      return 'limit';
    case 'realtime':
    case 'service':
      return undefined;
    default:
      return absurd(q.metric);
  }
}

const FAMILY_KEY: Record<SeriesFamily, (app: string, stage: string, res: Resolution) => string> = {
  stage: telemetryKeys.stage,
  route: telemetryKeys.route,
  job: telemetryKeys.job,
  metric: telemetryKeys.metric,
  limit: telemetryKeys.limit,
  edge: telemetryKeys.edge,
};

/**
 * What rows add up to for one line in one bucket: `num` events that match
 * (the count; for latency, every request), `den` all events in scope (what a
 * percentage divides by), recorded values' `cnt`, `sum` and `max`, and the
 * latency histogram.
 */
interface Acc {
  num: number;
  den: number;
  cnt: number;
  sum: number;
  max: number | null;
  hist: number[];
}

const emptyAcc = (): Acc => ({
  num: 0,
  den: 0,
  cnt: 0,
  sum: 0,
  max: null,
  hist: Array.from({ length: HIST_LEN }, () => 0),
});

type Contribution = Partial<Omit<Acc, 'hist'>> & { readonly hist?: readonly number[] };

function addAcc(into: Acc, c: Contribution): void {
  into.num += c.num ?? 0;
  into.den += c.den ?? 0;
  into.cnt += c.cnt ?? 0;
  into.sum += c.sum ?? 0;
  if (c.max !== undefined && c.max !== null) into.max = into.max === null ? c.max : Math.max(into.max, c.max);
  if (c.hist) addHist(into.hist, c.hist);
}

/**
 * A request row's count per status class. Route rows from before November
 * 2026 counted only 4xx and 5xx: the rest of their requests were 2xx.
 */
export function statusCounts(i: Item): Record<StatusClass, number> {
  const req = num(i.req);
  const s4xx = num(i.s4xx);
  const s5xx = num(i.s5xx);
  const legacy = i.s2xx === undefined && i.s3xx === undefined;
  return {
    '2xx': legacy ? Math.max(0, req - s4xx - s5xx) : num(i.s2xx),
    '3xx': num(i.s3xx),
    '4xx': s4xx,
    '5xx': s5xx,
  };
}

/** The line key every row of an ungrouped query adds to. */
export const ALL_SERIES = 'all';

/** What one rollup row adds to each line it belongs to; a row the filter leaves out adds nothing. */
function rowContributions(
  q: SeriesQuery,
  family: SeriesFamily,
  i: Item,
): Array<readonly [string, Contribution]> {
  const f = q.filter ?? {};
  const sk = String(i.sk);
  // `<iso>` for whole-stage rows, `<iso>#<route | kind:name | name>` for the rest.
  const key = family === 'stage' ? '' : sk.slice(sk.indexOf('#') + 1);
  const keep = (list: ReadonlyArray<string> | undefined, value: string) =>
    !list?.length || list.includes(value);
  switch (q.metric) {
    case 'requests': {
      if (!keep(f.routes, key)) return [];
      const counts = statusCounts(i);
      const req = num(i.req);
      if (q.groupBy === 'status')
        return (f.status?.length ? f.status : STATUS_CLASSES).map((c) => [c, { num: counts[c], den: req }]);
      const matching = f.status?.length ? f.status.reduce((a, c) => a + counts[c], 0) : req;
      return [[q.groupBy === 'route' ? key : ALL_SERIES, { num: matching, den: req }]];
    }
    case 'page_views': {
      const pages = num(i.pages);
      return [[ALL_SERIES, { num: pages, den: pages }]];
    }
    case 'edge_requests': {
      const counts = statusCounts(i);
      const req = num(i.req);
      if (q.groupBy === 'status')
        return (f.status?.length ? f.status : STATUS_CLASSES).map((c) => [c, { num: counts[c], den: req }]);
      const matching = f.status?.length ? f.status.reduce((a, c) => a + counts[c], 0) : req;
      return [[ALL_SERIES, { num: matching, den: req }]];
    }
    case 'latency': {
      if (!keep(f.routes, key)) return [];
      const hist = histogramOf(i);
      const n = hist.reduce((a, b) => a + b, 0);
      return [[q.groupBy === 'route' ? key : ALL_SERIES, { num: n, den: n, hist }]];
    }
    case 'cold_starts':
      if (!keep(f.routes, key)) return [];
      return [[ALL_SERIES, { num: num(i.cold), den: num(i.req) }]];
    case 'jobs': {
      if (!keep(f.jobs, key)) return [];
      const ok = num(i.ok);
      const error = num(i.error);
      const runs = ok + error;
      if (q.groupBy === 'outcome')
        return (f.outcome ? [f.outcome] : ['ok', 'error']).map((o) => [
          o,
          { num: o === 'ok' ? ok : error, den: runs },
        ]);
      const matching = f.outcome === 'ok' ? ok : f.outcome === 'error' ? error : runs;
      return [[q.groupBy === 'job' ? key : ALL_SERIES, { num: matching, den: runs }]];
    }
    case 'job_duration': {
      if (!keep(f.jobs, key)) return [];
      const hist = histogramOf(i);
      const n = hist.reduce((a, b) => a + b, 0);
      return [[q.groupBy === 'job' ? key : ALL_SERIES, { num: n, den: n, hist }]];
    }
    case 'custom': {
      const name = str(i.name, key);
      if (!keep(f.names, name)) return [];
      const count = num(i.count);
      return [
        [
          q.groupBy === 'name' ? name : ALL_SERIES,
          {
            num: count,
            den: count,
            cnt: count,
            sum: num(i.sum),
            max: typeof i.max === 'number' ? i.max : null,
          },
        ],
      ];
    }
    case 'rate_limit': {
      const name = str(i.name, key);
      if (!keep(f.names, name)) return [];
      const allowed = num(i.allowed);
      const denied = num(i.denied);
      const checks = allowed + denied;
      if (q.groupBy === 'outcome')
        return (f.outcome ? [f.outcome] : ['allowed', 'denied']).map((o) => [
          o,
          { num: o === 'allowed' ? allowed : denied, den: checks },
        ]);
      // A share of checks is the denied share unless the filter says otherwise.
      const pick = f.outcome ?? (q.stat === 'percent' ? 'denied' : undefined);
      const matching = pick === 'allowed' ? allowed : pick === 'denied' ? denied : checks;
      return [[q.groupBy === 'name' ? name : ALL_SERIES, { num: matching, den: checks }]];
    }
    case 'realtime':
    case 'service':
      return [];
    default:
      return absurd(q.metric);
  }
}

/** Six significant digits are plenty for a chart, and keep `33.333333333333336` off the wire. */
const tidy = (v: number): number => Number(v.toPrecision(6));

/**
 * A statistic of what a line's rows add up to over `seconds`. Counts and sums
 * are 0 with nothing behind them; shares, averages, maxima and percentiles
 * are null. `histogram` answers the event count (its buckets go in the
 * response's `histogram`).
 */
function statValue(a: Acc, stat: SeriesStat, seconds: number): number | null {
  switch (stat) {
    case 'count':
    case 'histogram':
      return a.num;
    case 'rate':
      return tidy(a.num / seconds);
    case 'percent':
      return a.den ? tidy((100 * a.num) / a.den) : null;
    case 'sum':
      return tidy(a.sum);
    case 'avg':
      return a.cnt ? tidy(a.sum / a.cnt) : null;
    case 'max':
      return a.max;
    case 'p50':
      return percentile(a.hist, 50);
    case 'p90':
      return percentile(a.hist, 90);
    case 'p95':
      return percentile(a.hist, 95);
    case 'p99':
      return percentile(a.hist, 99);
    default:
      return absurd(stat);
  }
}

/** Groups a chart keeps, by volume; the rest are left out with a `note`. */
export const MAX_SERIES_LINES = 10;

const GROUP_NOUN: Record<SeriesGroupBy, string> = {
  status: 'status classes',
  route: 'routes',
  job: 'jobs',
  outcome: 'outcomes',
  name: 'names',
};

/** Status classes and outcomes in their natural order; other groups by volume. */
const NATURAL_ORDER: readonly string[] = [...STATUS_CLASSES, 'ok', 'error', 'allowed', 'denied'];

/**
 * A query's answer from rollup rows of `family` (pure): dense buckets of
 * `range.res` from `range.from` to `range.to`, oldest first, one line per
 * group (the top `MAX_SERIES_LINES` by volume) or one `all` line. Rows are
 * summed into coarser buckets, histograms included, so 5-minute buckets are
 * built from minute rows.
 */
export function toSeriesResponse(
  items: readonly Item[],
  q: SeriesQuery,
  family: SeriesFamily,
  range: SeriesRange,
  note?: string,
): SeriesResponse {
  const { step, times, slot } = seriesBuckets(range);

  const groups = new Map<string, { total: Acc; buckets: Array<Acc | undefined>; unit?: string }>();
  const group = (key: string) => {
    let g = groups.get(key);
    if (!g) {
      g = { total: emptyAcc(), buckets: Array.from({ length: times.length }, () => undefined) };
      groups.set(key, g);
    }
    return g;
  };
  for (const i of items) {
    const sk = String(i.sk);
    const at = sk.indexOf('#');
    const ts = Date.parse(at === -1 ? sk : sk.slice(0, at));
    const index = slot.get(Math.floor(ts / step) * step);
    if (index === undefined) continue;
    for (const [key, c] of rowContributions(q, family, i)) {
      const g = group(key);
      addAcc(g.total, c);
      addAcc((g.buckets[index] ??= emptyAcc()), c);
      if (typeof i.unit === 'string') g.unit = i.unit;
    }
  }

  const notes = note ? [note] : [];
  let keys: string[];
  if (!q.groupBy) {
    group(ALL_SERIES);
    keys = [ALL_SERIES];
  } else {
    const dim = q.groupBy;
    const present = [...groups].filter(([, g]) =>
      dim === 'status' || dim === 'outcome' || q.stat !== 'percent' ? g.total.num > 0 : g.total.den > 0,
    );
    const weight = (a: Acc) => (q.stat === 'sum' ? Math.abs(a.sum) : a.num);
    keys = present
      .toSorted(([ka, a], [kb, b]) =>
        dim === 'status' || dim === 'outcome'
          ? NATURAL_ORDER.indexOf(ka) - NATURAL_ORDER.indexOf(kb)
          : weight(b.total) - weight(a.total) || b.total.den - a.total.den || ka.localeCompare(kb),
      )
      .map(([k]) => k);
    if (keys.length > MAX_SERIES_LINES) {
      notes.push(`showing the top ${MAX_SERIES_LINES} of ${keys.length} ${GROUP_NOUN[dim]}`);
      keys = keys.slice(0, MAX_SERIES_LINES);
    }
  }

  const seconds = step / 1000;
  const empty = emptyAcc();
  const series = keys.map((key) => ({
    key,
    values: groups.get(key)!.buckets.map((b) => statValue(b ?? empty, q.stat, seconds)),
  }));
  // A custom metric's values are in its own unit, when every line records the same one.
  const units = new Set(keys.map((k) => groups.get(k)!.unit));
  const [only] = units;
  const ownUnit =
    q.metric === 'custom' && (q.stat === 'sum' || q.stat === 'avg' || q.stat === 'max') && units.size === 1
      ? only
      : undefined;
  return {
    res: range.res,
    timestamps: times.map((t) => telemetryKeys.time(t)),
    unit: ownUnit ?? seriesUnit(q),
    series,
    ...(q.stat === 'histogram'
      ? {
          histogram: times.map((_, index) => {
            const merged = emptyAcc();
            for (const k of keys) {
              const b = groups.get(k)!.buckets[index];
              if (b) addAcc(merged, b);
            }
            return merged.hist;
          }),
        }
      : {}),
    ...(notes.length ? { note: notes.join('; ') } : {}),
  };
}

/**
 * The query's statistic over the whole of `from`..`to` (`to` excluded), as an
 * alert rule reads it: the window's counts, shares and merged histogram, not
 * an average of its buckets. Null when nothing is behind a share, average,
 * maximum or percentile.
 */
export function windowValue(
  items: readonly Item[],
  q: SeriesQuery,
  family: SeriesFamily,
  from: number,
  to: number,
): number | null {
  const acc = emptyAcc();
  const { groupBy: _, ...ungrouped } = q;
  for (const i of items) {
    const sk = String(i.sk);
    const at = sk.indexOf('#');
    const ts = Date.parse(at === -1 ? sk : sk.slice(0, at));
    if (ts < from || ts >= to) continue;
    for (const [, c] of rowContributions(ungrouped, family, i)) addAcc(acc, c);
  }
  return statValue(acc, q.stat, (to - from) / 1000);
}

// ------------------------------------------------------------------ I/O

const isoRange = (r: TimeRange): [string, string] => [
  telemetryKeys.time(bucketStart(r.from, r.res)),
  `${telemetryKeys.time(r.to)}\uffff`,
];

/**
 * The route, job, metric and limit summaries read hourly and daily rows:
 * those families have had minute rows only since November 2026, and only the
 * explorer's series read them.
 */
const seriesRange = (r: TimeRange): TimeRange => ({ ...r, res: r.res === '1m' ? '1h' : r.res });

/**
 * Rows a series reads at most. A day of 10-minute buckets of 20 routes is
 * 28,800 minute rows (about 6 MB, a second of reads).
 */
const SERIES_MAX_ROWS = 100_000;

/** Cost items: pk `cost#<app>` (or `cost#_total`), sk `YYYY-MM-DD`, written by the cost job. */
export const costKey = (app: string) => `cost#${app}`;

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export class TelemetryQuery extends Context.Service<
  TelemetryQuery,
  {
    metrics(app: string, stage: string, range: TimeRange): Effect.Effect<MetricsResponse>;
    /** The explorer's query over `range`, from rollups (not `realtime` or `service`). */
    series(app: string, stage: string, query: SeriesQuery, range: SeriesRange): Effect.Effect<SeriesResponse>;
    /** The query's statistic over the whole of `from`..`to` (`windowValue`), from minute rollups. */
    seriesWindow(
      app: string,
      stage: string,
      query: SeriesQuery,
      from: number,
      to: number,
    ): Effect.Effect<number | null>;
    /** Prod's requests in each of the last 24 hours, oldest first (the current hour last). */
    traffic(app: string): Effect.Effect<ReadonlyArray<number>>;
    /** The stage's page views and edge requests on each of `days` (UTC day starts, oldest first). */
    edgeDays(
      app: string,
      stage: string,
      days: readonly number[],
    ): Effect.Effect<{ readonly pageViews: number[]; readonly requests: number[] }>;
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
    /** Container starts and failed runs of each of the stage's services. */
    serviceRuns(
      app: string,
      stage: string,
      range: TimeRange,
    ): Effect.Effect<ReadonlyMap<string, ServiceRuns>>;
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
    /** The stage's newest uptime row: the pinger's memory of how it last knew the stage was up. */
    lastUptime(app: string, stage: string): Effect.Effect<Option.Option<UptimePoint>>;
    /** Daily cost over the last `days` days (default 35). */
    cost(app: string, days?: number): Effect.Effect<CostResponse>;
    /** Last-hour health of an app's prod stage. */
    health(app: string, up: boolean | null): Effect.Effect<NonNullable<AppSummary['health']>>;
    /** The stage's busy minutes in `from`..`to` (`toStageTraffic`), from its minute rollups. */
    stageTraffic(
      app: string,
      stage: string,
      from: number,
      to: number,
    ): Effect.Effect<{ readonly minutes: ReadonlyArray<MinuteTraffic>; readonly initMs?: number }>;
  }
>()('@ericminassian/platform-control-plane/TelemetryQuery') {
  static readonly layer: Layer.Layer<TelemetryQuery, never, Aws | Settings> = Layer.effect(
    TelemetryQuery,
    Effect.gen(function* () {
      const aws = yield* Aws;
      const settings = yield* Settings;

      const queryRange = Effect.fnUntraced(function* (
        pk: string,
        fromSk: string,
        toSk: string,
        limit: number = 20_000,
      ) {
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
        } while (ExclusiveStartKey && items.length < limit);
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

      /** The rollup family a query reads; realtime and service queries are answered from CloudWatch. */
      const familyOf = (query: SeriesQuery) => {
        const family = seriesFamily(query);
        return family
          ? Effect.succeed(family)
          : Effect.die(new Error(`${query.metric} is read from CloudWatch, not the rollups`));
      };

      const readSeries = Effect.fn('TelemetryQuery.series')(function* (
        app: string,
        stage: string,
        query: SeriesQuery,
        requested: SeriesRange,
      ) {
        const family = yield* familyOf(query);
        const plan = seriesPlan(requested, yield* Clock.currentTimeMillis);
        const step = QUERY_RESOLUTION_MS[plan.range.res];
        const items = yield* queryRange(
          FAMILY_KEY[family](app, stage, plan.stored),
          telemetryKeys.time(Math.floor(plan.range.from / step) * step),
          `${telemetryKeys.time(plan.range.to)}\uffff`,
          SERIES_MAX_ROWS,
        );
        const cut =
          items.length >= SERIES_MAX_ROWS
            ? `the range has more than ${SERIES_MAX_ROWS} rows, so its newest buckets are missing: narrow the range or filter`
            : undefined;
        const note = [plan.note, cut].filter(Boolean).join('; ');
        return toSeriesResponse(items, query, family, plan.range, note || undefined);
      }, Effect.orDie);

      const seriesWindow = Effect.fn('TelemetryQuery.seriesWindow')(function* (
        app: string,
        stage: string,
        query: SeriesQuery,
        from: number,
        to: number,
      ) {
        const family = yield* familyOf(query);
        const items = yield* queryRange(
          FAMILY_KEY[family](app, stage, '1m'),
          telemetryKeys.time(from),
          `${telemetryKeys.time(to - 1)}\uffff`,
        );
        return windowValue(items, query, family, from, to);
      }, Effect.orDie);

      const traffic = Effect.fn('TelemetryQuery.traffic')(function* (app: string) {
        const now = yield* Clock.currentTimeMillis;
        const range: TimeRange = { from: bucketStart(now, '1h') - 23 * 3_600_000, to: now, res: '1h' };
        const [a, b] = isoRange(range);
        const items = yield* queryRange(telemetryKeys.stage(app, PROD_STAGE, '1h'), a, b);
        return toMetricsPoints(items, range).map((p) => p.req);
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

      const serviceRuns = Effect.fn('TelemetryQuery.serviceRuns')(function* (
        app: string,
        stage: string,
        range: TimeRange,
      ) {
        const r = seriesRange(range);
        const [a, b] = isoRange(r);
        return toServiceRuns(yield* queryRange(telemetryKeys.job(app, stage, r.res), a, b));
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
        return items.map(toUptimePoint);
      }, Effect.orDie);

      const lastUptime = Effect.fn('TelemetryQuery.lastUptime')(function* (app: string, stage: string) {
        const { telemetryTable } = yield* settings.runtime;
        const res = yield* tryAws(() =>
          aws.ddb().send(
            new QueryCommand({
              TableName: telemetryTable,
              KeyConditionExpression: 'pk = :pk',
              ExpressionAttributeValues: { ':pk': telemetryKeys.uptime(app, stage) },
              ScanIndexForward: false,
              Limit: 1,
            }),
          ),
        );
        return Option.map(Option.fromNullishOr(res.Items?.[0]), toUptimePoint);
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

      const stageTraffic = Effect.fn('TelemetryQuery.stageTraffic')(function* (
        app: string,
        stage: string,
        from: number,
        to: number,
      ) {
        const [a, b] = isoRange({ from, to, res: '1m' });
        return toStageTraffic(yield* queryRange(telemetryKeys.stage(app, stage, '1m'), a, b));
      }, Effect.orDie);

      const edgeDays = Effect.fn('TelemetryQuery.edgeDays')(function* (
        app: string,
        stage: string,
        days: readonly number[],
      ) {
        if (days.length === 0) return toEdgeDays([], days);
        const items = yield* queryRange(
          telemetryKeys.edge(app, stage, '1d'),
          telemetryKeys.time(days[0]!),
          telemetryKeys.time(days.at(-1)!),
        );
        return toEdgeDays(items, days);
      }, Effect.orDie);

      return TelemetryQuery.of({
        edgeDays,
        stageTraffic,
        metrics,
        series: readSeries,
        seriesWindow,
        traffic,
        routes,
        jobs,
        customMetrics,
        limits,
        serviceRuns,
        errors,
        setErrorStatus,
        uptime,
        lastUptime,
        cost,
        health,
      });
    }),
  );
}
