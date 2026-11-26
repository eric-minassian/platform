/**
 * A demo of the control plane API for working on the console without AWS:
 * `pnpm web:demo` serves `PlatformApi` on http://127.0.0.1:8787 with the
 * sample apps and telemetry of `data.ts`, signed in as an admin, and the
 * console's dev server (`pnpm web:dev`) proxies to it. Alert rules are kept
 * in memory; other writes answer as the real API would without changing
 * anything. Also what `pnpm web:shots` photographs, so screenshots never show
 * real data.
 */
import { toFetchHandler } from '@ericminassian/platform';
import {
  type AlertEvent,
  type AlertRule,
  type AppSummary,
  BINDINGS_ENV,
  type Bindings,
  checkSeriesQuery,
  names,
  newId,
  QUERY_RESOLUTION_MS,
  type QueryResolution,
  RESOLUTION_TTL_DAYS,
  autoQueryResolution,
} from '@ericminassian/platform-core';
import {
  Authenticated,
  BadRequest,
  Conflict,
  CurrentPrincipal,
  NotFound,
  PlatformApi,
} from '@ericminassian/platform-core/platform-api';
import { startServer } from '@ericminassian/platform/server';
import { Effect, Layer, Stream } from 'effect';
import { HttpApiBuilder } from 'effect/http-api';
import { RequestValidationLive, RouterErrorsLive } from '../api/errors.ts';
import { directoryDays, publicApp } from '../api/public.ts';
import { parseRange } from '../telemetry/query.ts';
import {
  APPS,
  bucketTraffic,
  type DemoApp,
  deploymentsOf,
  diurnal,
  EDGE_PER_SERVER_REQUEST,
  findApp,
  INCIDENT,
  inIncident,
  jobBucket,
  noise,
  PAGE_VIEW_SHARE,
  pct,
  stagesOf,
  T0,
} from './data.ts';
import {
  errorGroups,
  logLines,
  matchesLine,
  requestsAt,
  series,
  traceEvents,
  traceSummaries,
  type Window,
} from './observe.ts';

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

const demoApp = (name: string) => {
  const app = findApp(name);
  return app ? Effect.succeed(app) : Effect.fail(NotFound.of(`app ${name}`));
};

const windowOf = (
  q: { from?: string | undefined; to?: string | undefined; range?: string | undefined },
  fallback = '24h',
): Window => {
  const r = parseRange({ from: q.from, to: q.to, range: q.range ?? fallback }, T0);
  return { from: r.from, to: r.to };
};

const QUERY_RES = new Set(['1m', '5m', '10m', '15m', '30m', '1h', '1d']);
const resOf = (w: Window, res: string | undefined): QueryResolution =>
  res && QUERY_RES.has(res)
    ? (res as QueryResolution)
    : autoQueryResolution(w.from, w.to, T0, RESOLUTION_TTL_DAYS['1m'] * DAY);

/** Rollup-shaped answers keep the old endpoints' `1m | 1h | 1d`. */
const storedRes = (w: Window): '1m' | '1h' | '1d' =>
  w.to - w.from <= 6 * HOUR ? '1m' : w.to - w.from <= 14 * DAY ? '1h' : '1d';

// ---------------------------------------------------------------------------
// In-memory state: alert rules, triage
// ---------------------------------------------------------------------------

const rule = (
  id: string,
  app: string,
  name: string,
  query: AlertRule['query'],
  op: 'above' | 'below',
  threshold: number,
  minutes: AlertRule['condition']['minutes'],
  state: AlertRule['state'],
  value: number | null,
  since: number,
): AlertRule => ({
  id,
  app,
  name,
  stage: 'prod',
  query,
  condition: { op, threshold, minutes },
  missing: 'ok',
  notify: true,
  enabled: true,
  state,
  stateSince: iso(since),
  value,
  evaluatedAt: iso(T0 - MIN),
  createdBy: 'demo',
  createdAt: iso(T0 - 20 * DAY),
  updatedAt: iso(T0 - 20 * DAY),
});

const alertRules = new Map<string, AlertRule>(
  [
    rule(
      'a_5xx',
      'atlas',
      'Requests failing',
      { metric: 'requests', stat: 'percent', filter: { status: ['5xx'] } },
      'above',
      2,
      5,
      'ok',
      0.1,
      INCIDENT.to + 6 * MIN,
    ),
    rule(
      'a_p95',
      'atlas',
      'Search is slow',
      { metric: 'latency', stat: 'p95', filter: { routes: ['GET /api/search'] } },
      'above',
      1000,
      10,
      'ok',
      410,
      INCIDENT.to + 12 * MIN,
    ),
    rule(
      'a_jobs',
      'atlas',
      'Refresh jobs failing',
      { metric: 'jobs', stat: 'count', filter: { jobs: ['queue:refresh'], outcome: 'error' } },
      'above',
      3,
      15,
      'alarm',
      4,
      T0 - 40 * MIN,
    ),
    rule(
      'n_5xx',
      'notes',
      'Requests failing',
      { metric: 'requests', stat: 'percent', filter: { status: ['5xx'] } },
      'above',
      1,
      5,
      'ok',
      0,
      T0 - 9 * DAY,
    ),
  ].map((r) => [r.id, r]),
);

