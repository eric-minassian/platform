/**
 * An app stage at a glance: the deployment that's live and where it came
 * from, five figures against the previous period, page views and the charts
 * that explain most incidents (status, latency, errors, and job runs when the
 * app has jobs) on one cursor with deployment markers, the busiest routes, what
 * happened lately, and the custom metrics and rate limits the stage recorded.
 */
import { useAtomValue } from '@effect/atom-react';
import {
  type CustomMetricStats,
  type DeploymentRecord,
  type ErrorGroup,
  type LimitStats,
  type MetricsView,
  percentile,
  QUERY_RESOLUTION_MS,
  type QueryResolution,
  type SeriesQuery,
  type SeriesResponse,
  seriesUnit,
} from '@ericminassian/platform-core';
import { Link, useNavigate } from '@tanstack/react-router';
import { Option } from 'effect';
import { AsyncResult, Atom } from 'effect/reactivity';
import {
  ArrowUpRight,
  Bell,
  CircleCheck,
  FolderGit2,
  Layers,
  Rocket,
  ScrollText,
  TriangleAlert,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { ApiClient, fresh, timeToLive } from '../../client.ts';
import { Sparkline } from '../../components/charts/sparkline.tsx';
import { columns, DataTable } from '../../components/data-table.tsx';
import {
  actorLabel,
  COMPUTE_LABEL,
  DeploymentSource,
  DeploymentState,
  RollbackButton,
  useRollback,
} from '../../components/deployments/shared.tsx';
import { ChartPanel } from '../../components/metrics/chart-panel.tsx';
import {
  Detail,
  EmptyState,
  Loaded,
  Mono,
  PageHeader,
  Panel,
  RouteLabel,
  Stat,
  Stats,
  StatusPill,
  statusTone,
} from '../../components/page.tsx';
import { Badge } from '../../components/ui/badge.tsx';
import { Button } from '../../components/ui/button.tsx';
import { alertRulesAtom, deploymentsAtom, family, seriesAtom } from '../../data/atoms.ts';
import { stageOf, useAppSummary, useDeployment, useLiveManifest, visitOf } from '../../data/hooks.ts';
import { fmtMs, fmtNum, fmtPct, fmtUsd, relTime, shortId } from '../../format.ts';
import { useAutoRefresh, useStage, useSticky, useTime } from '../../lib/hooks.ts';
import { formatterFor } from '../../lib/series.ts';
import { resolveWindow, type TimeSearch } from '../../lib/time.ts';
import { viewResolution } from '../../lib/view.ts';
import { overviewRoute } from '../../router.tsx';

const PAGE_VIEWS: MetricsView = {
  kind: 'metrics',
  queries: [{ id: 'a', metric: 'page_views', stat: 'count' }],
  chart: 'bar',
};
const STATUS: MetricsView = {
  kind: 'metrics',
  queries: [{ id: 'a', metric: 'requests', stat: 'count', groupBy: 'status' }],
  chart: 'bar',
};
const LATENCY: MetricsView = {
  kind: 'metrics',
  queries: [
    { id: 'a', metric: 'latency', stat: 'p50', label: 'p50' },
    { id: 'b', metric: 'latency', stat: 'p95', label: 'p95' },
    { id: 'c', metric: 'latency', stat: 'p99', label: 'p99' },
  ],
  chart: 'line',
  scale: 'log',
};
const ERROR_RATE: MetricsView = {
  kind: 'metrics',
  queries: [
    { id: 'a', metric: 'requests', stat: 'percent', filter: { status: ['5xx'] }, label: '5xx % of requests' },
  ],
  chart: 'area',
};
const JOB_RUNS: MetricsView = {
  kind: 'metrics',
  queries: [{ id: 'a', metric: 'jobs', stat: 'count', groupBy: 'outcome' }],
  chart: 'bar',
};

const STATUS_QUERY: SeriesQuery = { metric: 'requests', stat: 'count', groupBy: 'status' };
const HISTOGRAM_QUERY: SeriesQuery = { metric: 'latency', stat: 'histogram' };
const ROUTES_QUERY: SeriesQuery = { metric: 'requests', stat: 'count', groupBy: 'route' };

const uptimeAtom = family((k: { app: string; stage: string; time: TimeSearch }) =>
  fresh(
    ApiClient.query('observe', 'uptime', {
      params: { app: k.app },
      query: { stage: k.stage, ...apiParams(k.time) },
      timeToLive,
    }),
  ),
);
const routesAtom = family((k: { app: string; stage: string; time: TimeSearch }) =>
  fresh(
    ApiClient.query('observe', 'routes', {
      params: { app: k.app },
      query: { stage: k.stage, ...apiParams(k.time) },
      timeToLive,
    }),
  ),
);
const customMetricsAtom = family((k: { app: string; stage: string; time: TimeSearch }) =>
  fresh(
    ApiClient.query('observe', 'customMetrics', {
      params: { app: k.app },
      query: { stage: k.stage, ...apiParams(k.time) },
      timeToLive,
    }),
  ),
);
const limitsAtom = family((k: { app: string; stage: string; time: TimeSearch }) =>
  fresh(
    ApiClient.query('observe', 'limits', {
      params: { app: k.app },
      query: { stage: k.stage, ...apiParams(k.time) },
      timeToLive,
    }),
  ),
);
const openErrorsAtom = family((k: { app: string; stage: string }) =>
  fresh(
    ApiClient.query('observe', 'errors', {
      params: { app: k.app },
      query: { stage: k.stage, status: 'open' },
      timeToLive,
    }),
  ),
);
const alertHistoryAtom = family((k: { app: string; stage: string; time: TimeSearch }) =>
  fresh(
    ApiClient.query('alerts', 'history', {
      params: { app: k.app },
      query: { stage: k.stage, ...apiParams(k.time) },
      timeToLive,
    }),
  ),
);

function apiParams(t: TimeSearch): { range?: string; from?: string; to?: string } {
  return t.from !== undefined && t.to !== undefined
    ? { from: String(t.from), to: String(t.to) }
    : { range: t.range ?? '24h' };
}

/**
 * The window just before this one, of the same length. A moving window's is
 * pinned to the start of the current bucket, so it changes once a bucket
 * rather than on every refresh.
 */
function previousWindow(time: TimeSearch, now: number, res: QueryResolution): TimeSearch {
  const step = QUERY_RESOLUTION_MS[res];
  const w = resolveWindow(time, Math.floor(now / step) * step);
  const span = w.to - w.from;
  return { from: w.from - span, to: w.from };
}

interface Figures {
  readonly requests: number;
  readonly errors: number;
  readonly p95: number | null;
  readonly traffic: readonly number[];
}

function figures(status: SeriesResponse, histogram: SeriesResponse): Figures {
  const sum = (key?: string) =>
    status.series
      .filter((s) => key === undefined || s.key === key)
      .reduce((n, s) => n + s.values.reduce<number>((a, v) => a + (v ?? 0), 0), 0);
  const traffic = status.timestamps.map((_, i) => status.series.reduce((n, s) => n + (s.values[i] ?? 0), 0));
  const hist: number[] = [];
  for (const counts of histogram.histogram ?? []) counts.forEach((c, i) => (hist[i] = (hist[i] ?? 0) + c));
  return { requests: sum(), errors: sum('5xx'), p95: percentile(hist, 95), traffic };
}

/** The current and previous windows' figures, answered together. */
const figuresAtom = family(
  (k: { app: string; stage: string; time: TimeSearch; previous: TimeSearch; res: QueryResolution }) =>
    Atom.make((get) => {
      const read = (time: TimeSearch, query: SeriesQuery) =>
        get(seriesAtom({ app: k.app, stage: k.stage, time, res: k.res, query }));
      return AsyncResult.all([
        read(k.time, STATUS_QUERY),
        read(k.time, HISTOGRAM_QUERY),
        read(k.previous, STATUS_QUERY),
        read(k.previous, HISTOGRAM_QUERY),
      ]);
    }),
);

function Delta({
  now,
  before,
  better,
}: {
  now: number | null;
  before: number | null;
  better: 'up' | 'down' | 'none';
}) {
  if (now === null || before === null || before === 0) return <span>no earlier data</span>;
  const change = (now - before) / before;
  if (Math.abs(change) < 0.005) return <span>same as the previous period</span>;
  const good = better === 'none' ? undefined : change > 0 === (better === 'up');
  return (
    <span>
      <span className={good === undefined ? undefined : good ? 'text-ok' : 'text-bad'}>
        {change > 0 ? '+' : '−'}
        {fmtPct(Math.abs(change), Math.abs(change) < 0.1 ? 1 : 0)}
      </span>{' '}
      vs previous period
    </span>
  );
}

export function OverviewPage() {
  const { app } = overviewRoute.useParams();
  const stage = useStage();
  const time = useTime();
  const summary = Option.getOrUndefined(AsyncResult.value(useAppSummary(app)));
  const current = stageOf(summary, stage);

  if (summary && !current) {
    return (
      <>
        <PageHeader title={app} description={summary.app.description} />
        <Panel>
          <EmptyState title={`${app} has no ${stage} stage`}>
            Deploy it with <Mono>plat deploy{stage === 'prod' ? '' : ` --stage ${stage}`}</Mono>, or pick
            another stage in the sidebar.
          </EmptyState>
        </Panel>
      </>
    );
  }

  return (
    <>
      <Header app={app} stage={stage} />
      <LiveDeployment app={app} stage={stage} />
      <Figures app={app} stage={stage} time={time.search} cost={summary?.costMonthToDateUsd} />
      <Charts app={app} stage={stage} time={time.search} />
      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[3fr_2fr]">
        <TopRoutes app={app} stage={stage} time={time.search} />
        <Activity app={app} stage={stage} time={time.search} />
      </div>
      <Recorded app={app} stage={stage} time={time.search} />
    </>
  );
}

function Charts({ app, stage, time }: { app: string; stage: string; time: TimeSearch }) {
  const manifest = useLiveManifest(app, stage);
  const hasJobs =
    manifest !== undefined &&
    Object.keys(manifest.queues).length + manifest.events.length + Object.keys(manifest.crons).length > 0;
  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      <ChartPanel
        title="Page views"
        description="pages the router served, static or not; up to an hour behind"
        app={app}
        stage={stage}
        time={time}
        view={PAGE_VIEWS}
      />
      <ChartPanel
        title="Requests"
        description="the server's, by status class"
        app={app}
        stage={stage}
        time={time}
        view={STATUS}
      />
      <ChartPanel
        title="Latency"
        description="p50, p95 and p99, log scale"
        app={app}
        stage={stage}
        time={time}
        view={LATENCY}
      />
      <ChartPanel
        title="5xx rate"
        description="share of requests answered 5xx"
        app={app}
        stage={stage}
        time={time}
        view={ERROR_RATE}
      />
      {hasJobs && (
        <ChartPanel
          title="Job runs"
          description="by outcome"
          app={app}
          stage={stage}
          time={time}
          view={JOB_RUNS}
          className="xl:col-span-2"
        />
      )}
    </div>
  );
}

