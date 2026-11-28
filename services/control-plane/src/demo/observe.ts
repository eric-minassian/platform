/**
 * The demo API's observability answers: series, logs, traces, errors and
 * the rest, computed from `data.ts`'s functions of time.
 */
import {
  checkSeriesQuery,
  type ErrorGroup,
  type LogFilters,
  type LogLine,
  QUERY_RESOLUTION_MS,
  type QueryResolution,
  type SeriesLine,
  type SeriesQuery,
  type SeriesResponse,
  seriesUnit,
  type StatusClass,
  type TelemetryEvent,
  type TraceFilters,
  type TraceSummary,
} from '@ericminassian/platform-core';
import {
  APPS,
  bucketTraffic,
  type DemoApp,
  type DemoRoute,
  deploymentsOf,
  diurnal,
  EDGE_PER_SERVER_REQUEST,
  INCIDENT,
  inIncident,
  jobBucket,
  type MinuteRoute,
  noise,
  PAGE_VIEW_SHARE,
  pct,
  routeMinute,
  T0,
} from './data.ts';

const MIN = 60_000;

export interface Window {
  readonly from: number;
  readonly to: number;
}

const scaleFor = (stage: string) => (stage === 'prod' ? 1 : 0.04);

function buckets(w: Window, res: QueryResolution): number[] {
  const step = QUERY_RESOLUTION_MS[res];
  const out: number[] = [];
  for (
    let t = Math.floor(w.from / step) * step;
    t < Math.min(w.to, T0 + step) && out.length < 2000;
    t += step
  )
    out.push(t);
  return out;
}

const routeKey = (r: DemoRoute) => `${r.method} ${r.route}`;

function scaled(m: MinuteRoute, k: number): MinuteRoute {
  if (k === 1) return m;
  const s = (n: number) => Math.round(n * k);
  return {
    req: s(m.req),
    s2xx: s(m.s2xx),
    s3xx: s(m.s3xx),
    s4xx: s(m.s4xx),
    s5xx: s(m.s5xx),
    cold: s(m.cold),
    hist: m.hist.map(s),
  };
}

const statusCount = (m: MinuteRoute, classes: readonly StatusClass[]) =>
  classes.reduce((n, c) => n + m[`s${c}`], 0);

/** The value a stat gives a bucket of requests. */
function requestValue(q: SeriesQuery, m: MinuteRoute, stepMs: number): number | null {
  const classes = q.filter?.status;
  const matched = classes?.length ? statusCount(m, classes) : m.req;
  if (q.stat === 'count') return q.metric === 'cold_starts' ? m.cold : matched;
  if (q.stat === 'rate') return matched / (stepMs / 1000);
  if (q.stat === 'percent') {
    if (q.metric === 'cold_starts') return m.req ? (100 * m.cold) / m.req : null;
    return m.req ? (100 * matched) / m.req : null;
  }
  if (q.stat === 'p50' || q.stat === 'p90' || q.stat === 'p95' || q.stat === 'p99')
    return pct(m.hist, Number(q.stat.slice(1)));
  return null;
}