const alertEvents: AlertEvent[] = [
  {
    ts: iso(T0 - 40 * MIN),
    rule: 'a_jobs',
    name: 'Refresh jobs failing',
    stage: 'prod',
    from: 'ok',
    to: 'alarm',
    value: 4,
    threshold: 3,
  },
  {
    ts: iso(INCIDENT.to + 6 * MIN),
    rule: 'a_5xx',
    name: 'Requests failing',
    stage: 'prod',
    from: 'alarm',
    to: 'ok',
    value: 0.4,
    threshold: 2,
  },
  {
    ts: iso(INCIDENT.to + 12 * MIN),
    rule: 'a_p95',
    name: 'Search is slow',
    stage: 'prod',
    from: 'alarm',
    to: 'ok',
    value: 640,
    threshold: 1000,
  },
  {
    ts: iso(INCIDENT.from + 8 * MIN),
    rule: 'a_p95',
    name: 'Search is slow',
    stage: 'prod',
    from: 'ok',
    to: 'alarm',
    value: 1800,
    threshold: 1000,
  },
  {
    ts: iso(INCIDENT.from + 6 * MIN),
    rule: 'a_5xx',
    name: 'Requests failing',
    stage: 'prod',
    from: 'ok',
    to: 'alarm',
    value: 31.5,
    threshold: 2,
  },
];

const errorStatus = new Map<string, 'open' | 'resolved' | 'ignored'>();

// ---------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------

function summary(app: DemoApp): AppSummary {
  const stages = stagesOf(app);
  const hour = bucketTraffic(app, app.routes, T0 - HOUR, HOUR);
  const traffic = Array.from(
    { length: 24 },
    (_, i) => bucketTraffic(app, app.routes, T0 - (24 - i) * HOUR, HOUR).req,
  );
  const rules = [...alertRules.values()].filter((r) => r.app === app.record.name);
  const last = deploymentsOf(app.record.name)[0];
  return {
    app: app.record,
    stages,
    health: {
      up: true,
      reqPerMin: hour.req / 60,
      errorRate: hour.req ? hour.s5xx / hour.req : 0,
      p95: pct(hour.hist, 95),
    },
    costMonthToDateUsd: { atlas: 0.38, notes: 0.21, inbox: 2.84, shortlinks: 0.02 }[app.record.name] ?? 0,
    ...(last ? { lastDeployment: last } : {}),
    traffic,
    alerts: { total: rules.length, alarm: rules.filter((r) => r.state === 'alarm').length },
    ...(stages.some((s) => s.stage === 'prod') ? { listed: true } : {}),
  };
}

const costDays = (app: string) =>
  Array.from({ length: 30 }, (_, i) => {
    const day = T0 - (29 - i) * DAY;
    const base = { atlas: 0.024, notes: 0.012, inbox: 0.18, shortlinks: 0.001 }[app] ?? 0.01;
    return { date: iso(day).slice(0, 10), usd: Math.round(base * (0.8 + 0.4 * noise(day, 3)) * 1000) / 1000 };
  });

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

const readOnly = (what: string) =>
  Effect.fail(new Conflict({ code: 'demo', message: `The demo API doesn't ${what}.` }));

const SessionDemo = HttpApiBuilder.group(PlatformApi, 'session', (h) =>
  Effect.succeed(
    h.handleAll({
      cliLogin: () => readOnly('sign in the CLI'),
      me: () => Effect.succeed({ github: 'demo', role: 'admin' as const }),
    }),
  ),
);

/** Every demo app's prod, listed, with its edge traffic by day. */
const PublicDemo = HttpApiBuilder.group(PlatformApi, 'public', (h) =>
  Effect.succeed(
    h.handleAll({
      apps: () => {
        const days = directoryDays(T0);
        const apps = APPS.flatMap((app) => {
          const prod = stagesOf(app).find((s) => s.stage === 'prod');
          const live = deploymentsOf(app.record.name, 'prod').find((d) => d.id === prod?.currentDeployment);
          if (!prod || !live) return [];
          const requests = days.map(
            (day) => bucketTraffic(app, app.routes, day, DAY).req * EDGE_PER_SERVER_REQUEST,
          );
          const pageViews = requests.map((n) => Math.round(n * PAGE_VIEW_SHARE));
          return [publicApp(app.record, { ...prod, up: true }, live, live, { pageViews, requests })];
        });
        return Effect.succeed({
          generatedAt: iso(T0),
          days: days.map((d) => iso(d).slice(0, 10)),
          apps: apps.toSorted((a, b) => a.name.localeCompare(b.name)),
        });
      },
    }),
  ),
);

const AppsDemo = HttpApiBuilder.group(PlatformApi, 'apps', (h) =>
  Effect.succeed(
    h.handleAll({
      list: () => Effect.succeed(APPS.map(summary)),
      create: () => readOnly('create apps'),
      get: ({ params }) => Effect.map(demoApp(params.app), summary),
      update: () => readOnly('change apps'),
      remove: () => readOnly('remove apps'),
    }),
  ),
);

const StagesDemo = HttpApiBuilder.group(PlatformApi, 'stages', (h) =>
  Effect.succeed(
    h.handleAll({
      list: ({ params }) => Effect.map(demoApp(params.app), stagesOf),
      destroy: () => readOnly('destroy stages'),
      rollback: () => readOnly('roll back stages'),
    }),
  ),
);

