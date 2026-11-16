/**
 * Draws an explorer view (`MetricsView`): its queries' series and its
 * expressions, as lines, stacked areas or bars, a latency heatmap, big
 * numbers or a table. The Overview, the Metrics explorer, dashboard widgets
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
import { useMemo } from 'react';
import { family, seriesAtom } from '../../data/atoms.ts';
import { useAutoRefresh } from '../../lib/hooks.ts';
import { formatterFor, isAdditive, type ResolvedLine, summarize, unitLabel } from '../../lib/series.ts';
import type { TimeSearch } from '../../lib/time.ts';
import { cn } from '../../lib/utils.ts';
import { plainQuery, resolveView, viewResolution } from '../../lib/view.ts';
import { LatencyHeatmap } from '../charts/heatmap.tsx';
import { type ChartSeries, TimeChart } from '../charts/time-chart.tsx';
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
            app: q.app ?? k.app,
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

export function MetricView({
  view,
  app,
  stage,
  time,
  height = 200,
  legend = true,
  className,
  res: fixedRes,
  fit = false,
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
  /** `height` is all the room there is, legend included (a dashboard widget's body). */
  fit?: boolean;
}) {
  const res = fixedRes ?? viewResolution(time);
  const atom = viewAtom({ app, stage, time, res, queries: view.queries });
  useAutoRefresh(atom, time.from === undefined);
  const result = useAtomValue(atom);
  return AsyncResult.match(result, {
    onInitial: () => <Loading className={className} />,
    onFailure: ({ cause }) => <ErrorNotice error={cause} className={className} />,
    onSuccess: ({ value, waiting }) => (
      <div className={cn('min-w-0 transition-opacity', waiting && 'opacity-70', className)}>
        <ViewBody view={view} responses={value} height={height} legend={legend} fit={fit} />
      </div>
    ),
  });
}

function ViewBody({
  view,
  responses,
  height: room,
  legend,
  fit,
}: {
  view: MetricsView;
  responses: readonly SeriesResponse[];
  height: number;
  legend: boolean;
  fit: boolean;
}) {
  const resolved = useMemo(() => resolveView(view, responses), [view, responses]);
  const notes = (
    <>
      {resolved.errors.map((e) => (
        <ErrorNotice key={e} error={e} className="mb-2" />
      ))}
      {resolved.notes.length > 0 && (
        <p className="mb-1 text-xs text-muted-foreground">{resolved.notes.join(' ')}</p>
      )}
    </>
  );

  if (view.chart === 'heatmap') {
    if (!resolved.histogram?.response.histogram) {
      return (
        <EmptyState title="Nothing to draw as a heatmap">
          A heatmap shows a latency or job duration query with the histogram statistic.
        </EmptyState>
      );
    }
    return (
      <>
        {notes}
        <LatencyHeatmap
          timestamps={resolved.timestamps}
          stepMs={resolved.stepMs}
          histogram={resolved.histogram.response.histogram}
          height={room}
          ariaLabel="Latency distribution"
        />
      </>
    );
  }

  if (resolved.lines.length === 0) {
    return (
      <>
        {notes}
        <EmptyState title="No data in this range" />
      </>
    );
  }

  if (view.chart === 'number')
    return (
      <>
        {notes}
        <Numbers view={view} lines={resolved.lines} />
      </>
    );
  if (view.chart === 'table')
    return (
      <>
        {notes}
        <SummaryTable view={view} lines={resolved.lines} />
      </>
    );

  // One chart per unit: different units never share an axis.
  const units = [...new Set(resolved.lines.map((l) => l.unit))];
  const showLegend = legend && resolved.lines.length > 1;
  // Fitting a fixed box, the legend's rows (and a unit label per chart) come out of the charts' height.
  const legendRows = showLegend ? Math.ceil(resolved.lines.length / 4) : 0;
  const height = fit
    ? Math.max(
        80,
        room - legendRows * 20 - (showLegend ? 12 : 0) - (units.length > 1 ? units.length * 20 : 0),
      )
    : room;
  const kind = view.chart === 'area' ? 'area' : view.chart === 'bar' ? 'bar' : 'line';
  const each = units.length > 1 ? Math.max(120, Math.round(height / units.length)) : height;
  return (
    <div className="flex flex-col gap-3">
      {notes}
      {showLegend && <Legend lines={resolved.lines} kind={kind} />}
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

function headline(view: MetricsView, line: ResolvedLine): { value: number | null; how: string } {
  const s = summarize(line.values);
  const query = view.queries.find((q) => line.id.startsWith(`${q.id}:`));
  if (query && isAdditive(query)) return { value: s.total, how: 'total' };
  return { value: s.avg, how: 'average' };
}

function Numbers({ view, lines }: { view: MetricsView; lines: readonly ResolvedLine[] }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-4">
      {lines.slice(0, 12).map((l) => {
        const { value, how } = headline(view, l);
        return (
          <div key={l.id} className="min-w-0">
            <div className="truncate text-xs text-muted-foreground" title={l.label}>
              {l.label}
            </div>
            <div className="text-2xl font-semibold tracking-tight tabular">
              {value === null ? '–' : formatterFor(l.unit)(value)}
            </div>
            <div className="text-xs text-muted-foreground">{how}</div>
          </div>
        );
      })}
    </div>
  );
}

function SummaryTable({ view, lines }: { view: MetricsView; lines: readonly ResolvedLine[] }) {
  return (
    <div className="-mx-1 overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-xs text-muted-foreground">
          <tr className="border-b">
            <th className="px-1 py-2 text-left font-medium">Series</th>
            <th className="px-2 py-2 text-right font-medium">Average</th>
            <th className="px-2 py-2 text-right font-medium">Min</th>
            <th className="px-2 py-2 text-right font-medium">Max</th>
            <th className="px-2 py-2 text-right font-medium">Latest</th>
            <th className="px-2 py-2 text-right font-medium">Total</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => {
            const s = summarize(l.values);
            const f = formatterFor(l.unit);
            const fmt = (v: number | null) => (v === null ? '–' : f(v));
            const additive = view.queries.some((q) => l.id.startsWith(`${q.id}:`) && isAdditive(q));
            return (
              <tr key={l.id} className="border-b last:border-0">
                <td className="max-w-80 truncate px-1 py-2">
                  <span
                    aria-hidden
                    className="mr-2 inline-block h-0.5 w-3 rounded-full align-middle"
                    style={{ background: l.color }}
                  />
                  {l.label}
                </td>
                <td className="px-2 py-2 text-right tabular">{fmt(s.avg)}</td>
                <td className="px-2 py-2 text-right tabular">{fmt(s.min)}</td>
                <td className="px-2 py-2 text-right tabular">{fmt(s.max)}</td>
                <td className="px-2 py-2 text-right tabular">{fmt(s.last)}</td>
                <td className="px-2 py-2 text-right tabular">{additive ? fmt(s.total) : '–'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