export function series(
  app: DemoApp,
  stage: string,
  q: SeriesQuery,
  w: Window,
  res: QueryResolution,
): SeriesResponse {
  const problem = checkSeriesQuery(q);
  if (problem) throw new Error(problem);
  const step = QUERY_RESOLUTION_MS[res];
  const ts = buckets(w, res);
  const k = scaleFor(stage);
  const timestamps = ts.map((t) => new Date(t).toISOString());
  const unit =
    q.metric === 'custom'
      ? (app.metrics.find((m) => q.filter?.names?.includes(m.name))?.unit ?? 'count')
      : seriesUnit(q);
  const lines: SeriesLine[] = [];
  let histogram: number[][] | undefined;

  if (q.metric === 'requests' || q.metric === 'latency' || q.metric === 'cold_starts') {
    const routes = q.filter?.routes?.length
      ? app.routes.filter((r) => q.filter!.routes!.includes(routeKey(r)))
      : app.routes;
    if (q.groupBy === 'route') {
      for (const r of routes) {
        const traffic = ts.map((t) => scaled(bucketTraffic(app, [r], t, step), k));
        lines.push({ key: routeKey(r), values: traffic.map((m) => requestValue(q, m, step)) });
      }
    } else {
      const traffic = ts.map((t) => scaled(bucketTraffic(app, routes, t, step), k));
      if (q.stat === 'histogram') histogram = traffic.map((m) => m.hist);
      else if (q.groupBy === 'status') {
        for (const c of ['2xx', '3xx', '4xx', '5xx'] as const) {
          lines.push({
            key: c,
            values: traffic.map((m) => requestValue({ ...q, filter: { ...q.filter, status: [c] } }, m, step)),
          });
        }
      } else lines.push({ key: 'all', values: traffic.map((m) => requestValue(q, m, step)) });
    }
  } else if (q.metric === 'page_views' || q.metric === 'edge_requests') {
    const traffic = ts.map((t) =>
      scaled(bucketTraffic(app, app.routes, t, step), EDGE_PER_SERVER_REQUEST * k),
    );
    if (q.metric === 'page_views') {
      const views = traffic.map((m) => Math.round(m.req * PAGE_VIEW_SHARE));
      lines.push({ key: 'all', values: q.stat === 'rate' ? views.map((v) => v / (step / 1000)) : views });
    } else if (q.groupBy === 'status') {
      for (const c of ['2xx', '3xx', '4xx', '5xx'] as const) {
        lines.push({
          key: c,
          values: traffic.map((m) => requestValue({ ...q, filter: { ...q.filter, status: [c] } }, m, step)),
        });
      }
    } else lines.push({ key: 'all', values: traffic.map((m) => requestValue(q, m, step)) });
  } else if (q.metric === 'jobs' || q.metric === 'job_duration') {
    const jobs = q.filter?.jobs?.length
      ? app.jobs.filter((j) => q.filter!.jobs!.includes(`${j.kind}:${j.name}`))
      : app.jobs;
    const value = (b: { ok: number; error: number; hist: number[] }) => {
      const total = b.ok + b.error;
      const matched = q.filter?.outcome === 'error' ? b.error : q.filter?.outcome === 'ok' ? b.ok : total;
      if (q.stat === 'count') return matched;
      if (q.stat === 'rate') return matched / (step / 1000);
      if (q.stat === 'percent') return total ? (100 * matched) / total : null;
      return pct(b.hist, Number(q.stat.slice(1)));
    };
    const sum = (bs: Array<{ ok: number; error: number; hist: number[] }>) => ({
      ok: bs.reduce((n, b) => n + b.ok, 0),
      error: bs.reduce((n, b) => n + b.error, 0),
      hist: bs[0]?.hist.map((_, i) => bs.reduce((n, b) => n + (b.hist[i] ?? 0), 0)) ?? [],
    });
    if (q.groupBy === 'job') {
      for (const j of jobs)
        lines.push({ key: `${j.kind}:${j.name}`, values: ts.map((t) => value(jobBucket(j, t, step))) });
    } else if (q.groupBy === 'outcome') {
      for (const outcome of ['ok', 'error'] as const) {
        lines.push({
          key: outcome,
          values: ts.map((t) => {
            const b = sum(jobs.map((j) => jobBucket(j, t, step)));
            return outcome === 'ok' ? b.ok : b.error;
          }),
        });
      }
    } else {
      const all = ts.map((t) => sum(jobs.map((j) => jobBucket(j, t, step))));
      if (q.stat === 'histogram') histogram = all.map((b) => b.hist);
      else lines.push({ key: 'all', values: all.map(value) });
    }
  } else if (q.metric === 'custom') {
    const metrics = q.filter?.names?.length
      ? app.metrics.filter((m) => q.filter!.names!.includes(m.name))
      : app.metrics;
    for (const m of metrics) {
      lines.push({
        key: q.groupBy === 'name' ? m.name : 'all',
        values: ts.map((t) => {
          const count = Math.round(
            m.perMinute * (step / MIN) * diurnal(t) * (0.7 + 0.6 * noise(t, m.name.length)) * k,
          );
          const each = m.value ?? 1;
          if (q.stat === 'count') return count;
          if (q.stat === 'sum') return count * each;
          if (q.stat === 'avg') return count ? each * (0.8 + 0.4 * noise(t, 7)) : null;
          return count ? each * 1.9 : null;
        }),
      });
    }
  } else if (q.metric === 'rate_limit') {
    const limits = q.filter?.names?.length
      ? app.limits.filter((l) => q.filter!.names!.includes(l))
      : app.limits;
    const bucket = (t: number, salt: number) => {
      const allowed = Math.round(
        app.peak * 0.3 * (step / MIN) * diurnal(t) * (0.7 + 0.6 * noise(t, salt)) * k,
      );
      const denied = Math.round(allowed * (inIncident(t) ? 0.08 : 0.005) * (noise(t, salt + 1) * 2));
      return { allowed, denied };
    };
    const value = (b: { allowed: number; denied: number }, outcome = q.filter?.outcome) => {
      const total = b.allowed + b.denied;
      const matched = outcome === 'denied' ? b.denied : outcome === 'allowed' ? b.allowed : total;
      return q.stat === 'percent' ? (total ? (100 * (outcome ? matched : b.denied)) / total : null) : matched;
    };
    if (q.groupBy === 'outcome') {
      for (const outcome of ['allowed', 'denied'] as const) {
        lines.push({ key: outcome, values: ts.map((t) => value(bucket(t, 3), outcome)) });
      }
    } else {
      for (const [i, l] of limits.entries()) {
        lines.push({ key: q.groupBy === 'name' ? l : 'all', values: ts.map((t) => value(bucket(t, 3 + i))) });
      }
    }
  } else {
    const measure = q.filter?.measure ?? 'events';
    const per = { events: 90, publishes: 30, subscribes: 6, errors: 0.05 }[measure] ?? 1;
    lines.push({
      key: 'all',
      values: app.realtime
        ? ts.map((t) => Math.round(per * (step / MIN) * diurnal(t) * (0.6 + 0.8 * noise(t, 11)) * k))
        : [],
    });
  }

  const ranked = lines
    .map((l) => ({ l, total: l.values.reduce<number>((n, v) => n + (v ?? 0), 0) }))
    .toSorted((a, b) => b.total - a.total);
  const cut = q.groupBy && ranked.length > 10;
  return {
    res,
    timestamps,
    unit,
    series: q.groupBy ? ranked.slice(0, 10).map((r) => r.l) : lines,
    ...(histogram ? { histogram } : {}),
    ...(cut ? { note: `Showing the 10 largest of ${ranked.length} groups.` } : {}),
  };
}

