/**
 * Draws an explorer view (`MetricsView`): its queries' series and its
 * expressions, as lines, stacked areas or bars, or a latency heatmap, and
 * the same lines summed up in a table. The Overview, the Metrics explorer
 * and alert previews all draw through it, so a chart means the same thing
 * everywhere.
 *
 * Series of different units never share an axis: each unit gets its own
 * chart, stacked one under another.
 */
import { useAtomValue } from '@effect/atom-react';
import type {
  MetricsView,
  NamedSeriesQuery,
  QueryResolution,
  SeriesResponse,
} from '@ericminassian/platform-core';
import { AsyncResult, Atom } from 'effect/reactivity';
import { type ReactNode, useMemo } from 'react';
import { family, seriesAtom } from '../../data/atoms.ts';
import { useAutoRefresh } from '../../lib/hooks.ts';
import { formatterFor, isAdditive, type ResolvedLine, summarize, unitLabel } from '../../lib/series.ts';
import type { TimeSearch } from '../../lib/time.ts';
import { cn } from '../../lib/utils.ts';
import { plainQuery, type ResolvedView, resolveView, viewResolution } from '../../lib/view.ts';
import { LatencyHeatmap } from '../charts/heatmap.tsx';
import { type ChartSeries, TimeChart } from '../charts/time-chart.tsx';
import { columns, DataTable } from '../data-table.tsx';
import { EmptyState, ErrorNotice, Loading } from '../page.tsx';

interface ViewKey {
  readonly app: string;
  readonly stage: string;
  readonly time: TimeSearch;
  readonly res: QueryResolution;
  readonly queries: readonly NamedSeriesQuery[];
}

/** Every query of a view, answered together (the first failure fails the view). */
const viewAtom = family((k: ViewKey) =>
  Atom.make((get) =>
    AsyncResult.all(
      k.queries.map((q) =>
        get(
          seriesAtom({
            app: k.app,
            stage: q.stage ?? k.stage,
            time: k.time,
            res: k.res,
            query: plainQuery(q),
          }),
        ),
      ),
    ),
  ),
);

/** A view's answers, with its loading and error states. */
function ViewResult({
  view,
  app,
  stage,
  time,
  res: fixedRes,
  className,
  loading,
  children,
}: {
  view: MetricsView;
  app: string;
  stage: string;
  time: TimeSearch;
  res: QueryResolution | undefined;
  className?: string | undefined;
  loading?: ReactNode;
  children: (responses: readonly SeriesResponse[]) => ReactNode;
}) {
  const res = fixedRes ?? viewResolution(time);
  const atom = viewAtom({ app, stage, time, res, queries: view.queries });
  useAutoRefresh(atom, time.from === undefined);
  const result = useAtomValue(atom);
  return AsyncResult.match(result, {
    onInitial: () => loading ?? <Loading className={className} />,
    onFailure: ({ cause }) => <ErrorNotice error={cause} className={className} />,
    onSuccess: ({ value, waiting }) => (
      <div className={cn('min-w-0 transition-opacity', waiting && 'opacity-70', className)}>
        {children(value)}
      </div>
    ),
  });
}

export function MetricView({
  view,
  app,
  stage,
  time,
  height = 200,
  legend = true,
  className,
  res,
}: {
  view: MetricsView;
  app: string;
  stage: string;
  time: TimeSearch;
  height?: number;
  legend?: boolean;
  className?: string;
  /** Buckets of this size instead of the window's default (an alert rule's window). */
  res?: QueryResolution | undefined;
}) {
  return (
    <ViewResult
      view={view}
      app={app}
      stage={stage}
      time={time}
      res={res}
      className={className}
      loading={
        <div style={{ height }} className={className}>
          <Loading className="h-full" />
        </div>
      }
    >
      {(responses) => <ViewBody view={view} responses={responses} height={height} legend={legend} />}
    </ViewResult>
  );
}

function Notes({ resolved }: { resolved: ResolvedView }) {
  return (
    <>
      {resolved.errors.map((e) => (
        <ErrorNotice key={e} error={e} />
      ))}
      {resolved.notes.length > 0 && (
        <p className="text-xs text-muted-foreground">{resolved.notes.join(' ')}</p>
      )}
    </>
  );
}