const DeploymentsDemo = HttpApiBuilder.group(PlatformApi, 'deployments', (h) =>
  Effect.succeed(
    h.handleAll({
      list: ({ params, query }) =>
        Effect.map(demoApp(params.app), (a) =>
          deploymentsOf(a.record.name, query.stage).slice(0, query.limit ?? 50),
        ),
      create: () => readOnly('deploy'),
      get: ({ params }) => {
        const d = APPS.flatMap((a) => deploymentsOf(a.record.name)).find((x) => x.id === params.id);
        if (!d) return Effect.fail(NotFound.of(`deployment ${params.id}`));
        const app = findApp(d.app)!;
        return Effect.succeed({
          ...d,
          manifest: {
            name: app.record.name,
            web: {
              server: 'src/server.ts',
              static: 'dist',
              spa: true,
              compute: 'auto',
              timeoutSeconds: 30,
              memoryMb: 512,
              serverRoutes: ['/api/'],
            },
            auth: { enabled: true, required: false },
            db: app.db,
            queues: Object.fromEntries(
              app.jobs
                .filter((j) => j.kind === 'queue')
                .map((j) => [j.name, { memoryMb: 512, timeoutSeconds: 60, maxAttempts: 3 }]),
            ),
            events: app.jobs.filter((j) => j.kind === 'event').map((j) => j.name),
            eventOptions: {},
            crons: Object.fromEntries(
              app.jobs
                .filter((j) => j.kind === 'cron')
                .map((j) => [j.name, { schedule: '0 7 * * *', memoryMb: 512, timeoutSeconds: 60 }]),
            ),
            storage: [...app.storage],
            storageOptions: {},
            secrets: ['FEED_TOKEN'],
            env: {},
            ...(app.realtime ? { realtime: { subscribe: 'signed-in' as const, channels: ['notes/*'] } } : {}),
            ...(app.email ? { email: { name: 'Inbox', dailyLimit: 200 } } : {}),
            services: Object.fromEntries(
              app.services.map((s) => [
                s,
                { entry: `src/${s}.ts`, cpu: 0.25, memoryMb: 512, spot: true, previewMinutes: 30 },
              ]),
            ),
          } as never,
        });
      },
      start: () => readOnly('deploy'),
    }),
  ),
);