/** `Metrics.count` records a total, `Metrics.value` values to average. */
const isTotal = (m: CustomMetricStats) => (m.unit ?? 'count') === 'count';

const customCol = columns<CustomMetricStats>();
const customColumns = customCol.columns([
  customCol.accessor('name', {
    header: 'Metric',
    cell: ({ getValue }) => <Mono>{getValue()}</Mono>,
  }),
  customCol.accessor((m) => (isTotal(m) ? m.sum : m.count ? m.sum / m.count : 0), {
    id: 'value',
    header: 'Total or average',
    meta: { numeric: true },
    cell: ({ row: { original: m } }) =>
      isTotal(m) ? (
        fmtNum(m.sum)
      ) : (
        <>
          {formatterFor(m.unit ?? 'count')(m.count ? m.sum / m.count : 0)}{' '}
          <span className="text-muted-foreground">avg</span>
        </>
      ),
  }),
  customCol.accessor('count', {
    header: 'Recorded',
    meta: { numeric: true },
    cell: ({ getValue }) => fmtNum(getValue()),
  }),
  customCol.display({
    id: 'trend',
    header: 'Trend',
    cell: ({ row: { original: m } }) => (
      <Sparkline
        values={m.points.map((p) => (isTotal(m) ? p.sum : p.count ? p.sum / p.count : null))}
        width={84}
        height={20}
      />
    ),
  }),
]);

