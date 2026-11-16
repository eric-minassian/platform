/**
 * The explorer: any metric the platform records for an app, filtered,
 * grouped, combined with expressions, drawn as lines, areas, bars, a
 * heatmap, numbers or a table. The whole view is the URL; saved views share
 * it with members, and the CLI line gives an agent the same query.
 */
import {
  type ChartKind,
  checkSeriesQuery,
  describeQuery,
  type MetricsView,
  type NamedSeriesQuery,
  QUERY_RESOLUTION_MS,
  type SavedQuery,
} from '@ericminassian/platform-core';
import { useNavigate } from '@tanstack/react-router';
import { BellPlus, Copy, LayoutGrid } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { AddToDashboardDialog } from '../../components/dashboards/add-to-dashboard.tsx';
import { MetricView } from '../../components/metrics/metric-view.tsx';
import { QueryEditor } from '../../components/metrics/query-editor.tsx';
import { PageHeader, Panel } from '../../components/page.tsx';
import { SavedViews, useSavedViews } from '../../components/saved-views.tsx';
import { Segmented } from '../../components/segmented.tsx';
import { Button } from '../../components/ui/button.tsx';
import { useStage, useTime } from '../../lib/hooks.ts';
import { plainQuery, viewResolution } from '../../lib/view.ts';
import { metricsRoute } from '../../router.tsx';

export const DEFAULT_VIEW: MetricsView = {
  kind: 'metrics',
  queries: [{ id: 'a', metric: 'requests', stat: 'count', groupBy: 'status' }],
  chart: 'bar',
};

const CHARTS: ReadonlyArray<{ value: ChartKind; label: string }> = [
  { value: 'line', label: 'Line' },
  { value: 'area', label: 'Area' },
  { value: 'bar', label: 'Bar' },
  { value: 'heatmap', label: 'Heatmap' },
  { value: 'number', label: 'Number' },
  { value: 'table', label: 'Table' },
];

const shellQuote = (s: string) => (/^[\w:./@%+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** The `plat metrics` command that answers the same query. */
export function cliCommand(
  app: string,
  stage: string,
  q: NamedSeriesQuery,
  range: string | undefined,
): string {
  const f = q.filter ?? {};
  const filters = [
    ...(f.routes ?? []).map((v) => `routes=${v}`),
    ...(f.status ?? []).map((v) => `status=${v}`),
    ...(f.jobs ?? []).map((v) => `jobs=${v}`),
    ...(f.names ?? []).map((v) => `names=${v}`),
    ...(f.outcome ? [`outcome=${f.outcome}`] : []),
    ...(f.measure ? [`measure=${f.measure}`] : []),
  ];
  return [
    'plat metrics',
    q.app ?? app,
    ...(stage !== 'prod' || q.stage ? ['--stage', q.stage ?? stage] : []),
    '--metric',
    q.metric,
    '--stat',
    q.stat,
    ...filters.flatMap((v) => ['--filter', shellQuote(v)]),
    ...(q.groupBy ? ['--by', q.groupBy] : []),
    ...(range ? ['--since', range] : []),
    '--json',
  ].join(' ');
}

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`Copied ${what}`);
  } catch {
    toast.error("Couldn't copy to the clipboard");
  }
}

