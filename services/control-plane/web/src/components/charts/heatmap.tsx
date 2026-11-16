/**
 * Latency as a heatmap: one column per bucket, one row per histogram bin
 * (the fixed `LATENCY_BUCKETS_MS` the processor counts into), shaded by how
 * many requests landed there. Shares the page's cursor, markers and zoom.
 */
import { LATENCY_BUCKETS_MS } from '@ericminassian/platform-core';
import { defineChart, rect } from '@tanstack/charts';
import { crosshair } from '@tanstack/charts/crosshair';
import { cursorHost } from '@tanstack/charts/cursor';
import { Chart } from '@tanstack/charts/react';
import { scaleLinear } from '@tanstack/charts/scales/linear';
import { tooltip } from '@tanstack/charts/tooltip';
import { scaleSequential, scaleTime, scaleUtc } from 'd3-scale';
import { useMemo } from 'react';
import { fmtMs, fmtNum, fmtPct } from '../../format.ts';
import { axisTimeFormat, bucketFormat } from '../../lib/time.ts';
import { useChartGroup } from './chart-group.tsx';
import { ChartOverlay, usePlotGeometry, useZoomDrag } from './overlay.tsx';

/** Bin labels: each bin's upper bound, then the overflow. */
export const LATENCY_BIN_LABELS: readonly string[] = [
  ...LATENCY_BUCKETS_MS.map((ms) => `≤ ${fmtMs(ms)}`),
  `> ${fmtMs(LATENCY_BUCKETS_MS.at(-1) ?? 30_000)}`,
];

/** The validated sequential ramp, dark (few) to light (many), on the card surface. */
const RAMP: ReadonlyArray<readonly [number, readonly [number, number, number]]> = [
  [0, [21, 32, 46]],
  [0.35, [28, 79, 143]],
  [0.7, [57, 135, 229]],
  [1, [183, 211, 246]],
];

export function rampColor(t: number): string {
  const clamped = Math.min(Math.max(t, 0), 1);
  for (let i = 1; i < RAMP.length; i++) {
    const [t1, b] = RAMP[i]!;
    const [t0, a] = RAMP[i - 1]!;
    if (clamped <= t1) {
      const u = (clamped - t0) / (t1 - t0);
      return `rgb(${a.map((v, j) => Math.round(v + (b[j]! - v) * u)).join(',')})`;
    }
  }
  return 'rgb(183,211,246)';
}

interface Cell {
  /** The bucket's middle: its semantic x, which the page's shared cursor matches on. */
  readonly t: Date;
  readonly t0: Date;
  readonly t1: Date;
  /** The bin's row: bins are rows 0, 1, 2…, so the y axis stays numeric like the other time charts'. */
  readonly y: number;
  readonly y0: number;
  readonly y1: number;
  readonly bin: string;
  readonly count: number;
  /** Its share of the column's requests: where a moment's requests sit, whatever the traffic. */
  readonly share: number;
  /** The share's square root: lifts the slow tail out of the dark end of the ramp. */
  readonly shade: number;
}

export function LatencyHeatmap({
  timestamps,
  stepMs,
  histogram,
  height = 180,
  ariaLabel,
}: {
  timestamps: readonly number[];
  stepMs: number;
  /** Per timestamp, the count in each latency bin. */
  histogram: ReadonlyArray<ReadonlyArray<number>>;
  height?: number;
  ariaLabel: string;
}) {
  const group = useChartGroup();
  const [geometry, onRender] = usePlotGeometry();
  const zoom = useZoomDrag(geometry, group.onZoom);

  const definition = useMemo(() => {
    // Rows up to the slowest bin that has any requests, and at least up to 1 s.
    let topBin = LATENCY_BUCKETS_MS.indexOf(1000);
    for (const counts of histogram) counts.forEach((c, i) => c > 0 && i > topBin && (topBin = i));
    const bins = LATENCY_BIN_LABELS.slice(0, topBin + 1);
    const cells: Cell[] = [];
    histogram.forEach((counts, i) => {
      const t = timestamps[i];
      if (t === undefined) return;
      const total = counts.reduce((n, c) => n + c, 0);
      counts.slice(0, topBin + 1).forEach((count, b) => {
        if (count > 0) {
          cells.push({
            t: new Date(t + stepMs / 2),
            t0: new Date(t),
            t1: new Date(t + stepMs),
            y: b + 0.5,
            y0: b,
            y1: b + 1,
            bin: bins[b]!,
            count,
            share: count / total,
            shade: Math.sqrt(count / total),
          });
        }
      });
    });
    const first = timestamps[0] ?? 0;
    const last = (timestamps.at(-1) ?? first) + stepMs;
    const span = last - first;
    const bucket = bucketFormat(span, group.utc);
    return defineChart({
      marks: [
        rect(cells, { x: 't', x1: 't0', x2: 't1', y: 'y', y1: 'y0', y2: 'y1', color: 'shade', inset: 0 }),
        crosshair({ x: { stroke: 'var(--foreground)', strokeOpacity: 0.45 }, y: false }),
      ],
      scales: {
        x: {
          scale: (group.utc ? scaleUtc() : scaleTime()).domain([new Date(first), new Date(last)]),
          axis: { ticks: { format: axisTimeFormat(span, group.utc) } },
        },
        y: {
          scale: scaleLinear().domain([0, bins.length]),
          axis: {
            // Ticks sit on bin edges: edge b is the upper bound of bin b - 1.
            ticks: {
              values: Array.from({ length: Math.floor(bins.length / 3) + 1 }, (_, i) => i * 3).filter(
                (v) => v > 0,
              ),
              format: (edge: number) => fmtMs(LATENCY_BUCKETS_MS[edge - 1] ?? 0),
            },
          },
        },
      },
      color: { scale: () => scaleSequential(rampColor), domain: [0, 1] },
      theme: { grid: 'var(--chart-grid)', muted: 'var(--subtle)', foreground: 'var(--muted-foreground)' },
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
          const c = points[0]?.datum;
          return {
            title: c ? bucket(c.t0) : '',
            rows: c
              ? [
                  { label: `requests ${c.bin}`, value: fmtNum(c.count), color: rampColor(c.shade) },
                  { label: 'share of the bucket', value: fmtPct(c.share) },
                ]
              : [],
          };
        },
      },
    });
  }, [timestamps, stepMs, histogram, group.utc, group.cursor]);

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