const limitCol = columns<LimitStats>();
const limitColumns = limitCol.columns([
  limitCol.accessor('name', {
    header: 'Limit',
    cell: ({ getValue }) => <Mono>{getValue()}</Mono>,
  }),
  limitCol.accessor('allowed', {
    header: 'Allowed',
    meta: { numeric: true },
    cell: ({ getValue }) => fmtNum(getValue()),
  }),
  limitCol.accessor('denied', {
    header: 'Denied',
    meta: { numeric: true },
    cell: ({ row: { original: l } }) => (
      <span className={l.denied ? 'text-warn' : undefined}>
        {fmtNum(l.denied)}
        {l.denied > 0 && (
          <span className="text-muted-foreground"> · {fmtPct(l.denied / (l.allowed + l.denied), 1)}</span>
        )}
      </span>
    ),
  }),
  limitCol.display({
    id: 'trend',
    header: 'Denied over time',
    cell: ({ row: { original: l } }) => (
      <Sparkline values={l.points.map((p) => p.denied)} width={84} height={20} />
    ),
  }),
]);

/** Custom metrics and rate limits, for stages that recorded any; a row opens its chart in Metrics. */
function Recorded({ app, stage, time }: { app: string; stage: string; time: TimeSearch }) {
  const navigate = useNavigate();
  const custom = Option.getOrUndefined(
    AsyncResult.value(useAtomValue(customMetricsAtom({ app, stage, time }))),
  );
  const limits = Option.getOrUndefined(AsyncResult.value(useAtomValue(limitsAtom({ app, stage, time }))));
  const metrics = custom?.metrics ?? [];
  const checked = limits?.limits ?? [];
  if (metrics.length === 0 && checked.length === 0) return null;
  const explore = (view: MetricsView) =>
    void navigate({ to: '/apps/$app/metrics', params: { app }, search: (prev) => ({ ...prev, view }) });
  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      {metrics.length > 0 && (
        <Panel flush title="Custom metrics" description="from Metrics.count and Metrics.value">
          <DataTable
            dense
            columns={customColumns}
            data={metrics}
            getRowId={(m) => m.name}
            onRowClick={(m) =>
              explore({
                kind: 'metrics',
                queries: [
                  {
                    id: 'a',
                    metric: 'custom',
                    stat: isTotal(m) ? 'sum' : 'avg',
                    filter: { names: [m.name] },
                  },
                ],
                chart: isTotal(m) ? 'bar' : 'line',
              })
            }
          />
        </Panel>
      )}
      {checked.length > 0 && (
        <Panel flush title="Rate limits" description="checks by limit">
          <DataTable
            dense
            columns={limitColumns}
            data={checked}
            getRowId={(l) => l.name}
            onRowClick={(l) =>
              explore({
                kind: 'metrics',
                queries: [
                  {
                    id: 'a',
                    metric: 'rate_limit',
                    stat: 'count',
                    groupBy: 'outcome',
                    filter: { names: [l.name] },
                  },
                ],
                chart: 'bar',
              })
            }
          />
        </Panel>
      )}
    </div>
  );
}