// ---------------------------------------------------------------------------
// Requests as log lines and traces
// ---------------------------------------------------------------------------

export interface DemoRequest {
  readonly trace: string;
  readonly ts: number;
  readonly route: DemoRoute;
  readonly status: number;
  readonly dur: number;
  readonly rev: string;
  readonly recorded: boolean;
  readonly calls: number;
}

/** The live deployment's id at `ts`, for `rev` fields. */
export function revAt(app: string, stage: string, ts: number): string {
  const live = deploymentsOf(app, stage).find(
    (d) => d.status === 'succeeded' && Date.parse(d.finishedAt ?? d.createdAt) <= ts,
  );
  return live?.id ?? 'dep_unknown';
}

/** A trace id that encodes its request: minute, route and sequence, so the trace endpoint can rebuild it. */
const traceId = (ts: number, routeIndex: number, seq: number) =>
  `${Math.floor(ts / MIN)
    .toString(16)
    .padStart(
      10,
      '0',
    )}${routeIndex.toString(16).padStart(2, '0')}${seq.toString(16).padStart(4, '0')}${'0'.repeat(16)}`;

export function decodeTrace(trace: string): { minute: number; routeIndex: number; seq: number } | undefined {
  if (!/^[0-9a-f]{32}$/.test(trace)) return undefined;
  return {
    minute: Number.parseInt(trace.slice(0, 10), 16) * MIN,
    routeIndex: Number.parseInt(trace.slice(10, 12), 16),
    seq: Number.parseInt(trace.slice(12, 16), 16),
  };
}

/** The requests of one minute, a sample of at most `cap` per route. */
export function requestsAt(app: DemoApp, stage: string, minute: number, cap = 6): DemoRequest[] {
  const out: DemoRequest[] = [];
  app.routes.forEach((route, ri) => {
    const m = scaled(routeMinute(app, route, minute), scaleFor(stage));
    const n = Math.min(m.req, cap);
    for (let i = 0; i < n; i++) {
      const salt = ri * 1000 + i;
      const failed = i < Math.round((m.s5xx / Math.max(m.req, 1)) * n);
      const median = pct(m.hist, 50) ?? route.median;
      const dur = Math.round(median * Math.exp((noise(minute, salt) - 0.5) * 1.6) * (failed ? 1.7 : 1));
      out.push({
        trace: traceId(minute, ri, i),
        ts: minute + Math.floor(noise(minute, salt + 500) * 59_000),
        route,
        status: failed ? 500 : route.route === '/' && noise(minute, salt + 9) < 0.1 ? 304 : 200,
        dur,
        rev: revAt(app.record.name, stage, minute),
        recorded: failed || dur >= 1000 || noise(minute, salt + 77) < 0.05,
        calls: 2 + Math.floor(noise(minute, salt + 31) * 6),
      });
    }
  });
  return out;
}