const ObserveDemo = HttpApiBuilder.group(PlatformApi, 'observe', (h) =>
  Effect.succeed(
    h.handleAll({
      metrics: ({ params, query }) =>
        Effect.map(demoApp(params.app), (a) => {
          const w = windowOf(query);
          const res = storedRes(w);
          const s = series(
            a,
            query.stage ?? 'prod',
            { metric: 'requests', stat: 'count', groupBy: 'status' },
            w,
            res,
          );
          const hist =
            series(a, query.stage ?? 'prod', { metric: 'latency', stat: 'histogram' }, w, res).histogram ??
            [];
          return {
            app: a.record.name,
            stage: query.stage ?? 'prod',
            res,
            points: s.timestamps.map((ts, i) => {
              const v = (k: string) => s.series.find((l) => l.key === k)?.values[i] ?? 0;
              const hh = hist[i] ?? [];
              return {
                ts,
                req: v('2xx') + v('3xx') + v('4xx') + v('5xx'),
                s2xx: v('2xx'),
                s3xx: v('3xx'),
                s4xx: v('4xx'),
                s5xx: v('5xx'),
                p50: pct(hh, 50),
                p95: pct(hh, 95),
                p99: pct(hh, 99),
                cold: 0,
              };
            }),
          };
        }),
      series: ({ params, query }) =>
        Effect.flatMap(demoApp(params.app), (a) => {
          const problem = checkSeriesQuery(query.q);
          if (problem) return Effect.fail(BadRequest.of(problem));
          const w = windowOf(query);
          return Effect.succeed(series(a, query.stage ?? 'prod', query.q, w, resOf(w, query.res)));
        }),
      routes: ({ params, query }) =>
        Effect.map(demoApp(params.app), (a) => {
          const w = windowOf(query);
          return a.routes.map((r) => {
            const t = bucketTraffic(a, [r], w.from, w.to - w.from);
            return {
              route: r.route,
              method: r.method,
              req: t.req,
              s5xx: t.s5xx,
              s4xx: t.s4xx,
              p50: pct(t.hist, 50),
              p95: pct(t.hist, 95),
            };
          });
        }),
      jobs: ({ params, query }) =>
        Effect.map(demoApp(params.app), (a) => {
          const w = windowOf(query);
          return {
            jobs: a.jobs.map((j) => {
              const b = jobBucket(j, w.from, w.to - w.from);
              return {
                kind: j.kind,
                name: j.name,
                ok: b.ok,
                error: b.error,
                p95: pct(b.hist, 95),
                lastRun: iso(
                  T0 - Math.round((60 / Math.max(j.perHour, 0.1)) * MIN * noise(T0, j.name.length)),
                ),
              };
            }),
            crons: a.jobs
              .filter((j) => j.kind === 'cron')
              .map((j) => ({ name: j.name, schedule: j.name === 'digest' ? '0 7 * * *' : '0 3 * * 1' })),
          };
        }),
      queues: ({ params }) =>
        Effect.map(demoApp(params.app), (a) =>
          a.jobs
            .filter((j) => j.kind === 'queue')
            .map((j) => ({
              name: j.name,
              scheduled: j.name === 'refresh' ? 3 : 0,
              deadLetter: j.name === 'refresh' ? 1 : 0,
            })),
        ),
      deadLetters: ({ params }) =>
        Effect.map(demoApp(params.app), (a) =>
          a.record.name === 'atlas'
            ? {
                total: 1,
                items: [
                  {
                    id: 'msg_01',
                    kind: 'queue' as const,
                    name: 'refresh',
                    attempts: 2,
                    error: {
                      name: 'TypeError',
                      message: "Cannot read properties of undefined (reading 'feedUrl')",
                    },
                    failedAt: iso(INCIDENT.from + 25 * MIN),
                    source: 'sdk' as const,
                    preview: '{"source":"src_19","reason":"scheduled"}',
                  },
                ],
              }
            : { total: 0, items: [] },
        ),
      realtime: ({ params, query }) =>
        Effect.map(demoApp(params.app), (a) => {
          const w = windowOf(query);
          const res = storedRes(w);
          const read = (measure: string) =>
            series(a, query.stage ?? 'prod', { metric: 'realtime', stat: 'sum', filter: { measure } }, w, res)
              .series[0]?.values ?? [];
          const [events, publishes, subscribes, errors] = ['events', 'publishes', 'subscribes', 'errors'].map(
            read,
          );
          const ts = series(
            a,
            query.stage ?? 'prod',
            { metric: 'realtime', stat: 'sum', filter: { measure: 'events' } },
            w,
            res,
          ).timestamps;
          const sum = (v: ReadonlyArray<number | null>) => v.reduce<number>((n, x) => n + (x ?? 0), 0);
          return {
            app: a.record.name,
            stage: query.stage ?? 'prod',
            enabled: a.realtime,
            ...(a.realtime ? { subscribe: 'signed-in' as const } : {}),
            channels: a.realtime ? ['notes/*'] : [],
            res,
            totals: {
              events: sum(events!),
              publishes: sum(publishes!),
              subscribes: sum(subscribes!),
              errors: sum(errors!),
            },
            points: ts.map((t, i) => ({
              ts: t,
              events: events![i] ?? 0,
              publishes: publishes![i] ?? 0,
              subscribes: subscribes![i] ?? 0,
              errors: errors![i] ?? 0,
            })),
          };
        }),
      email: ({ params, query }) =>
        Effect.map(demoApp(params.app), (a) => {
          const w = windowOf(query);
          const res = storedRes(w);
          const step = { '1m': MIN, '1h': HOUR, '1d': DAY }[res];
          const points: Array<{
            ts: string;
            sends: number;
            deliveries: number;
            bounces: number;
            complaints: number;
          }> = [];
          for (let t = Math.floor(w.from / step) * step; t < w.to; t += step) {
            const sends = a.email
              ? Math.round(1.6 * (step / HOUR) * diurnal(t) * (0.6 + 0.8 * noise(t, 81)))
              : 0;
            points.push({
              ts: iso(t),
              sends,
              deliveries: Math.round(sends * 0.98),
              bounces: noise(t, 82) < 0.05 ? 1 : 0,
              complaints: 0,
            });
          }
          const sum = (k: 'sends' | 'deliveries' | 'bounces' | 'complaints') =>
            points.reduce((n, p) => n + p[k], 0);
          return {
            app: a.record.name,
            stage: query.stage ?? 'prod',
            enabled: a.email,
            ...(a.email
              ? {
                  from: 'Inbox <inbox@mail.example.com>',
                  sending: { status: 'enabled' as const },
                  today: { sent: 41, limit: 200 },
                }
              : {}),
            res,
            totals: {
              sends: sum('sends'),
              deliveries: sum('deliveries'),
              bounces: sum('bounces'),
              complaints: sum('complaints'),
            },
            points,
          };
        }),
      customMetrics: ({ params, query }) =>
        Effect.map(demoApp(params.app), (a) => {
          const w = windowOf(query);
          const res = w.to - w.from <= 14 * DAY ? ('1h' as const) : ('1d' as const);
          return {
            app: a.record.name,
            stage: query.stage ?? 'prod',
            res,
            metrics: a.metrics.map((m) => {
              const count = series(
                a,
                query.stage ?? 'prod',
                { metric: 'custom', stat: 'count', filter: { names: [m.name] } },
                w,
                res,
              );
              const sum = series(
                a,
                query.stage ?? 'prod',
                { metric: 'custom', stat: 'sum', filter: { names: [m.name] } },
                w,
                res,
              );
              const points = count.timestamps.map((ts, i) => ({
                ts,
                count: count.series[0]?.values[i] ?? 0,
                sum: sum.series[0]?.values[i] ?? 0,
              }));
              return {
                name: m.name,
                ...(m.unit ? { unit: m.unit } : { unit: 'count' }),
                count: points.reduce((n, p) => n + p.count, 0),
                sum: points.reduce((n, p) => n + p.sum, 0),
                points,
              };
            }),
          };
        }),
      limits: ({ params, query }) =>
        Effect.map(demoApp(params.app), (a) => {
          const w = windowOf(query);
          const res = w.to - w.from <= 14 * DAY ? ('1h' as const) : ('1d' as const);
          return {
            app: a.record.name,
            stage: query.stage ?? 'prod',
            res,
            limits: a.limits.map((l) => {
              const s = series(
                a,
                query.stage ?? 'prod',
                { metric: 'rate_limit', stat: 'count', groupBy: 'outcome', filter: { names: [l] } },
                w,
                res,
              );
              const values = (k: string) => s.series.find((x) => x.key === k)?.values ?? [];
              const points = s.timestamps.map((ts, i) => ({
                ts,
                allowed: values('allowed')[i] ?? 0,
                denied: values('denied')[i] ?? 0,
              }));
              return {
                name: l,
                allowed: points.reduce((n, p) => n + p.allowed, 0),
                denied: points.reduce((n, p) => n + p.denied, 0),
                points,
              };
            }),
          };
        }),
      services: ({ params, query }) =>
        Effect.map(demoApp(params.app), (a) => {
          const w = windowOf(query);
          const res = storedRes(w);
          return {
            app: a.record.name,
            stage: query.stage ?? 'prod',
            res,
            services: a.services.map((s) => {
              const cpu = series(
                a,
                query.stage ?? 'prod',
                { metric: 'service', stat: 'avg', filter: { measure: 'cpu', names: [s] } },
                w,
                res,
              );
              const mem = series(
                a,
                query.stage ?? 'prod',
                { metric: 'service', stat: 'avg', filter: { measure: 'memory', names: [s] } },
                w,
                res,
              );
              return {
                name: s,
                cpu: 0.25,
                memoryMb: 512,
                spot: true,
                state: 'running' as const,
                desired: 1,
                running: 1,
                pending: 0,
                deployment: deploymentsOf(a.record.name, 'prod')[0]?.id,
                startedAt: iso(T0 - 30 * HOUR),
                lastStop: {
                  at: iso(T0 - 30 * HOUR - 4 * MIN),
                  reason: 'Spot capacity was reclaimed',
                  exitCode: 143,
                },
                events: [
                  {
                    at: iso(T0 - 30 * HOUR),
                    message: 'service inbox--prod--imap-sync has reached a steady state.',
                  },
                  {
                    at: iso(T0 - 30 * HOUR - 3 * MIN),
                    message: 'service inbox--prod--imap-sync has started 1 tasks.',
                  },
                ],
                starts: 2,
                failedRuns: 1,
                points: cpu.timestamps.map((ts, i) => ({
                  ts,
                  cpu: cpu.series[0]?.values[i] ?? null,
                  memory: mem.series[0]?.values[i] ?? null,
                })),
                monthly: { computeUsd: 2.52, publicIpv4Usd: 3.6, totalUsd: 6.12 },
              };
            }),
          };
        }),
      errors: ({ params, query }) =>
        Effect.map(demoApp(params.app), (a) =>
          errorGroups(a, query.stage ?? 'prod')
            .map((g) => ({ ...g, status: errorStatus.get(`${a.record.name}/${g.fingerprint}`) ?? g.status }))
            .filter((g) => !query.status || g.status === query.status)
            .toSorted((x, y) => y.lastSeen.localeCompare(x.lastSeen)),
        ),
      updateError: ({ params, payload }) =>
        Effect.sync(() => {
          errorStatus.set(`${params.app}/${params.fingerprint}`, payload.status);
          return payload;
        }),
      uptime: ({ params, query }) =>
        Effect.map(demoApp(params.app), (a) => {
          if ((query.stage ?? 'prod') !== 'prod') return [];
          const w = windowOf(query);
          const out = [];
          for (let t = Math.floor(w.from / (5 * MIN)) * 5 * MIN; t <= Math.min(w.to, T0); t += 5 * MIN) {
            const traffic = bucketTraffic(a, a.routes, t - 10 * MIN, 10 * MIN);
            out.push(
              traffic.req > 0
                ? {
                    ts: iso(t),
                    ok: !(traffic.req >= 3 && traffic.s5xx * 2 >= traffic.req),
                    source: 'traffic' as const,
                    req: traffic.req,
                    s5xx: traffic.s5xx,
                  }
                : { ts: iso(t), ok: true, source: 'check' as const, status: 200, ms: 140 },
            );
          }
          return out;
        }),
      cost: ({ params }) =>
        Effect.map(demoApp(params.app), (a) => {
          const days = costDays(a.record.name);
          const month = iso(T0).slice(0, 7);
          return {
            app: a.record.name,
            currency: 'USD' as const,
            days,
            monthToDateUsd:
              Math.round(days.filter((d) => d.date.startsWith(month)).reduce((n, d) => n + d.usd, 0) * 100) /
              100,
            ...(a.services.length
              ? {
                  alwaysOn: a.services.map((s) => ({
                    stage: 'prod',
                    kind: 'service' as const,
                    name: s,
                    detail: '0.25 vCPU · 512 MB · Spot',
                    monthly: { computeUsd: 2.52, publicIpv4Usd: 3.6, totalUsd: 6.12 },
                  })),
                }
              : {}),
            compute: [
              {
                stage: 'prod',
                setting: 'auto' as const,
                compute: a.record.name === 'shortlinks' ? ('request' as const) : ('instance' as const),
                estimate: {
                  at: iso(T0 - 7 * HOUR),
                  request: {
                    monthlyUsd: a.record.name === 'shortlinks' ? 0.04 : 3.9,
                    coldStartsPerMonth: 1800,
                  },
                  instance: {
                    monthlyUsd: a.record.name === 'shortlinks' ? 2.1 : 2.6,
                    environmentHoursPerMonth: 744,
                  },
                  requestsPerMonth: Math.round(a.peak * 60 * 24 * 30 * 0.55),
                  days: 7,
                },
              },
            ],
          };
        }),
      logs: ({ params, query }) =>
        Effect.map(demoApp(params.app), (a) => {
          const w = windowOf(query, '1h');
          const page = logLines(a, query.stage ?? 'prod', w, {
            q: query.q,
            stream: query.stream,
            f: query.f,
            limit: Math.min(query.limit ?? 200, 1000),
            before: query.next ? Number(query.next) : undefined,
          });
          return { lines: page.lines, ...(page.next !== undefined ? { nextToken: String(page.next) } : {}) };
        }),
      tail: ({ params, query }) =>
        Effect.map(demoApp(params.app), (a) =>
          Stream.tick('2 seconds').pipe(
            Stream.flatMap(() => {
              const now = Date.now();
              const lines = requestsAt(a, query.stage ?? 'prod', Math.floor(now / MIN) * MIN, 1)
                .slice(0, 3)
                .map((r) => ({
                  ts: iso(now - Math.floor(noise(now, r.dur) * 1500)),
                  stream: 'web',
                  level: r.status >= 500 ? 'error' : 'info',
                  message: `${r.route.method} ${r.route.route} → ${r.status} · ${r.dur}ms`,
                  trace: r.trace,
                }))
                .filter((l) => matchesLine(l, query.q, query.stream, query.f));
              return Stream.fromIterable(lines.map((data) => ({ event: 'line' as const, data })));
            }),
          ),
        ),
      trace: ({ params, query }) =>
        Effect.map(demoApp(params.app), (a) => ({
          trace: params.trace,
          events: traceEvents(a, query.stage ?? 'prod', params.trace),
        })),
      traces: ({ params, query }) =>
        Effect.map(demoApp(params.app), (a) =>
          traceSummaries(
            a,
            query.stage ?? 'prod',
            windowOf(query, '6h'),
            query.f,
            Math.min(query.limit ?? 200, 1000),
          ),
        ),
      logStats: ({ params, query }) =>
        Effect.map(demoApp(params.app), (a) => {
          const w = windowOf(query, '1h');
          const res = resOf(w, query.res);
          const step = QUERY_RESOLUTION_MS[res];
          const timestamps: string[] = [];
          const levels = {
            error: [] as number[],
            warn: [] as number[],
            info: [] as number[],
            debug: [] as number[],
            system: [] as number[],
          };
          const counts = {
            level: new Map<string, number>(),
            stream: new Map<string, number>(),
            route: new Map<string, number>(),
            status: new Map<string, number>(),
            rev: new Map<string, number>(),
          };
          const bump = (m: Map<string, number>, k: string | undefined, n = 1) =>
            k && m.set(k, (m.get(k) ?? 0) + n);
          let total = 0;
          for (
            let t = Math.floor(w.from / step) * step;
            t < Math.min(w.to, T0 + step) && timestamps.length < 400;
            t += step
          ) {
            timestamps.push(iso(t));
            // A few sampled minutes per bucket, scaled to the bucket.
            const sample = Math.min(step / MIN, 4);
            const scale = step / MIN / sample;
            const per = { error: 0, warn: 0, info: 0, debug: 0, system: 0 };
            for (let i = 0; i < sample; i++) {
              const m = t + Math.floor((i * step) / sample / MIN) * MIN;
              if (m > T0) break;
              const lines = logLines(
                a,
                query.stage ?? 'prod',
                { from: m, to: m + MIN },
                { q: query.q, stream: query.stream, f: query.f, limit: 400 },
              ).lines;
              for (const l of lines) {
                const level = (l.level ?? 'info') as keyof typeof per;
                per[level] += scale;
                bump(counts.level, level, scale);
                bump(counts.stream, l.stream, scale);
                const e = l.event as { route?: string; rev?: string; status?: number } | undefined;
                bump(counts.route, e?.route, scale);
                bump(counts.rev, e?.rev, scale);
                if (e?.status) bump(counts.status, `${String(e.status)[0]}xx`, scale);
              }
            }
            for (const k of Object.keys(levels) as Array<keyof typeof levels>) {
              levels[k].push(Math.round(per[k]));
              total += Math.round(per[k]);
            }
          }
          const top = (m: Map<string, number>) =>
            [...m.entries()]
              .map(([value, count]) => ({ value, count: Math.round(count) }))
              .toSorted((x, y) => y.count - x.count)
              .slice(0, 10);
          return {
            res,
            timestamps,
            levels,
            total,
            facets: {
              level: top(counts.level),
              stream: top(counts.stream),
              route: top(counts.route),
              status: top(counts.status),
              rev: top(counts.rev),
            },
          };
        }),
      logContext: ({ params, query }) =>
        Effect.map(demoApp(params.app), (a) => {
          const at = Number(query.ts);
          const before = Math.min(query.before ?? 50, 200);
          const after = Math.min(query.after ?? 50, 200);
          const older = logLines(
            a,
            query.stage ?? 'prod',
            { from: at - 30 * MIN, to: at + 1 },
            { stream: query.stream, limit: before + 1 },
          ).lines.toReversed();
          const newer = logLines(
            a,
            query.stage ?? 'prod',
            { from: at + 1, to: at + 30 * MIN },
            { stream: query.stream, limit: 2000 },
          )
            .lines.toReversed()
            .slice(0, after);
          return { lines: [...older, ...newer], anchor: Math.max(0, older.length - 1) };
        }),
      insights: ({ params, payload }) =>
        Effect.flatMap(demoApp(params.app), (a) => {
          if (/(^|\|)\s*source\b/i.test(payload.query))
            return Effect.fail(
              BadRequest.of('queries run on the stage’s own log groups; SOURCE isn’t allowed'),
            );
          const w = windowOf(payload, '1h');
          const stats = /\bstats\b/i.test(payload.query);
          if (stats && /bin\(/i.test(payload.query)) {
            const s = series(
              a,
              payload.stage ?? 'prod',
              { metric: 'requests', stat: 'count', groupBy: 'status' },
              w,
              resOf(w, undefined),
            );
            return Effect.succeed({
              columns: ['bin(5m)', 'status', 'count()'],
              rows: s.timestamps.flatMap((t, i) =>
                s.series
                  .filter((l) => (l.values[i] ?? 0) > 0)
                  .map((l) => [t.replace('T', ' ').slice(0, 19), l.key, String(l.values[i])]),
              ),
              recordsMatched: 1200,
              recordsScanned: 5400,
              bytesScanned: 1_830_000,
            });
          }
          if (stats) {
            return Effect.succeed({
              columns: ['route', 'count()', 'pct(dur, 95)'],
              rows: a.routes.map((r) => {
                const t = bucketTraffic(a, [r], w.from, w.to - w.from);
                return [`${r.method} ${r.route}`, String(t.req), String(pct(t.hist, 95) ?? '')];
              }),
              recordsMatched: 900,
              recordsScanned: 5400,
              bytesScanned: 1_830_000,
            });
          }
          const lines = logLines(a, payload.stage ?? 'prod', w, { limit: 100 }).lines;
          return Effect.succeed({
            columns: ['@timestamp', '@logStream', '@message'],
            rows: lines.map((l) => [l.ts.replace('T', ' ').slice(0, 23), l.stream, l.message]),
            recordsMatched: lines.length,
            recordsScanned: 5400,
            bytesScanned: 1_830_000,
          });
        }),
      errorOccurrences: ({ params, query }) =>
        Effect.map(demoApp(params.app), () => {
          const w = windowOf(query, '7d');
          const res = resOf(w, query.res);
          const step = QUERY_RESOLUTION_MS[res];
          const timestamps: string[] = [];
          const counts: number[] = [];
          for (let t = Math.floor(w.from / step) * step; t < Math.min(w.to, T0 + step); t += step) {
            timestamps.push(iso(t));
            const overlap = Math.max(0, Math.min(t + step, INCIDENT.to) - Math.max(t, INCIDENT.from));
            counts.push(
              params.fingerprint === 'fp_feedurl'
                ? Math.round((overlap / (INCIDENT.to - INCIDENT.from)) * 214)
                : Math.round(noise(t, params.fingerprint.length) * 2),
            );
          }
          return {
            res,
            timestamps,
            counts,
            revs: [
              {
                value: deploymentsOf(params.app, 'prod')[2]?.id ?? 'dep',
                count: counts.reduce((n, c) => n + c, 0),
              },
            ],
          };
        }),
    }),
  ),
);

const AlertsDemo = HttpApiBuilder.group(PlatformApi, 'alerts', (h) =>
  Effect.succeed(
    h.handleAll({
      list: ({ params, query }) =>
        Effect.succeed(
          [...alertRules.values()].filter(
            (r) => r.app === params.app && (!query.stage || r.stage === query.stage),
          ),
        ),
      create: ({ params, payload }) => {
        const problem = checkSeriesQuery(payload.query, { alert: true });
        if (problem) return Effect.fail(BadRequest.of(problem));
        const r: AlertRule = {
          id: newId('a'),
          app: params.app,
          ...payload,
          state: 'no_data',
          createdBy: 'demo',
          createdAt: iso(Date.now()),
          updatedAt: iso(Date.now()),
        };
        alertRules.set(r.id, r);
        return Effect.succeed(r);
      },
      update: ({ params, payload }) => {
        const prev = alertRules.get(params.id);
        if (!prev || prev.app !== params.app) return Effect.fail(NotFound.of('alert rule'));
        const problem = checkSeriesQuery(payload.query, { alert: true });
        if (problem) return Effect.fail(BadRequest.of(problem));
        const changed =
          JSON.stringify([prev.stage, prev.query, prev.condition]) !==
          JSON.stringify([payload.stage, payload.query, payload.condition]);
        const next: AlertRule = {
          ...prev,
          ...payload,
          ...(changed ? { state: 'no_data' as const, stateSince: iso(Date.now()) } : {}),
          updatedAt: iso(Date.now()),
        };
        alertRules.set(next.id, next);
        return Effect.succeed(next);
      },
      remove: ({ params }) => Effect.sync(() => void alertRules.delete(params.id)),
      history: ({ params, query }) => {
        const w = windowOf(query, '7d');
        return Effect.succeed({
          events: alertEvents
            .toSorted((x, y) => y.ts.localeCompare(x.ts))
            .filter((e) => {
              const r = alertRules.get(e.rule);
              const t = Date.parse(e.ts);
              return (
                r?.app === params.app && (!query.stage || e.stage === query.stage) && t >= w.from && t <= w.to
              );
            }),
        });
      },
    }),
  ),
);

const ManageDemo = HttpApiBuilder.group(PlatformApi, 'manage', (h) =>
  Effect.succeed(
    h.handleAll({
      collections: ({ params }) =>
        Effect.map(demoApp(params.app), (a) => ({
          database: a.db,
          collections:
            a.record.name === 'atlas'
              ? [
                  { name: 'sources', sampled: 42 },
                  { name: 'items', sampled: 500 },
                  { name: 'users', sampled: 3 },
                ]
              : a.db
                ? [{ name: 'notes', sampled: 120 }]
                : [],
        })),
      items: ({ query }) =>
        Effect.succeed({
          items: Array.from({ length: 25 }, (_, i) =>
            query.collection === 'sources'
              ? {
                  id: `src_${i + 1}`,
                  title: `Source ${i + 1}`,
                  feedUrl: `https://news${i % 4}.example.org/feed.xml`,
                  lastFetched: iso(T0 - i * 7 * MIN),
                  items: 40 + i * 3,
                }
              : {
                  id: `item_${i + 1}`,
                  source: `src_${(i % 12) + 1}`,
                  title: `Item ${i + 1}`,
                  published: iso(T0 - i * 41 * MIN),
                  tags: ['feeds', i % 2 ? 'web' : 'search'],
                },
          ),
          ...(query.cursor ? {} : { cursor: 'page2' }),
        }),
      storage: ({ params, query }) =>
        Effect.map(demoApp(params.app), (a) =>
          query.store
            ? {
                objects: Array.from({ length: 12 }, (_, i) => ({
                  key: `${query.prefix ?? ''}src_${i + 1}.xml`,
                  size: 18_000 + i * 2_311,
                  lastModified: iso(T0 - i * 3 * HOUR),
                })),
              }
            : { stores: [...a.storage], public: [] },
        ),
      storageUrl: ({ query }) =>
        Effect.succeed({ url: `https://example.com/${encodeURIComponent(query.key)}` }),
      secrets: () =>
        Effect.succeed({
          secrets: [
            { name: 'FEED_TOKEN', scope: 'stage' as const, stage: 'prod', updatedAt: iso(T0 - 12 * DAY) },
            { name: 'SENTRY_DSN', scope: 'shared' as const, updatedAt: iso(T0 - 40 * DAY) },
          ],
          declared: ['FEED_TOKEN', 'RANKING_KEY'],
          missing: ['RANKING_KEY'],
        }),
      putSecret: () => Effect.void,
      deleteSecret: () => Effect.void,
      runCron: () => Effect.succeed({ started: iso(Date.now()) }),
      suppressed: () =>
        Effect.succeed({
          items: [{ address: 'bounced@example.net', reason: 'bounce' as const, since: iso(T0 - 5 * DAY) }],
        }),
      unsuppress: () => Effect.void,
      resumeEmail: () => Effect.succeed({ status: 'enabled' as const }),
      restartService: ({ params }) => Effect.succeed({ name: params.name, desired: 1 }),
      startService: ({ params }) => Effect.succeed({ name: params.name, desired: 1 }),
      stopService: ({ params }) => Effect.succeed({ name: params.name, desired: 0 }),
      redrive: () => Effect.succeed({ count: 1 }),
      discard: () => Effect.succeed({ count: 1 }),
    }),
  ),
);

const AdminDemo = HttpApiBuilder.group(PlatformApi, 'admin', (h) =>
  Effect.succeed(
    h.handleAll({
      overview: () =>
        Effect.succeed({
          members: [{ github: 'demo', role: 'admin' as const }],
          limits: {
            appsPerMember: 20,
            stagesPerApp: 5,
            emailsPerDay: 2000,
            servicesPerApp: 2,
            edgeRequestsPerMinute: 600,
            edgeFloorAt: 3000,
          },
          apps: APPS.length,
          stages: APPS.reduce((n, a) => n + a.stages.length, 0),
          previews: APPS.reduce((n, a) => n + a.stages.filter((s) => s !== 'prod').length, 0),
          down: [],
          cost: {
            total: {
              app: 'total',
              currency: 'USD' as const,
              days: costDays('total').map((d) => ({ ...d, usd: d.usd * 40 })),
              monthToDateUsd: 18.42,
            },
            shared: {
              app: 'platform',
              currency: 'USD' as const,
              days: costDays('platform').map((d) => ({ ...d, usd: d.usd * 25 })),
              monthToDateUsd: 11.9,
            },
          },
        }),
      edge: ({ query }) => {
        const w = windowOf(query);
        const res = storedRes(w);
        const step = { '1m': MIN, '1h': HOUR, '1d': DAY }[res];
        const points: Array<{ ts: string; blocked: number; allowed: number }> = [];
        // Every app's traffic passes the edge; the floor was on for the incident's flood.
        const peak = APPS.reduce((n, a) => n + a.peak, 0);
        for (let t = Math.floor(w.from / step) * step; t < w.to; t += step)
          points.push({
            ts: iso(t),
            blocked: inIncident(t) ? Math.round(9 * (step / MIN) * (0.5 + noise(t, 91))) : 0,
            allowed: Math.round(peak * (step / MIN) * diurnal(t) * (0.8 + 0.4 * noise(t, 92))),
          });
        return Effect.succeed({
          enabled: true,
          state: {
            on: false,
            since: iso(INCIDENT.to),
            why: 'requests across the edge fell below 3,000 a minute',
          },
          limit: 600,
          threshold: 3000,
          res,
          totals: {
            blocked: points.reduce((n, p) => n + p.blocked, 0),
            allowed: points.reduce((n, p) => n + p.allowed, 0),
          },
          points,
          samples: [],
        });
      },
    }),
  ),
);

/** Everyone is the demo admin. */
const AuthenticatedDemo = Layer.succeed(
  Authenticated,
  Authenticated.of((httpEffect) =>
    Effect.provideService(httpEffect, CurrentPrincipal, { kind: 'member', github: 'demo', role: 'admin' }),
  ),
);

export const DemoLive = Layer.mergeAll(HttpApiBuilder.layer(PlatformApi), RouterErrorsLive).pipe(
  Layer.provide([
    SessionDemo,
    PublicDemo,
    AppsDemo,
    StagesDemo,
    DeploymentsDemo,
    ObserveDemo,
    AlertsDemo,
    ManageDemo,
    AdminDemo,
  ]),
  Layer.provide([AuthenticatedDemo, RequestValidationLive]),
);

if (import.meta.main) {
  const port = process.env.PORT ?? '8787';
  process.env.PORT = port;
  process.env[BINDINGS_ENV] ??= JSON.stringify({
    v: 2,
    app: 'platform',
    stage: 'demo',
    host: `127.0.0.1:${port}`,
    url: `http://127.0.0.1:${port}`,
    revision: 'demo',
    region: 'us-east-1',
    account: '000000000000',
    secrets: {
      path: names.secretsPath('platform', 'demo'),
      sharedPath: names.sharedSecretsPath('platform'),
      names: [],
    },
  } satisfies Bindings);
  await startServer(toFetchHandler(DemoLive));
  console.log(`demo API on http://127.0.0.1:${port} (sample data; run \`pnpm web:dev\` for the console)`);
}