function Header({ app, stage }: { app: string; stage: string }) {
  const summary = Option.getOrUndefined(AsyncResult.value(useAppSummary(app)));
  const current = stageOf(summary, stage);
  const visit = current ? visitOf(summary, current) : undefined;
  const up = stage === 'prod' ? summary?.health?.up : undefined;
  return (
    <PageHeader
      title={
        <>
          {app}
          {current && (
            <StatusPill tone={up === false ? 'bad' : statusTone(current.status)}>
              {up === false ? 'Down' : current.status === 'active' ? 'Live' : current.status}
            </StatusPill>
          )}
        </>
      }
      description={summary?.app.description}
      actions={
        <>
          {summary?.app.repo && (
            <Button
              variant="outline"
              size="sm"
              render={
                <a
                  href={`https://github.com/${summary.app.repo}`}
                  target="_blank"
                  rel="noreferrer"
                  aria-label="Repository"
                />
              }
            >
              <FolderGit2 />
              Repository
            </Button>
          )}
          {current && visit && current.status !== 'destroyed' && (
            <Button
              size="sm"
              render={
                <a href={visit.url} target="_blank" rel="noreferrer" aria-label={`Visit ${visit.host}`} />
              }
            >
              Visit
              <ArrowUpRight />
            </Button>
          )}
        </>
      }
    />
  );
}

/**
 * The stage's live deployment, the way Vercel leads a project with its
 * production deployment: where it runs, what it is and where it came from,
 * with its logs and a rollback to the one before.
 */