export function traceSummaries(
  app: DemoApp,
  stage: string,
  w: Window,
  f: TraceFilters | undefined,
  limit: number,
): { traces: TraceSummary[]; truncated: boolean } {
  const out: TraceSummary[] = [];
  const end = Math.min(w.to, T0);
  // Sample whole minutes newest first; long ranges step over minutes to stay quick.
  const minutes = Math.max(1, Math.floor((end - w.from) / MIN));
  const stride = Math.max(1, Math.floor(minutes / 400));
  for (let m = Math.floor(end / MIN) * MIN; m >= w.from && out.length < limit + 1; m -= stride * MIN) {
    if (f?.kind === 'job') break;
    for (const r of requestsAt(app, stage, m, 3)) {
      const name = `${r.route.method} ${r.route.route}`;
      if (f?.routes?.length && !f.routes.includes(name)) continue;
      if (f?.outcome === 'error' && r.status < 500) continue;
      if (f?.outcome === 'ok' && r.status >= 500) continue;
      if (f?.minMs !== undefined && r.dur < f.minMs) continue;
      if (f?.recorded && !r.recorded) continue;
      out.push({
        trace: r.trace,
        ts: new Date(r.ts - r.dur).toISOString(),
        kind: 'req',
        name,
        status: r.status,
        failed: r.status >= 500,
        dur: r.dur,
        recorded: r.recorded,
        ...(r.recorded ? {} : { calls: r.calls }),
        rev: r.rev,
      });
    }
  }
  out.sort((a, b) => b.ts.localeCompare(a.ts));
  return { traces: out.slice(0, limit), truncated: out.length > limit };
}

const base = (app: string, stage: string, ts: number, rev: string, trace: string) => ({
  _p: 1 as const,
  ts,
  app,
  stage,
  rev,
  trace,
});

export function traceEvents(app: DemoApp, stage: string, trace: string): TelemetryEvent[] {
  const d = decodeTrace(trace);
  if (!d) return [];
  const r = requestsAt(app, stage, d.minute, 6).find((x) => x.trace === trace);
  if (!r) return [];
  const start = r.ts - r.dur;
  const b = (ts: number) => base(app.record.name, stage, ts, r.rev, trace);
  const failed = r.status >= 500;
  const events: TelemetryEvent[] = [
    {
      ...b(r.ts),
      t: 'req',
      method: r.route.method,
      route: r.route.route,
      status: r.status,
      dur: r.dur,
      span: `${trace.slice(0, 15)}0`,
      ...(r.recorded ? {} : { calls: r.calls, callMs: Math.round(r.dur * 0.6) }),
    },
  ];
  if (r.recorded) {
    const parent = `${trace.slice(0, 15)}0`;
    const spans: Array<[string, string, number, number, 'ok' | 'error']> = r.route.broken
      ? [
          ['db.get', 'sources', 0.01, 0.01, 'ok'],
          ['fetch', 'news.example.org/feed.xml', 0.03, 0.82, 'ok'],
          ['db.query', 'items', 0.86, 0.03, 'ok'],
          ['storage.put', 'feeds/src_19.xml', 0.9, 0.04, failed ? 'error' : 'ok'],
        ]
      : [
          ['db.get', 'session', 0.02, 0.05, 'ok'],
          ['db.query', r.route.route.includes('search') ? 'items by title' : 'items', 0.1, 0.55, 'ok'],
          ['fetch', 'api.example.net/rank', 0.68, 0.25, 'ok'],
        ];
    spans.forEach(([op, name, s, dur, status], i) =>
      events.push({
        ...b(start + Math.round((s + dur) * r.dur)),
        t: 'span',
        op,
        name,
        dur: Math.round(dur * r.dur),
        status,
        start: Math.round(s * r.dur),
        span: `${trace.slice(0, 15)}${i + 1}`,
        parent,
      }),
    );
    events.push({
      ...b(start + Math.round(0.95 * r.dur)),
      t: 'log',
      level: failed ? 'error' : 'info',
      msg: failed ? 'refresh failed' : 'served from index',
      parent,
    });
  }
  if (failed) {
    events.push({
      ...b(r.ts - 2),
      t: 'err',
      source: 'http',
      name: 'TypeError',
      message: "Cannot read properties of undefined (reading 'feedUrl')",
      stack: ERROR_STACK,
      route: r.route.route,
      fingerprint: 'fp_feedurl',
    });
  }
  return events.toSorted((a, c) => a.ts - c.ts);
}

