/**
 * Durations over time, one dot per trace, failed ones in the error color.
 * Slow outliers and failure clusters stand out; click a dot to open its
 * trace, drag to zoom the page's window.
 */
import { defineChart, dot } from '@tanstack/charts';
import { Chart } from '@tanstack/charts/react';
import { tooltip } from '@tanstack/charts/tooltip';
import { scaleLog, scaleTime, scaleUtc } from 'd3-scale';
import { useMemo } from 'react';
import { fmtMs } from '../../format.ts';
import { axisTimeFormat, timeFormat } from '../../lib/time.ts';
import { useChartGroup } from './chart-group.tsx';
import { ChartOverlay, usePlotGeometry, useZoomDrag } from './overlay.tsx';

export interface ScatterPoint {
  readonly id: string;
  readonly at: Date;
  readonly ms: number;
  readonly failed: boolean;
  readonly label: string;
}

export function DurationScatter({
  points,
  from,
  to,
  height = 200,
  onOpen,
  ariaLabel,
}: {
  points: readonly ScatterPoint[];
  from: number;
  to: number;
  height?: number;
  onOpen: (id: string) => void;
  ariaLabel: string;
}) {
  const group = useChartGroup();
  const [geometry, onRender] = usePlotGeometry();
  const zoom = useZoomDrag(geometry, group.onZoom);

  const definition = useMemo(() => {
    const span = to - from;
    const max = Math.max(10, ...points.map((p) => p.ms));
    const min = Math.max(1, Math.min(...points.map((p) => p.ms), max));
    const when = timeFormat(group.utc, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    // Failures last, so they draw over the successes around them.
    const ordered = points.toSorted((a, b) => Number(a.failed) - Number(b.failed));
    return defineChart({
      marks: [
        dot(ordered, {
          x: 'at',
          y: 'ms',
          r: 3,
          color: (p) => (p.failed ? 'failed' : 'ok'),
          fillOpacity: 0.75,
          key: 'id',
        }),
      ],
      scales: {
        x: {
          scale: (group.utc ? scaleUtc() : scaleTime()).domain([new Date(from), new Date(to)]),
          axis: { ticks: { format: axisTimeFormat(span, group.utc) } },
        },
        y: {
          scale: scaleLog()
            .domain([10 ** Math.floor(Math.log10(min * 0.8)), 10 ** Math.ceil(Math.log10(max * 1.1))])
            .clamp(true),
          grid: true,
          axis: { ticks: { format: (v: number) => fmtMs(v) } },
        },
      },
      color: { domain: ['ok', 'failed'], range: ['var(--chart-1)', 'var(--s5xx)'] },
      theme: { grid: 'var(--chart-grid)', muted: 'var(--subtle)', foreground: 'var(--muted-foreground)' },
      focus: 'nearest',
      tooltip: {
        use: tooltip,
        content: (focused) => {
          const p = focused[0]?.datum;
          return p
            ? {
                title: when(p.at),
                rows: [
                  { label: p.label, value: fmtMs(p.ms), color: p.failed ? 'var(--s5xx)' : 'var(--chart-1)' },
                  ...(p.failed ? [{ label: 'failed', value: 'yes' }] : []),
                ],
              }
            : { rows: [] };
        },
      },
    });
  }, [points, from, to, group.utc]);

  return (
    <div className="relative select-none" style={{ height }} {...zoom.handlers}>
      <Chart
        definition={definition}
        height={height}
        ariaLabel={ariaLabel}
        onRender={onRender}
        onSelect={(point) => {
          if (point) onOpen(point.datum.id);
        }}
      />
      {geometry && (
        <ChartOverlay
          geometry={geometry}
          markers={group.markers}
          selection={zoom.selection}
          utc={group.utc}
        />
      )}
    </div>
  );
}
