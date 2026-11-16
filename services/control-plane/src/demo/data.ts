/**
 * Synthetic telemetry for the demo API (`src/demo/server.ts`): four sample
 * apps whose traffic, latency, jobs and logs are pure functions of time, so
 * every endpoint agrees with every other one and a page looks the same on
 * every load. One incident is built in: a deploy of atlas 14½ hours before
 * the server started broke a route until a fix shipped 80 minutes later.
 */
import {
  type AppRecord,
  type DeploymentRecord,
  LATENCY_BUCKETS_MS,
  percentile,
  type StageRecord,
} from '@ericminassian/platform-core';

/** When the demo server started: every sample time is relative to it. */
export const T0 = Math.floor(Date.now() / 60_000) * 60_000;
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

export const INCIDENT = { from: T0 - 14.5 * HOUR, to: T0 - 13.2 * HOUR } as const;

/** A deterministic hash of a number to [0, 1). */
export function noise(n: number, salt = 0): number {
  let x = Math.imul((n / MIN) ^ (salt * 0x9e3779b1), 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

/** Busier in the afternoon (UTC), quiet at night. */
export function diurnal(ts: number): number {
  const h = (ts % DAY) / HOUR;
  return 0.25 + 0.75 * (0.5 + 0.5 * Math.cos(((h - 20) / 24) * 2 * Math.PI)) ** 1.6;
}

export const inIncident = (ts: number) => ts >= INCIDENT.from && ts < INCIDENT.to;

// ---------------------------------------------------------------------------
// Apps
// ---------------------------------------------------------------------------

export interface DemoRoute {
  readonly method: string;
  readonly route: string;
  /** Share of the app's requests. */
  readonly share: number;
  /** Median latency, ms. */
  readonly median: number;
  /** p95 / median. */
  readonly spread: number;
  /** Fails during the incident. */
  readonly broken?: boolean;
}

export interface DemoApp {
  readonly record: AppRecord;
  /** Requests per minute at the daily peak. */
  readonly peak: number;
  readonly routes: readonly DemoRoute[];
  readonly jobs: ReadonlyArray<{
    kind: 'queue' | 'event' | 'cron';
    name: string;
    perHour: number;
    median: number;
  }>;
  readonly metrics: ReadonlyArray<{ name: string; unit?: string; perMinute: number; value?: number }>;
  readonly limits: readonly string[];
  readonly services: readonly string[];
  readonly email: boolean;
  readonly realtime: boolean;
  readonly db: boolean;
  readonly storage: readonly string[];
  readonly stages: readonly string[];
}

const created = new Date(T0 - 60 * DAY).toISOString();
const record = (name: string, description: string): AppRecord => ({
  name,
  repo: `example/${name}`,
  description,
  owners: ['demo'],
  createdBy: 'demo',
  createdAt: created,
});

export const APPS: readonly DemoApp[] = [
  {
    record: record('atlas', 'Reads feeds and keeps a searchable index of their items'),
    peak: 54,
    routes: [
      { method: 'GET', route: '/api/search', share: 0.44, median: 120, spread: 2.3 },
      { method: 'GET', route: '/api/items/:id', share: 0.29, median: 32, spread: 2.2 },
      { method: 'GET', route: '/', share: 0.1, median: 18, spread: 2 },
      {
        method: 'POST',
        route: '/api/sources/:id/refresh',
        share: 0.075,
        median: 520,
        spread: 2.6,
        broken: true,
      },
      { method: 'GET', route: '/api/sources', share: 0.06, median: 40, spread: 2.2 },
      { method: 'GET', route: '/api/me', share: 0.025, median: 14, spread: 2 },
    ],
    jobs: [
      { kind: 'queue', name: 'refresh', perHour: 70, median: 1600 },
      { kind: 'cron', name: 'digest', perHour: 1, median: 410 },
      { kind: 'event', name: 'source.updated', perHour: 22, median: 90 },
    ],
    metrics: [
      { name: 'items_indexed', perMinute: 9 },
      { name: 'feed_bytes', unit: 'KB', perMinute: 1.2, value: 180 },
    ],
    limits: ['search-per-user'],
    services: [],
    email: false,
    realtime: false,
    db: true,
    storage: ['feeds'],
    stages: ['prod', 'pr-41'],
  },
  {
    record: record('notes', 'Shared notes with live cursors'),
    peak: 22,
    routes: [
      { method: 'GET', route: '/api/notes/:id', share: 0.5, median: 28, spread: 2.1 },
      { method: 'PUT', route: '/api/notes/:id', share: 0.3, median: 44, spread: 2.4 },
      { method: 'GET', route: '/', share: 0.2, median: 16, spread: 2 },
    ],
    jobs: [{ kind: 'cron', name: 'compact', perHour: 1, median: 2300 }],
    metrics: [{ name: 'notes_saved', perMinute: 4 }],
    limits: [],
    services: [],
    email: false,
    realtime: true,
    db: true,
    storage: [],
    stages: ['prod'],
  },
  {
    record: record('inbox', 'Collects replies to the newsletter and sends the digest'),
    peak: 6,
    routes: [
      { method: 'GET', route: '/api/threads', share: 0.6, median: 60, spread: 2.2 },
      { method: 'POST', route: '/api/send', share: 0.4, median: 210, spread: 2.5 },
    ],
    jobs: [
      { kind: 'queue', name: 'send', perHour: 40, median: 380 },
      { kind: 'cron', name: 'weekly-digest', perHour: 0.05, median: 9000 },
    ],
    metrics: [],
    limits: ['send-per-hour'],
    services: ['imap-sync'],
    email: true,
    realtime: false,
    db: true,
    storage: [],
    stages: ['prod'],
  },
  {
    record: record('shortlinks', 'Short links for talks and posts'),
    peak: 1.5,
    routes: [
      { method: 'GET', route: '/:slug', share: 0.95, median: 9, spread: 1.8 },
      { method: 'POST', route: '/api/links', share: 0.05, median: 35, spread: 2 },
    ],
    jobs: [],
    metrics: [],
    limits: [],
    services: [],
    email: false,
    realtime: false,
    db: true,
    storage: [],
    stages: ['prod'],
  },
];

export const findApp = (name: string): DemoApp | undefined => APPS.find((a) => a.record.name === name);

export const STAGE_DEPLOYMENTS: Record<
  string,
  ReadonlyArray<{ at: number; commit: string; message: string; status?: DeploymentRecord['status'] }>
> = {
  'atlas/prod': [
    { at: T0 - 3 * HOUR, commit: '4f2c1a90e1', message: 'Rank exact title matches first' },
    { at: INCIDENT.to, commit: 'c27d4b8a31', message: 'Guard missing feed URL' },
    { at: INCIDENT.from, commit: '9ab31e07c2', message: 'Refresh sources in parallel' },
    { at: T0 - 2.2 * DAY, commit: '16a0f3e9d4', message: 'Show source health in the list' },
    { at: T0 - 5 * DAY, commit: '7d9e2b1f05', message: 'Bump SDK to 0.4.0' },
  ],
  'atlas/pr-41': [
    { at: T0 - 6 * HOUR, commit: 'e81b2d04aa', message: 'Add source health column' },
    { at: T0 - 26 * HOUR, commit: '77c0a1f3b2', message: 'Try a wider search index', status: 'failed' },
  ],
  'notes/prod': [
    { at: T0 - 9 * HOUR, commit: 'b3c91d2e77', message: 'Debounce cursor updates' },
    { at: T0 - 3 * DAY, commit: '5a0e44c9f1', message: 'Keep notes in one table' },
  ],
  'inbox/prod': [{ at: T0 - 30 * HOUR, commit: '2c7f0e1a9b', message: 'Retry sends on throttling' }],
  'shortlinks/prod': [{ at: T0 - 12 * DAY, commit: '0d5be8c412', message: 'Count clicks per link' }],
};

export function deploymentsOf(app: string, stage?: string): DeploymentRecord[] {
  const stages = stage ? [stage] : (findApp(app)?.stages ?? []);
  return stages
    .flatMap((s) =>
      (STAGE_DEPLOYMENTS[`${app}/${s}`] ?? []).map((d, i) => ({
        // Real ids end in random characters; these end in the commit, which reads better in pictures.
        id: `dep_${app}_${s}_${d.commit.slice(0, 8)}`,
        app,
        stage: s,
        status: d.status ?? (i === 0 ? 'succeeded' : 'succeeded'),
        actor: s === 'prod' ? `ci:example/${app}` : 'demo',
        commit: d.commit,
        ref: s === 'prod' ? 'refs/heads/main' : `refs/pull/${s.slice(3)}/merge`,
        message: d.message,
        sdk: '0.4.0',
        compute: app === 'shortlinks' || s !== 'prod' ? ('request' as const) : ('instance' as const),
        url: `https://${s === 'prod' ? app : `${app}--${s}`}.example.com`,
        events: [
          { ts: d.at - 70_000, level: 'info' as const, msg: 'artifacts uploaded' },
          {
            ts: d.at - 40_000,
            level: 'info' as const,
            msg: 'server updated',
            resource: `function ${app}--${s}`,
          },
          { ts: d.at - 5_000, level: 'info' as const, msg: 'route switched' },
        ],
        createdAt: new Date(d.at - 90_000).toISOString(),
        startedAt: new Date(d.at - 80_000).toISOString(),
        finishedAt: new Date(d.at).toISOString(),
        ...(d.status === 'failed'
          ? { error: 'build failed: search index exceeds the 10 MB bundle limit' }
          : {}),
      })),
    )
    .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function stagesOf(app: DemoApp): StageRecord[] {
  return app.stages.map((s) => {
    const deps = deploymentsOf(app.record.name, s);
    const live = deps.find((d) => d.status === 'succeeded');
    const host = s === 'prod' ? `${app.record.name}.example.com` : `${app.record.name}--${s}.example.com`;
    return {
      app: app.record.name,
      stage: s,
      host,
      url: `https://${host}`,
      status: 'active',
      preview: s !== 'prod',
      ...(live ? { currentDeployment: live.id } : {}),
      ...(deps[1] ? { previousDeployment: deps[1].id } : {}),
      compute: app.record.name === 'shortlinks' || s !== 'prod' ? 'request' : 'instance',
      createdAt: created,
      updatedAt: live?.finishedAt ?? created,
    };
  });
}

// ---------------------------------------------------------------------------
// Traffic
// ---------------------------------------------------------------------------

const EDGES = [0, ...LATENCY_BUCKETS_MS, Number.POSITIVE_INFINITY];

function erf(x: number): number {
  const s = Math.sign(x);
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-a * a);
  return s * y;
}

const lnCdf = (x: number, mu: number, sigma: number) =>
  x <= 0
    ? 0
    : x === Number.POSITIVE_INFINITY
      ? 1
      : 0.5 * (1 + erf((Math.log(x) - mu) / (sigma * Math.SQRT2)));

/** `count` requests spread over the latency buckets for a median and p95/median spread. */
export function histogramFor(count: number, median: number, spread: number): number[] {
  const mu = Math.log(median);
  const sigma = Math.log(spread) / 1.645;
  return EDGES.slice(0, -1).map((lo, i) =>
    Math.round(count * (lnCdf(EDGES[i + 1]!, mu, sigma) - lnCdf(lo, mu, sigma))),
  );
}

export interface MinuteRoute {
  readonly req: number;
  readonly s2xx: number;
  readonly s3xx: number;
  readonly s4xx: number;
  readonly s5xx: number;
  readonly hist: number[];
  readonly cold: number;
}

/** One route's requests in the minute starting at `ts`. */
export function routeMinute(app: DemoApp, route: DemoRoute, ts: number): MinuteRoute {
  const salt = route.route.length * 31 + route.method.length;
  const rate = app.peak * route.share * diurnal(ts) * (0.75 + 0.5 * noise(ts, salt));
  const req = Math.max(0, Math.round(rate + noise(ts, salt + 1) - 0.5));
  const broken = route.broken && inIncident(ts);
  const s5xx = broken
    ? Math.round(req * (0.45 + 0.3 * noise(ts, salt + 2)))
    : noise(ts, salt + 3) < 0.004 * req
      ? 1
      : 0;
  const s4xx = Math.min(req - s5xx, noise(ts, salt + 4) < 0.02 * req ? 1 : 0);
  const s3xx = route.route === '/' ? Math.round((req - s5xx - s4xx) * 0.1) : 0;
  const slow = broken ? 2.3 : inIncident(ts) && route.route === '/api/search' ? 1.6 : 1;
  const median = route.median * slow * (0.9 + 0.2 * noise(ts, salt + 5));
  const deployed = Object.values(STAGE_DEPLOYMENTS)
    .flat()
    .some((d) => ts >= d.at && ts < d.at + 3 * MIN);
  return {
    req,
    s2xx: req - s5xx - s4xx - s3xx,
    s3xx,
    s4xx,
    s5xx,
    hist: histogramFor(req, median, route.spread * (broken ? 1.4 : 1)),
    cold: req > 0 && (deployed || noise(ts, salt + 6) < 0.01) ? 1 : 0,
  };
}

export function sumMinutes(parts: readonly MinuteRoute[]): MinuteRoute {
  const hist = Array.from({ length: EDGES.length - 1 }, (_, i) =>
    parts.reduce((n, p) => n + (p.hist[i] ?? 0), 0),
  );
  const sum = (k: 'req' | 's2xx' | 's3xx' | 's4xx' | 's5xx' | 'cold') => parts.reduce((n, p) => n + p[k], 0);
  return {
    req: sum('req'),
    s2xx: sum('s2xx'),
    s3xx: sum('s3xx'),
    s4xx: sum('s4xx'),
    s5xx: sum('s5xx'),
    cold: sum('cold'),
    hist,
  };
}

/**
 * A bucket's traffic: each minute is summed for buckets up to an hour;
 * longer ones sample 30 minutes and scale, which keeps a 30-day query fast.
 */
export function bucketTraffic(
  app: DemoApp,
  routes: readonly DemoRoute[],
  from: number,
  step: number,
): MinuteRoute {
  const minutes = Math.max(1, Math.round(step / MIN));
  const sample = Math.min(minutes, 30);
  const stride = minutes / sample;
  const parts: MinuteRoute[] = [];
  for (let i = 0; i < sample; i++) {
    const ts = from + Math.floor(i * stride) * MIN;
    if (ts > T0) break;
    for (const r of routes) parts.push(routeMinute(app, r, ts));
  }
  const total = sumMinutes(parts);
  if (stride === 1) return total;
  const scale = (n: number) => Math.round(n * stride);
  return {
    req: scale(total.req),
    s2xx: scale(total.s2xx),
    s3xx: scale(total.s3xx),
    s4xx: scale(total.s4xx),
    s5xx: scale(total.s5xx),
    cold: scale(total.cold),
    hist: total.hist.map(scale),
  };
}

export const pct = (hist: readonly number[], p: number) => percentile(hist, p);

export function jobBucket(
  job: DemoApp['jobs'][number],
  from: number,
  step: number,
): { ok: number; error: number; hist: number[] } {
  const hours = step / HOUR;
  const salt = job.name.length * 17;
  const expected = job.perHour * hours * (0.7 + 0.6 * noise(from, salt));
  const runs = Math.max(0, Math.round(expected + noise(from, salt + 1) - 0.5));
  const failing = job.name === 'refresh' && from < INCIDENT.to && from + step > INCIDENT.from;
  const error = failing ? Math.round(runs * 0.4) : noise(from, salt + 2) < 0.03 ? Math.min(1, runs) : 0;
  return { ok: runs - error, error, hist: histogramFor(runs, job.median * (failing ? 1.8 : 1), 2.4) };
}