export const ERROR_STACK = `TypeError: Cannot read properties of undefined (reading 'feedUrl')
    at refreshSource (src/sources/refresh.ts:42:31)
    at handler (src/routes/sources.ts:88:12)
    at processTicksAndRejections (node:internal/process/task_queues:95:5)`;

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

function lineFor(app: DemoApp, stage: string, r: DemoRequest): LogLine[] {
  const event = traceEvents(app, stage, r.trace).find((e) => e.t === 'req');
  const lines: LogLine[] = [
    {
      ts: new Date(r.ts).toISOString(),
      stream: 'web',
      level: r.status >= 500 ? 'error' : 'info',
      message: `${r.route.method} ${r.route.route} → ${r.status} · ${r.dur >= 1000 ? `${(r.dur / 1000).toFixed(2)}s` : `${r.dur}ms`}`,
      trace: r.trace,
      ...(event ? { event } : {}),
    },
  ];
  if (r.status >= 500) {
    lines.push({
      ts: new Date(r.ts + 3).toISOString(),
      stream: 'web',
      level: 'error',
      message: "TypeError: Cannot read properties of undefined (reading 'feedUrl')",
      trace: r.trace,
      event: {
        ...base(app.record.name, stage, r.ts + 3, r.rev, r.trace),
        t: 'err',
        source: 'http',
        name: 'TypeError',
        message: "Cannot read properties of undefined (reading 'feedUrl')",
        stack: ERROR_STACK,
        route: r.route.route,
        fingerprint: 'fp_feedurl',
      },
    });
  }
  return lines;
}

function workerLines(app: DemoApp, stage: string, minute: number): LogLine[] {
  const out: LogLine[] = [];
  for (const job of app.jobs) {
    if (noise(minute, job.name.length + 40) > (job.perHour / 60) * scaleFor(stage)) continue;
    const ts = minute + Math.floor(noise(minute, 41) * 59_000);
    const failing = job.name === 'refresh' && inIncident(minute);
    const trace = `${Math.floor(ts / MIN)
      .toString(16)
      .padStart(10, '0')}ff0000${'0'.repeat(16)}`;
    if (failing && noise(minute, 42) < 0.5) {
      out.push({
        ts: new Date(ts - 400).toISOString(),
        stream: 'worker',
        level: 'warn',
        message: 'refresh: news.example.org answered 429, retrying in 30s (attempt 1 of 2)',
        trace,
      });
    }
    out.push({
      ts: new Date(ts).toISOString(),
      stream: 'worker',
      level: failing ? 'error' : 'info',
      message: failing
        ? `queue ${job.name} failed after 2 attempts → dead letter`
        : `${job.kind} ${job.name} → ok · ${(job.median / 1000).toFixed(2)}s`,
      trace,
    });
  }
  if (noise(minute, 61) < 0.08) {
    out.push({
      ts: new Date(minute + 59_000).toISOString(),
      stream: 'web',
      level: 'system',
      message:
        'REPORT Duration: 182.41 ms Billed Duration: 183 ms Memory Size: 512 MB Max Memory Used: 141 MB',
    });
  }
  if (noise(minute, 71) < 0.02) {
    out.push({
      ts: new Date(minute + 12_000).toISOString(),
      stream: 'web',
      level: 'warn',
      message: 'search: query took 1.2s, falling back to prefix match',
    });
  }
  return out;
}

const STATUS_RE = /→ (\d{3})/;

export function matchesLine(
  l: LogLine,
  q: string | undefined,
  stream: string | undefined,
  f: LogFilters | undefined,
): boolean {
  if (stream && l.stream !== stream) return false;
  if (q && !l.message.toLowerCase().includes(q.toLowerCase())) return false;
  if (!f) return true;
  if (f.levels?.length && !f.levels.includes((l.level ?? 'info') as never)) return false;
  if (f.streams?.length && !f.streams.includes(l.stream)) return false;
  const event = l.event as { route?: string; rev?: string } | undefined;
  if (f.routes?.length && !f.routes.some((r) => event?.route === r || l.message.includes(` ${r} `)))
    return false;
  if (f.revs?.length && !f.revs.includes(event?.rev ?? '')) return false;
  if (f.trace && l.trace !== f.trace) return false;
  if (f.status?.length) {
    const s = STATUS_RE.exec(l.message)?.[1];
    if (!s || !f.status.includes(`${s[0]}xx` as StatusClass)) return false;
  }
  return true;
}