function LiveDeployment({ app, stage }: { app: string; stage: string }) {
  const summary = Option.getOrUndefined(AsyncResult.value(useAppSummary(app)));
  const current = stageOf(summary, stage);
  const live = useDeployment(current?.currentDeployment);
  const deployments = Option.getOrElse(
    AsyncResult.value(useAtomValue(deploymentsAtom({ app, stage }))),
    (): readonly DeploymentRecord[] => [],
  );
  const { busy, rollBack } = useRollback(app);
  if (!current) return null;
  const visit = visitOf(summary, current);
  const previous = live
    ? deployments.find((d) => d.id !== live.id && d.status === 'succeeded' && d.createdAt < live.createdAt)
    : undefined;
  const firing = summary?.alerts?.alarm ?? 0;
  return (
    <Panel
      title={stage === 'prod' ? 'Production deployment' : `Live on ${stage}`}
      actions={
        <>
          {live && (
            <Button
              variant="outline"
              size="sm"
              render={
                <Link
                  to="/apps/$app/logs"
                  params={{ app }}
                  search={(prev) => ({ ...prev, f: { revs: [live.id] } })}
                />
              }
            >
              <ScrollText />
              Runtime logs
            </Button>
          )}
          {previous && (
            <RollbackButton
              stage={stage}
              deployment={previous}
              busy={busy}
              onRollback={() => rollBack(stage, previous)}
              trigger={<Button variant="outline" size="sm" />}
              label="Instant rollback"
            />
          )}
          <Button variant="outline" size="sm" render={<Link to="/apps/$app/deployments" params={{ app }} />}>
            <Layers />
            Deployments
          </Button>
        </>
      }
      footer={
        firing > 0 || current.status !== 'active' ? (
          <>
            {firing > 0 && (
              <Link
                to="/apps/$app/alerts"
                params={{ app }}
                className="inline-flex items-center gap-2 rounded-sm text-bad outline-hidden hover:underline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-solid"
              >
                <Bell className="size-3.5" />
                {firing === 1 ? '1 alert firing' : `${firing} alerts firing`}
              </Link>
            )}
            {current.status !== 'active' && <span>The stage is {current.status}.</span>}
          </>
        ) : undefined
      }
    >
      {live ? (
        <div className="grid grid-cols-1 gap-x-10 gap-y-5 sm:grid-cols-2 lg:grid-cols-[repeat(3,minmax(0,1fr))]">
          <Detail label="Deployment">
            <Link
              to="/apps/$app/deployments/$deployment"
              params={{ app, deployment: live.id }}
              className="inline-flex items-center gap-2 rounded-sm outline-hidden hover:underline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-solid"
            >
              <Mono>{shortId(live.id)}</Mono>
              <Badge variant="info">Current</Badge>
            </Link>
          </Detail>
          <Detail label="Status">
            <DeploymentState d={live} />
          </Detail>
          <Detail label="Domain">
            <a
              href={visit.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex max-w-full items-center gap-1 rounded-sm outline-hidden hover:underline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-solid"
            >
              <span className="truncate">{visit.host}</span>
              <ArrowUpRight className="size-3.5 shrink-0 text-subtle" />
            </a>
          </Detail>
          <Detail label="Source" className="sm:col-span-2">
            <DeploymentSource d={live} repo={summary?.app.repo} />
          </Detail>
          <Detail label="Created">
            {relTime(live.finishedAt ?? live.createdAt)}{' '}
            <span className="font-normal text-muted-foreground">by {actorLabel(live.actor)}</span>
          </Detail>
          <Detail label="Compute">{current.compute ? COMPUTE_LABEL[current.compute] : '–'}</Detail>
        </div>
      ) : (
        <EmptyState icon={<Rocket />} title={`Nothing is live on ${stage} yet`} className="py-6">
          Run <Mono>plat deploy{stage === 'prod' ? '' : ` --stage ${stage}`}</Mono>, or push to the
          repository.
        </EmptyState>
      )}
    </Panel>
  );
}

function Figures({
  app,
  stage,
  time,
  cost,
}: {
  app: string;
  stage: string;
  time: TimeSearch;
  cost: number | undefined;
}) {
  const { window } = useTime();
  const res = viewResolution(time, window.to);
  const previous = previousWindow(time, window.to, res);
  const key = { app, stage, time, previous, res };
  const atom = figuresAtom(key);
  useAutoRefresh(atom, time.from === undefined);
  const result = useSticky(useAtomValue(atom));
  const uptime = Option.getOrUndefined(AsyncResult.value(useAtomValue(uptimeAtom({ app, stage, time }))));
  const up = uptime?.length ? uptime.filter((u) => u.ok).length / uptime.length : null;
  const fromTraffic = uptime?.filter((u) => u.source === 'traffic').length ?? 0;
  return (
    <Loaded result={result} loading={<div className="h-[106px] rounded-xl border" />}>
      {([status, hist, prevStatus, prevHist]) => {
        const nowF = figures(status, hist);
        const before = figures(prevStatus, prevHist);
        const rate = nowF.requests ? nowF.errors / nowF.requests : null;
        const prevRate = before.requests ? before.errors / before.requests : null;
        return (
          <Stats>
            <Stat
              label="Requests"
              value={fmtNum(nowF.requests)}
              trend={<Sparkline values={nowF.traffic} width={80} height={28} />}
              note={<Delta now={nowF.requests} before={before.requests} better="none" />}
            />
            <Stat
              label="5xx rate"
              value={rate === null ? '–' : fmtPct(rate, 2)}
              tone={rate !== null && rate > 0.01 ? 'bad' : undefined}
              note={<Delta now={rate} before={prevRate} better="down" />}
            />
            <Stat
              label="p95 latency"
              value={fmtMs(nowF.p95)}
              note={<Delta now={nowF.p95} before={before.p95} better="down" />}
            />
            <Stat
              label="Uptime"
              value={up === null ? '–' : fmtPct(up, up === 1 ? 0 : 2)}
              tone={up !== null && up < 0.999 ? 'warn' : undefined}
              note={
                stage !== 'prod'
                  ? 'prod stages only'
                  : uptime?.length
                    ? `${fmtNum(uptime.length)} windows, ${fromTraffic === uptime.length ? 'all' : fmtNum(fromTraffic)} from traffic`
                    : 'no results in this range'
              }
            />
            <Stat label="Cost, month to date" value={fmtUsd(cost)} note="tagged to this app" />
          </Stats>
        );
      }}
    </Loaded>
  );
}

function TopRoutes({ app, stage, time }: { app: string; stage: string; time: TimeSearch }) {
  const routes = useAtomValue(routesAtom({ app, stage, time }));
  const res = viewResolution(time);
  const trend = Option.getOrUndefined(
    AsyncResult.value(useAtomValue(seriesAtom({ app, stage, time, res, query: ROUTES_QUERY }))),
  );
  const trendOf = (route: string) => trend?.series.find((s) => s.key === route)?.values ?? [];
  return (
    <Panel
      flush
      title="Busiest routes"
      actions={
        <Button
          variant="ghost"
          size="sm"
          render={
            <Link
              to="/apps/$app/metrics"
              params={{ app }}
              search={(prev) => ({
                ...prev,
                view: {
                  kind: 'metrics',
                  queries: [{ id: 'a', metric: 'latency', stat: 'p95', groupBy: 'route' }],
                  chart: 'line',
                  scale: 'log',
                } satisfies MetricsView,
              })}
            />
          }
        >
          Latency by route
        </Button>
      }
    >
      <Loaded result={routes} loading={<div className="h-48" />}>
        {(list) =>
          list.length === 0 ? (
            <EmptyState title="No requests in this range" />
          ) : (
            <table className="w-full table-fixed text-sm">
              <thead className="text-xs text-muted-foreground">
                <tr className="border-b">
                  <th className="h-9 pl-4 text-left font-medium">Route</th>
                  <th className="w-24 px-3 text-right font-medium">Requests</th>
                  <th className="w-20 px-3 text-right font-medium">5xx</th>
                  <th className="w-20 px-3 text-right font-medium">p95</th>
                  <th className="w-32 pr-4 pl-3 text-left font-medium">Trend</th>
                </tr>
              </thead>
              <tbody>
                {list
                  .toSorted((a, b) => b.req - a.req)
                  .slice(0, 8)
                  .map((r) => {
                    const route = `${r.method} ${r.route}`;
                    const rate = r.req ? r.s5xx / r.req : 0;
                    return (
                      <tr key={route} className="border-b last:border-0">
                        <td className="py-2 pl-4">
                          <RouteLabel route={route} className="max-w-full" />
                        </td>
                        <td className="px-3 text-right tabular">{fmtNum(r.req)}</td>
                        <td className={`px-3 text-right tabular ${rate > 0.01 ? 'text-bad' : ''}`}>
                          {r.s5xx ? fmtPct(rate, 2) : '0%'}
                        </td>
                        <td className={`px-3 text-right tabular ${(r.p95 ?? 0) >= 1000 ? 'text-warn' : ''}`}>
                          {fmtMs(r.p95)}
                        </td>
                        <td className="pr-4 pl-3">
                          <Sparkline values={trendOf(route)} width={84} height={20} />
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          )
        }
      </Loaded>
    </Panel>
  );
}

interface ActivityItem {
  readonly key: string;
  readonly at: number;
  readonly icon: ReactNode;
  readonly title: ReactNode;
  readonly detail?: string | undefined;
}

function Activity({ app, stage, time }: { app: string; stage: string; time: TimeSearch }) {
  const deployments = Option.getOrElse(
    AsyncResult.value(useAtomValue(deploymentsAtom({ app, stage }))),
    () => [],
  );
  const errors = Option.getOrElse(
    AsyncResult.value(useAtomValue(openErrorsAtom({ app, stage }))),
    (): readonly ErrorGroup[] => [],
  );
  const rules = Option.getOrElse(AsyncResult.value(useAtomValue(alertRulesAtom({ app, stage }))), () => []);
  // Values in the rule's own unit (ms, %, …); a deleted rule's events read as plain numbers.
  const formatOf = (id: string) => {
    const rule = rules.find((r) => r.id === id);
    return rule ? formatterFor(seriesUnit(rule.query)) : fmtNum;
  };
  const alerts =
    Option.getOrUndefined(AsyncResult.value(useAtomValue(alertHistoryAtom({ app, stage, time }))))?.events ??
    [];
  const items: ActivityItem[] = [
    ...deployments.slice(0, 6).map((d) => ({
      key: `deploy:${d.id}`,
      at: Date.parse(d.finishedAt ?? d.createdAt),
      icon: <Layers className={d.status === 'failed' ? 'text-bad' : 'text-muted-foreground'} />,
      title: (
        <>
          {d.status === 'failed'
            ? 'Failed to deploy'
            : d.computeSwitchOf
              ? 'Switched compute of'
              : 'Deployed'}{' '}
          <Mono>{d.commit?.slice(0, 7) ?? shortId(d.id)}</Mono>
        </>
      ),
      detail: [d.message?.split('\n')[0], d.actor.replace(/^ci:/, 'CI ')].filter(Boolean).join(' · '),
    })),
    ...errors.slice(0, 4).map((g) => ({
      key: `error:${g.fingerprint}`,
      at: Date.parse(g.lastSeen),
      icon: <TriangleAlert className="text-bad" />,
      title: (
        <>
          {g.name} <span className="text-muted-foreground">· {fmtNum(g.count)} events</span>
        </>
      ),
      detail: g.message,
    })),
    ...alerts.slice(0, 6).map((e) => ({
      key: `alert:${e.rule}:${e.ts}`,
      at: Date.parse(e.ts),
      icon: e.to === 'alarm' ? <Bell className="text-bad" /> : <CircleCheck className="text-ok" />,
      title: (
        <>
          {e.name} {e.to === 'alarm' ? 'fired' : e.to === 'ok' ? 'recovered' : 'has no data'}
        </>
      ),
      detail:
        e.value === null
          ? undefined
          : `${formatOf(e.rule)(e.value)} against ${formatOf(e.rule)(e.threshold)}`,
    })),
  ]
    .filter((i) => Number.isFinite(i.at))
    .toSorted((a, b) => b.at - a.at)
    .slice(0, 8);
  return (
    <Panel flush title="Activity">
      {items.length === 0 ? (
        <EmptyState title="Nothing happened lately" />
      ) : (
        <ul>
          {items.map((i) => (
            <li
              key={i.key}
              className="grid grid-cols-[20px_1fr_auto] gap-x-3 border-b px-4 py-2.5 last:border-0"
            >
              <span className="mt-0.5 [&_svg]:size-4">{i.icon}</span>
              <span className="min-w-0 truncate text-sm">{i.title}</span>
              <span className="text-xs text-muted-foreground tabular">
                {relTime(new Date(i.at).toISOString())}
              </span>
              {i.detail && (
                <span className="col-start-2 truncate text-xs text-muted-foreground">{i.detail}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
