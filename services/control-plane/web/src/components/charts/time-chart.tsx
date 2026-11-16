/**
 * The console's time series chart (TanStack Charts): lines, stacked areas
 * or stacked bars over a time axis, with the page's shared cursor,
 * deployment markers, an optional threshold, and drag-to-zoom.
 */
import { areaY, barY, defineChart, lineY, ruleY } from '@tanstack/charts';
import { crosshair } from '@tanstack/charts/crosshair';
import { cursorHost } from '@tanstack/charts/cursor';
import { Chart } from '@tanstack/charts/react';
import { scaleLinear } from '@tanstack/charts/scales/linear';
import { tooltip } from '@tanstack/charts/tooltip';
import { scaleLog, scaleTime, scaleUtc } from 'd3-scale';
import { useMemo } from 'react';
import { axisTimeFormat, bucketFormat, timeFormat } from '../../lib/time.ts';
import { useChartGroup } from './chart-group.tsx';
import { ChartOverlay, usePlotGeometry, useZoomDrag } from './overlay.tsx';

export interface ChartSeries {
  readonly key: string;
  readonly label: string;
  readonly color: string;
  readonly values: ReadonlyArray<number | null>;
}

export type TimeChartKind = 'line' | 'area' | 'bar';

export interface TimeChartProps {
  /** Bucket starts, epoch ms, oldest first. */
  readonly timestamps: readonly number[];
  readonly stepMs: number;
  readonly series: readonly ChartSeries[];
  /** Areas and bars stack their series; lines don't. */
  readonly kind: TimeChartKind;
  /** Formats axis ticks and tooltip values. */
  readonly format: (value: number) => string;
  readonly log?: boolean;
  readonly height?: number;
  /** The y axis reaches at least this high, so a flat zero doesn't fill the chart. */
  readonly minTop?: number;
  readonly threshold?: { readonly value: number; readonly label: string } | undefined;
  readonly ariaLabel: string;
}

interface Row {
  readonly t: Date;
  readonly key: string;
  readonly label: string;
  readonly color: string;
  readonly v: number | null;
}

const NICE_STEPS = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];