/** Log lines of a window, newest first. `before` continues a page. */
export function logLines(
  app: DemoApp,
  stage: string,
  w: Window,
  opts: {
    q?: string | undefined;
    stream?: string | undefined;
    f?: LogFilters | undefined;
    limit: number;
    before?: number | undefined;
  },
): { lines: LogLine[]; next?: number } {
  const lines: LogLine[] = [];
  const end = Math.min(opts.before ?? w.to, T0);
  let m = Math.floor(end / MIN) * MIN;
  let scanned = 0;
  while (m >= w.from && lines.length < opts.limit && scanned < 3000) {
    const minute = [
      ...requestsAt(app, stage, m, 3).flatMap((r) => lineFor(app, stage, r)),
      ...workerLines(app, stage, m),
    ]
      .filter((l) => Date.parse(l.ts) < end && matchesLine(l, opts.q, opts.stream, opts.f))
      .toSorted((a, b) => b.ts.localeCompare(a.ts));
    lines.push(...minute);
    m -= MIN;
    scanned++;
  }
  const page = lines.slice(0, opts.limit);
  const last = page.at(-1);
  return { lines: page, ...(m >= w.from && last ? { next: Date.parse(last.ts) } : {}) };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export function errorGroups(app: DemoApp, stage: string): ErrorGroup[] {
  if (stage !== 'prod') return [];
  const groups: ErrorGroup[] = [];
  if (app.record.name === 'atlas') {
    groups.push(
      {
        fingerprint: 'fp_feedurl',
        stage,
        name: 'TypeError',
        message: "Cannot read properties of undefined (reading 'feedUrl')",
        source: 'http',
        count: 214,
        firstSeen: new Date(INCIDENT.from + 60_000).toISOString(),
        lastSeen: new Date(INCIDENT.to - 30_000).toISOString(),
        status: 'resolved',
        sample: {
          stack: ERROR_STACK,
          route: '/api/sources/:id/refresh',
          trace: traceId(INCIDENT.from + 20 * MIN, 3, 0),
          rev: revAt('atlas', 'prod', INCIDENT.from + MIN),
        },
      },
      {
        fingerprint: 'fp_fetch429',
        stage,
        name: 'FetchError',
        message: 'news.example.org answered 429 Too Many Requests',
        source: 'job',
        count: 38,
        firstSeen: new Date(T0 - 3 * 86_400_000).toISOString(),
        lastSeen: new Date(T0 - 12 * MIN).toISOString(),
        status: 'open',
        sample: {
          stack:
            'FetchError: news.example.org answered 429 Too Many Requests\n    at fetchFeed (src/sources/fetch.ts:19:11)\n    at refreshSource (src/sources/refresh.ts:30:22)',
          job: 'queue:refresh',
          rev: revAt('atlas', 'prod', T0 - 12 * MIN),
        },
      },
      {
        fingerprint: 'fp_timeout',
        stage,
        name: 'TimeoutError',
        message: 'search ranking took longer than 5000ms',
        source: 'http',
        count: 6,
        firstSeen: new Date(T0 - 26 * 3_600_000).toISOString(),
        lastSeen: new Date(T0 - 2 * 3_600_000).toISOString(),
        status: 'open',
        sample: {
          route: '/api/search',
          rev: revAt('atlas', 'prod', T0 - 2 * 3_600_000),
          stack:
            'TimeoutError: search ranking took longer than 5000ms\n    at rank (src/search/rank.ts:61:9)',
        },
      },
    );
  }
  if (app.record.name === 'inbox') {
    groups.push({
      fingerprint: 'fp_smtp',
      stage,
      name: 'EmailNotSent',
      message: 'recipient is on the suppression list',
      source: 'job',
      count: 3,
      firstSeen: new Date(T0 - 5 * 86_400_000).toISOString(),
      lastSeen: new Date(T0 - 40 * 3_600_000).toISOString(),
      status: 'ignored',
      sample: { job: 'queue:send' },
    });
  }
  return groups;
}

export { APPS };