export function MetricsPage() {
  const { app } = metricsRoute.useParams();
  const search = metricsRoute.useSearch();
  const stage = useStage();
  const time = useTime();
  const navigate = useNavigate({ from: metricsRoute.fullPath });
  const view = search.view ?? DEFAULT_VIEW;
  const current = useSavedViews(app, 'metrics').find((q) => q.id === search.saved);
  const [adding, setAdding] = useState(false);

  const setView = (next: MetricsView) =>
    void navigate({ search: (prev) => ({ ...prev, view: next }), replace: true });
  const open = (q: SavedQuery) =>
    void navigate({
      search: (prev) => ({
        ...prev,
        view: q.view.kind === 'metrics' ? q.view : DEFAULT_VIEW,
        saved: q.id,
        ...(q.range ? { range: q.range, from: undefined, to: undefined } : {}),
        ...(q.stage ? { stage: q.stage === 'prod' ? undefined : q.stage } : {}),
      }),
    });

  const first = view.queries.find((q) => !q.hidden) ?? view.queries[0]!;
  const alertable = !first.app && !first.stage && !checkSeriesQuery(plainQuery(first), { alert: true });
  const res = viewResolution(time.search, time.window.to);
  const title =
    current?.name ??
    (view.queries.length === 1 && !view.expressions?.length ? describeQuery(first) : 'Metrics');
  const cli = view.queries
    .filter((q) => !q.hidden)
    .map((q) =>
      cliCommand(app, stage, q, time.search.from === undefined ? (time.search.range ?? '24h') : undefined),
    );

  return (
    <>
      <PageHeader
        title={<span className="first-letter:uppercase">{title}</span>}
        description={
          current
            ? `Saved view, updated ${new Date(current.updatedAt).toLocaleDateString()} by ${current.createdBy}`
            : 'Explore any metric this app records.'
        }
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => void copy(cli.join('\n'), 'the CLI command')}>
              <Copy />
              Copy as CLI
            </Button>
            <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
              <LayoutGrid />
              Add to dashboard
            </Button>
            {alertable && (
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  void navigate({
                    to: '/apps/$app/alerts',
                    params: { app },
                    search: (prev) => ({ ...prev, draft: plainQuery(first) }),
                  })
                }
              >
                <BellPlus />
                Create alert
              </Button>
            )}
            <SavedViews
              app={app}
              stage={stage}
              kind="metrics"
              view={view}
              range={time.search.from === undefined ? (time.search.range ?? '24h') : undefined}
              currentId={search.saved}
              onOpen={open}
              onSaved={(q) => void navigate({ search: (prev) => ({ ...prev, saved: q.id }), replace: true })}
            />
          </>
        }
      />
      <QueryEditor view={view} app={app} stage={stage} time={time.search} onChange={setView} />
      <Panel
        title={
          <div className="flex flex-wrap items-center gap-2">
            <Segmented
              label="Chart"
              value={view.chart}
              onChange={(chart) => setView({ ...view, chart })}
              options={CHARTS}
            />
            {(view.chart === 'line' || view.chart === 'area' || view.chart === 'bar') && (
              <Segmented
                label="Scale"
                value={view.scale ?? 'linear'}
                onChange={(scale) => setView({ ...view, scale })}
                options={[
                  { value: 'linear', label: 'Linear' },
                  { value: 'log', label: 'Log' },
                ]}
              />
            )}
          </div>
        }
        actions={
          <span className="text-xs text-muted-foreground tabular">
            {bucketLabel(QUERY_RESOLUTION_MS[res])}
          </span>
        }
      >
        <MetricView view={view} app={app} stage={stage} time={time.search} height={340} />
      </Panel>
      {view.chart !== 'table' && view.chart !== 'heatmap' && (
        <Panel title="Summary" description="over the window">
          <MetricView view={{ ...view, chart: 'table' }} app={app} stage={stage} time={time.search} />
        </Panel>
      )}
      <div className="flex min-w-0 items-start gap-2 rounded-lg border bg-card px-4 py-3">
        <pre className="min-w-0 flex-1 overflow-x-auto font-mono text-[12px] leading-relaxed text-muted-foreground">
          {cli.map((line) => `$ ${line}`).join('\n')}
        </pre>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Copy the CLI command"
          onClick={() => void copy(cli.join('\n'), 'the CLI command')}
        >
          <Copy />
        </Button>
      </div>
      <AddToDashboardDialog
        open={adding}
        onOpenChange={setAdding}
        app={app}
        stage={stage}
        title={title}
        view={view}
      />
    </>
  );
}

function bucketLabel(ms: number): string {
  if (ms < 3_600_000) return `${ms / 60_000}-minute buckets`;
  if (ms < 86_400_000) return 'hourly buckets';
  return 'daily buckets';
}