/** The axis top: the next round number above the data, close enough to keep the chart's height in use. */
function niceTop(max: number): number {
  if (!(max > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(max));
  const f = max / p;
  return (NICE_STEPS.find((s) => f <= s) ?? 10) * p;
}

/** The largest value the chart draws: the tallest stack for areas and bars. */
function extent(
  series: readonly ChartSeries[],
  length: number,
  stacked: boolean,
): { min: number; max: number } {
  let max = 0;
  let min = Number.POSITIVE_INFINITY;
  for (let i = 0; i < length; i++) {
    let stack = 0;
    for (const s of series) {
      const v = s.values[i];
      if (v === null || v === undefined || !Number.isFinite(v)) continue;
      if (stacked) stack += Math.max(v, 0);
      else max = Math.max(max, v);
      if (v > 0) min = Math.min(min, v);
    }
    if (stacked) max = Math.max(max, stack);
  }
  return { min: Number.isFinite(min) ? min : 1, max };
}

export function TimeChart({
  timestamps,
  stepMs,
  series,
  kind,
  format,
  log = false,
  height = 180,
  minTop,
  threshold,
  ariaLabel,
}: TimeChartProps) {
  const group = useChartGroup();
  const [geometry, onRender] = usePlotGeometry();
  const thresholdValue = threshold?.value;
  const zoom = useZoomDrag(geometry, group.onZoom);

  const definition = useMemo(() => {
    const rows: Row[] = series.flatMap((s) =>
      timestamps.map((t, i) => {
        const v = s.values[i];
        return {
          t: new Date(t),
          key: s.key,
          label: s.label,
          color: s.color,
          v: v === undefined || v === null || !Number.isFinite(v) ? null : log ? (v > 0 ? v : null) : v,
        };
      }),
    );
    const first = timestamps[0] ?? 0;
    const last = (timestamps.at(-1) ?? first) + stepMs;
    const span = last - first;
    const stacked = kind !== 'line' && series.length > 1;
    const { min, max } = extent(series, timestamps.length, stacked);
    const top = Math.max(max, minTop ?? 0, thresholdValue !== undefined ? thresholdValue * 1.15 : 0);
    const x = (group.utc ? scaleUtc() : scaleTime()).domain([new Date(first), new Date(last)]);
    const y = log
      ? scaleLog()
          .domain([
            10 ** Math.floor(Math.log10(Math.max(min * 0.5, 1e-3))),
            10 ** Math.ceil(Math.log10(Math.max(top, 1))),
          ])
          .clamp(true)
      : scaleLinear().domain([0, niceTop(top)]);
    // A UTC day bucket starts at midnight, so its date alone names it (in local time it may not).
    const bucket =
      stepMs >= 86_400_000 && group.utc
        ? timeFormat(true, { month: 'short', day: 'numeric' })
        : bucketFormat(span, group.utc);

    const data =
      kind === 'bar'
        ? barY(rows, {
            // barY centers a bar on x: at the bucket's middle it fills the bucket, not half the one before.
            x: (d) => new Date(d.t.getTime() + stepMs / 2),
            y: 'v',
            z: 'key',
            fill: (d) => d.color,
            inset: span / stepMs > 90 ? 0.15 : 0.6,
          })
        : kind === 'area'
          ? areaY(rows, {
              x: 't',
              y: 'v',
              z: 'key',
              fill: (d) => d.color,
              fillOpacity: series.length > 1 ? 0.55 : 0.16,
              stroke: (d) => d.color,
              strokeWidth: 1.5,
            })
          : lineY(rows, { x: 't', y: 'v', z: 'key', stroke: (d) => d.color, strokeWidth: 1.75 });

    return defineChart({
      marks: [
        data,
        ...(thresholdValue !== undefined
          ? [ruleY([thresholdValue], { stroke: 'var(--bad)', strokeOpacity: 0.75, strokeDasharray: '4 3' })]
          : []),
        crosshair({ x: { stroke: 'var(--foreground)', strokeOpacity: 0.45 }, y: false }),
      ],
      scales: {
        x: {
          scale: x,
          axis: { ticks: { format: axisTimeFormat(span, group.utc) } },
        },
        y: {
          scale: y,
          grid: true,
          axis: { ticks: { format: (value: number) => format(value) } },
        },
      },
      theme: { grid: 'var(--chart-grid)', muted: 'var(--subtle)', foreground: 'var(--muted-foreground)' },
      focus: 'group-x',
      maxFocusDistance: Number.POSITIVE_INFINITY,
      ...(group.cursor
        ? {
            cursor: {
              use: cursorHost,
              controller: group.cursor,
              mode: 'focus' as const,
              match: 'x' as const,
            },
          }
        : {}),
      tooltip: {
        use: tooltip,
        content: (points) => {
          const at = points[0]?.datum.t;
          const marker = at
            ? group.markers.find((m) => m.ts >= at.getTime() && m.ts < at.getTime() + stepMs)
            : undefined;
          return {
            title: at ? bucket(at) : '',
            rows: [
              ...points.map((p) => ({
                label: p.datum.label,
                value: p.datum.v === null ? '–' : format(p.datum.v),
                color: p.datum.color,
              })),
              ...(marker ? [{ label: marker.detail, value: marker.label }] : []),
            ],
          };
        },
      },
    });
  }, [
    timestamps,
    stepMs,
    series,
    kind,
    format,
    log,
    minTop,
    thresholdValue,
    group.utc,
    group.cursor,
    group.markers,
  ]);

  return (
    <div className="relative select-none" style={{ height }} {...zoom.handlers}>
      <Chart definition={definition} height={height} ariaLabel={ariaLabel} onRender={onRender} />
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