function ViewBody({
  view,
  responses,
  height,
  legend,
}: {
  view: MetricsView;
  responses: readonly SeriesResponse[];
  height: number;
  legend: boolean;
}) {
  const resolved = useMemo(() => resolveView(view, responses), [view, responses]);

  if (view.chart === 'heatmap') {
    if (!resolved.histogram?.response.histogram) {
      return (
        <EmptyState title="Nothing to draw as a heatmap">
          A heatmap shows a latency or job duration query with the histogram statistic.
        </EmptyState>
      );
    }
    return (
      <div className="flex flex-col gap-2">
        <Notes resolved={resolved} />
        <LatencyHeatmap
          timestamps={resolved.timestamps}
          stepMs={resolved.stepMs}
          histogram={resolved.histogram.response.histogram}
          height={height}
          ariaLabel="Latency distribution"
        />
      </div>
    );
  }

  if (resolved.lines.length === 0) {
    return (
      <div className="flex flex-col gap-2">
        <Notes resolved={resolved} />
        <EmptyState title="No data in this range" />
      </div>
    );
  }

  // One chart per unit: different units never share an axis.
  const units = [...new Set(resolved.lines.map((l) => l.unit))];
  const kind = view.chart;
  const each = units.length > 1 ? Math.max(120, Math.round(height / units.length)) : height;
  return (
    <div className="flex flex-col gap-3">
      <Notes resolved={resolved} />
      {legend && resolved.lines.length > 1 && <Legend lines={resolved.lines} kind={kind} />}
      {units.map((unit, i) => {
        const lines = resolved.lines.filter((l) => l.unit === unit);
        const series: ChartSeries[] = lines.map((l) => ({
          key: l.id,
          label: l.label,
          color: l.color,
          values: l.values,
        }));
        return (
          <div key={unit} className="min-w-0">
            {units.length > 1 && <p className="mb-1 text-xs text-muted-foreground">{unitLabel(unit)}</p>}
            <TimeChart
              timestamps={resolved.timestamps}
              stepMs={resolved.stepMs}
              series={series}
              kind={kind}
              format={formatterFor(unit)}
              log={view.scale === 'log'}
              height={each}
              minTop={unit === 'percent' ? 1 : undefined}
              threshold={
                i === 0 && view.threshold !== undefined
                  ? { value: view.threshold, label: 'threshold' }
                  : undefined
              }
              ariaLabel={lines.map((l) => l.label).join(', ')}
            />
          </div>
        );
      })}
    </div>
  );
}

export function Legend({ lines, kind }: { lines: readonly ResolvedLine[]; kind: 'line' | 'area' | 'bar' }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {lines.map((l) => (
        <li key={l.id} className="flex min-w-0 items-center gap-1.5">
          <span
            aria-hidden
            className={cn('shrink-0', kind === 'line' ? 'h-0.5 w-3 rounded-full' : 'size-2 rounded-[2px]')}
            style={{ background: l.color }}
          />
          <span className="max-w-72 truncate">{l.label}</span>
        </li>
      ))}
    </ul>
  );
}

interface SummaryRow {
  readonly line: ResolvedLine;
  readonly avg: number | null;
  readonly min: number | null;
  readonly max: number | null;
  readonly last: number | null;
  /** Only for counts and sums: an average's total means nothing. */
  readonly total: number | null;
}

const sum = columns<SummaryRow>();
const fmtOf = (row: SummaryRow, v: number | null) => (v === null ? '–' : formatterFor(row.line.unit)(v));
const figure = (key: 'avg' | 'min' | 'max' | 'last' | 'total', header: string) =>
  sum.accessor((r) => r[key] ?? -Infinity, {
    id: key,
    header,
    meta: { numeric: true },
    cell: ({ row }) => fmtOf(row.original, row.original[key]),
  });

const summaryColumns = sum.columns([
  sum.accessor((r) => r.line.label, {
    id: 'series',
    header: 'Series',
    cell: ({ row }) => (
      <span className="flex max-w-[32rem] min-w-0 items-center gap-2">
        <span
          aria-hidden
          className="h-0.5 w-3 shrink-0 rounded-full"
          style={{ background: row.original.line.color }}
        />
        <span className="truncate">{row.original.line.label}</span>
      </span>
    ),
  }),
  figure('avg', 'Average'),
  figure('min', 'Min'),
  figure('max', 'Max'),
  figure('last', 'Latest'),
  figure('total', 'Total'),
]);

/** Each line of a view summed up over the window: average, extremes, latest and total. */
export function MetricSummary({
  view,
  app,
  stage,
  time,
}: {
  view: MetricsView;
  app: string;
  stage: string;
  time: TimeSearch;
}) {
  return (
    <ViewResult
      view={view}
      app={app}
      stage={stage}
      time={time}
      res={undefined}
      loading={<Loading rows={3} />}
    >
      {(responses) => <SummaryTable view={view} responses={responses} />}
    </ViewResult>
  );
}

function SummaryTable({ view, responses }: { view: MetricsView; responses: readonly SeriesResponse[] }) {
  const rows = useMemo(
    () =>
      resolveView(view, responses).lines.map((line): SummaryRow => {
        const s = summarize(line.values);
        const additive = view.queries.some((q) => line.id.startsWith(`${q.id}:`) && isAdditive(q));
        return { line, avg: s.avg, min: s.min, max: s.max, last: s.last, total: additive ? s.total : null };
      }),
    [view, responses],
  );
  return (
    <DataTable
      columns={summaryColumns}
      data={rows}
      getRowId={(r) => r.line.id}
      dense
      empty={<EmptyState title="No data in this range" />}
    />
  );
}
