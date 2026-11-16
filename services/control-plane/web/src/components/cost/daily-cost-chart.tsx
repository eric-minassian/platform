/**
 * Cost per day from Cost Explorer, as bars. Its days are UTC dates, so the
 * chart reads them in UTC whatever the viewer's time zone (a day drawn in
 * local time would start the evening before), and it keeps out of the
 * page's cursor and deployment markers, which mean nothing at a day's scale.
 */
import { useMemo } from 'react';
import { fmtUsd } from '../../format.ts';
import { ChartGroup } from '../charts/chart-group.tsx';
import { TimeChart } from '../charts/time-chart.tsx';
import { Legend } from '../metrics/metric-view.tsx';
import { EmptyState } from '../page.tsx';

const DAY = 86_400_000;

export interface CostSeries {
  readonly key: string;
  readonly label: string;
  readonly color: string;
  readonly days: ReadonlyArray<{ readonly date: string; readonly usd: number }>;
}

// A bare `$0` at the axis's foot leaves room for the longer labels above it.
const format = (v: number): string => (v === 0 ? '$0' : fmtUsd(v));

export function DailyCostChart({
  series,
  height = 200,
  ariaLabel,
}: {
  series: readonly CostSeries[];
  height?: number;
  ariaLabel: string;
}) {
  const { timestamps, lines } = useMemo(() => {
    const dates = [...new Set(series.flatMap((s) => s.days.map((d) => d.date)))].toSorted();
    return {
      timestamps: dates.map((d) => Date.parse(`${d}T00:00:00Z`)),
      lines: series.map((s) => {
        const byDate = new Map(s.days.map((d) => [d.date, d.usd]));
        return {
          key: s.key,
          id: s.key,
          label: s.label,
          color: s.color,
          unit: 'usd',
          values: dates.map((d) => byDate.get(d) ?? null),
        };
      }),
    };
  }, [series]);
  if (timestamps.length === 0) return <EmptyState title="No cost recorded yet" />;
  return (
    <ChartGroup utc>
      <div className="flex min-w-0 flex-col gap-3">
        {lines.length > 1 && <Legend lines={lines} kind="bar" />}
        <TimeChart
          timestamps={timestamps}
          stepMs={DAY}
          series={lines}
          kind="bar"
          format={format}
          height={height}
          ariaLabel={ariaLabel}
        />
      </div>
    </ChartGroup>
  );
}
