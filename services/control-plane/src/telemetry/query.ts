/**
 * Reads rollups back out of the telemetry table and shapes them into the API
 * DTOs. The mapping functions are pure (unit tested); the `read*` functions do I/O.
 */
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import {
  type AppSummary,
  bucketStart,
  type CostResponse,
  type ErrorGroup,
  type JobStats,
  LATENCY_BUCKETS_MS,
  type MetricsPoint,
  type MetricsResponse,
  percentile,
  RESOLUTION_MS,
  type Resolution,
  type RouteStats,
  telemetryKeys,
  type UptimePoint,
} from '@ericminassian/platform-core';
import { aws } from '../aws.ts';
import { getRuntimeConfig } from '../config.ts';

type Item = Record<string, unknown>;
const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
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
        method: String(i.method ?? ''),
        route: String(i.route ?? key),
        req: 0,
        s4xx: 0,
        s5xx: 0,
        hist: new Array(HIST_LEN).fill(0),
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
    .sort((x, y) => y.req - x.req);
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
      a = { kind, name, ok: 0, error: 0, hist: new Array(HIST_LEN).fill(0), last: 0 };
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

export function toErrorGroup(i: Item): ErrorGroup {
  return {
    fingerprint: String(i.sk),
    stage: String(i.stage ?? ''),
    name: String(i.name ?? 'Error'),
    message: String(i.message ?? ''),
    source: String(i.source ?? ''),
    count: num(i.count),
    firstSeen: String(i.firstSeen ?? ''),
    lastSeen: String(i.lastSeen ?? ''),
    status: (i.status as ErrorGroup['status']) ?? 'open',
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
  const hist = new Array(HIST_LEN).fill(0);
  for (const i of items) addHist(hist, histogramOf(i));
  return {
    up,
    reqPerMin: points.length ? Math.round((req / points.length) * 100) / 100 : 0,
    errorRate: req ? errors / req : 0,
    p95: percentile(hist, 95),
  };
}

// ------------------------------------------------------------------ I/O

async function queryRange(pk: string, fromSk: string, toSk: string): Promise<Item[]> {
  const { telemetryTable } = await getRuntimeConfig();
  const items: Item[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const res = await aws.ddb().send(
      new QueryCommand({
        TableName: telemetryTable,
        KeyConditionExpression: 'pk = :pk AND sk BETWEEN :a AND :b',
        ExpressionAttributeValues: { ':pk': pk, ':a': fromSk, ':b': toSk },
        ExclusiveStartKey,
      }),
    );
    items.push(...((res.Items ?? []) as Item[]));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey && items.length < 20_000);
  return items;
}

const isoRange = (r: TimeRange): [string, string] => [
  telemetryKeys.time(bucketStart(r.from, r.res)),
  `${telemetryKeys.time(r.to)}￿`,
];

export async function readMetrics(app: string, stage: string, range: TimeRange): Promise<MetricsResponse> {
  const [a, b] = isoRange(range);
  const items = await queryRange(telemetryKeys.stage(app, stage, range.res), a, b);
  return { app, stage, res: range.res, points: toMetricsPoints(items, range) };
}

/** Routes/jobs/metrics series only exist at 1h and 1d. */
const seriesRange = (r: TimeRange): TimeRange => ({ ...r, res: r.res === '1m' ? '1h' : r.res });

export async function readRoutes(app: string, stage: string, range: TimeRange): Promise<RouteStats[]> {
  const r = seriesRange(range);
  const [a, b] = isoRange(r);
  return toRouteStats(await queryRange(telemetryKeys.route(app, stage, r.res), a, b));
}

export async function readJobs(
  app: string,
  stage: string,
  range: TimeRange,
  declared: readonly { kind: JobStats['kind']; name: string }[],
): Promise<JobStats[]> {
  const r = seriesRange(range);
  const [a, b] = isoRange(r);
  return toJobStats(await queryRange(telemetryKeys.job(app, stage, r.res), a, b), declared);
}

export async function readErrors(app: string, stage: string): Promise<ErrorGroup[]> {
  const { telemetryTable } = await getRuntimeConfig();
  const res = await aws.ddb().send(
    new QueryCommand({
      TableName: telemetryTable,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': telemetryKeys.errors(app, stage) },
    }),
  );
  return ((res.Items ?? []) as Item[]).map(toErrorGroup).sort((x, y) => y.lastSeen.localeCompare(x.lastSeen));
}

export async function readUptime(app: string, stage: string, range: TimeRange): Promise<UptimePoint[]> {
  const items = await queryRange(
    telemetryKeys.uptime(app, stage),
    telemetryKeys.time(range.from),
    `${telemetryKeys.time(range.to)}￿`,
  );
  return items.map((i) => ({ ts: String(i.sk), ok: Boolean(i.ok), status: num(i.status), ms: num(i.ms) }));
}

/** Cost items: pk `cost#<app>` (or `cost#_total`), sk `YYYY-MM-DD`, written by the cost job. */
export const costKey = (app: string) => `cost#${app}`;

export async function readCost(app: string, days = 35): Promise<CostResponse> {
  const today = new Date().toISOString().slice(0, 10);
  const start = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const items = await queryRange(costKey(app), start, today);
  const series = items.map((i) => ({ date: String(i.sk), usd: num(i.usd) }));
  const month = today.slice(0, 7);
  const monthToDateUsd = series.filter((d) => d.date.startsWith(month)).reduce((a, d) => a + d.usd, 0);
  return { app, currency: 'USD', days: series, monthToDateUsd: Math.round(monthToDateUsd * 100) / 100 };
}

export async function readHealth(
  app: string,
  up: boolean | null,
): Promise<NonNullable<AppSummary['health']>> {
  const range: TimeRange = { from: Date.now() - 3_600_000, to: Date.now(), res: '1m' };
  const [a, b] = isoRange(range);
  const items = await queryRange(telemetryKeys.stage(app, 'prod', '1m'), a, b);
  return summarizeHealth(toMetricsPoints(items, range), items, up);
}
