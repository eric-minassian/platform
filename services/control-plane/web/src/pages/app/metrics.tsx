/**
 * The explorer: any metric the platform records for an app, filtered,
 * grouped, combined with expressions, drawn as lines, areas, bars or a
 * heatmap. The whole view is the URL, and the CLI line gives an agent the
 * same query.
 */
import {
  type ChartKind,
  checkSeriesQuery,
  describeQuery,
  type MetricsView,
  type NamedSeriesQuery,
  QUERY_RESOLUTION_MS,
} from '@ericminassian/platform-core';
import { Link, useNavigate } from '@tanstack/react-router';
import { BellPlus, Copy } from 'lucide-react';
import { MetricSummary, MetricView } from '../../components/metrics/metric-view.tsx';
import { QueryEditor } from '../../components/metrics/query-editor.tsx';
import { PageHeader, Panel } from '../../components/page.tsx';
import { Button } from '../../components/ui/button.tsx';
import { toast } from '../../components/ui/overlays.tsx';
import { Segmented } from '../../components/ui/segmented.tsx';
import { Tip } from '../../components/ui/tooltip.tsx';
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
];

const SCALES = [
  { value: 'linear', label: 'Linear' },
  { value: 'log', label: 'Log' },
] as const;

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
    ...(f.routes ?? []).map((v) => `route=${v}`),
    ...(f.status ?? []).map((v) => `status=${v}`),
    ...(f.jobs ?? []).map((v) => `job=${v}`),
    ...(f.names ?? []).map((v) => `name=${v}`),
    ...(f.outcome ? [`outcome=${f.outcome}`] : []),
    ...(f.measure ? [`measure=${f.measure}`] : []),
  ];
  return [
    'plat metrics',
    '--app',
    app,
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

function bucketLabel(ms: number): string {
  if (ms < 3_600_000) return `${ms / 60_000}-minute buckets`;
  if (ms < 86_400_000) return 'Hourly buckets';
  return 'Daily buckets';
}

export function MetricsPage() {
  const { app } = metricsRoute.useParams();
  const search = metricsRoute.useSearch();
  const stage = useStage();
  const time = useTime();
  const navigate = useNavigate({ from: metricsRoute.fullPath });
  const view: MetricsView = search.view ?? DEFAULT_VIEW;

  const setView = (next: MetricsView) =>
    void navigate({ search: (prev) => ({ ...prev, view: next }), replace: true });

  const first = view.queries.find((q) => !q.hidden) ?? view.queries[0]!;
  const alertable = !first.stage && !checkSeriesQuery(plainQuery(first), { alert: true });
  const res = viewResolution(time.search, time.window.to);
  const title = view.queries.length === 1 && !view.expressions?.length ? describeQuery(first) : 'Metrics';
  const cli = view.queries
    .filter((q) => !q.hidden)
    .map((q) =>
      cliCommand(app, stage, q, time.search.from === undefined ? (time.search.range ?? '24h') : undefined),
    );
  const scaled = view.chart !== 'heatmap';

  return (
    <>
      <PageHeader
        title={<span className="first-letter:uppercase">{title}</span>}
        description="Explore any metric this app records."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => void copy(cli.join('\n'), 'the CLI command')}>
              <Copy />
              Copy as CLI
            </Button>
            {alertable && (
              <Button
                variant="outline"
                size="sm"
                render={
                  <Link
                    to="/apps/$app/alerts"
                    params={{ app }}
                    search={(prev) => ({ ...prev, draft: plainQuery(first) })}
                  />
                }
              >
                <BellPlus />
                Create alert
              </Button>
            )}
          </>
        }
      />
      <QueryEditor view={view} app={app} stage={stage} time={time.search} onChange={setView} />
      <Panel>
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <Segmented
            label="Chart"
            value={view.chart}
            onChange={(chart) => setView({ ...view, chart })}
            options={CHARTS}
          />
          {scaled && (
            <Segmented
              label="Scale"
              value={view.scale ?? 'linear'}
              onChange={(scale) => setView({ ...view, scale })}
              options={SCALES}
            />
          )}
          <span className="ml-auto text-xs text-muted-foreground tabular">
            {bucketLabel(QUERY_RESOLUTION_MS[res])}
          </span>
        </div>
        <MetricView view={view} app={app} stage={stage} time={time.search} height={340} />
      </Panel>
      {scaled && (
        <Panel flush title="Summary" description="Each series over the window">
          <MetricSummary view={view} app={app} stage={stage} time={time.search} />
        </Panel>
      )}
      <div className="flex min-w-0 items-start gap-2 rounded-xl border bg-muted py-3 pr-3 pl-5">
        <pre className="min-w-0 flex-1 overflow-x-auto py-1 font-mono text-[12px] leading-relaxed text-muted-foreground">
          {cli.map((line) => `$ ${line}`).join('\n')}
        </pre>
        <Tip label="Copy">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Copy the CLI command"
            onClick={() => void copy(cli.join('\n'), 'the CLI command')}
          >
            <Copy />
          </Button>
        </Tip>
      </div>
    </>
  );
}
