/**
 * A time chart of an endpoint's own points (`{ ts, ...counts }` at the
 * answer's `res`), for pages whose figures and chart come from one answer:
 * email, realtime, services and the edge floor. Drawn by `TimeChart`, so it
 * shares the page's cursor, markers and zoom with every other chart.
 */
import { QUERY_RESOLUTION_MS, type QueryResolution } from '@ericminassian/platform-core';
import { useMemo } from 'react';
import { TimeChart, type TimeChartKind } from '../charts/time-chart.tsx';
import { Legend } from '../metrics/metric-view.tsx';
import { EmptyState } from '../page.tsx';

export interface PointSeries<K extends string> {
  readonly key: K;
  readonly label: string;
  readonly color: string;
}

export function PointsChart<K extends string>({
  points,
  res,
  series,
  kind,
  format,
  height = 200,
  minTop,
  ariaLabel,
  empty = 'No data in this range',
}: {
  points: ReadonlyArray<{ readonly ts: string } & Readonly<Record<K, unknown>>>;
  res: QueryResolution;
  series: readonly PointSeries<K>[];
  kind: TimeChartKind;
  format: (value: number) => string;
  height?: number;
  minTop?: number;
  ariaLabel: string;
  empty?: string;
}) {
  const timestamps = useMemo(() => points.map((p) => Date.parse(p.ts)), [points]);
  const lines = useMemo(
    () =>
      series.map((s) => ({
        key: s.key,
        id: s.key,
        label: s.label,
        color: s.color,
        unit: '',
        values: points.map((p) => {
          const v = p[s.key];
          return typeof v === 'number' && Number.isFinite(v) ? v : null;
        }),
      })),
    [points, series],
  );
  if (points.length === 0) return <EmptyState title={empty} />;
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {lines.length > 1 && <Legend lines={lines} kind={kind} />}
      <TimeChart
        timestamps={timestamps}
        stepMs={QUERY_RESOLUTION_MS[res]}
        series={lines}
        kind={kind}
        format={format}
        height={height}
        minTop={minTop}
        ariaLabel={ariaLabel}
      />
    </div>
  );
}
