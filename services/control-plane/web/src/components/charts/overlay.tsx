/**
 * HTML drawn over a chart's plot: deployment markers and the drag-to-zoom
 * selection. The chart keeps its own pointer handling (hover, tooltip); the
 * drag listens beside it on the wrapper and only converts pixels to times
 * through the chart's resolved x scale.
 */
import type { ChartBounds, ResolvedScale } from '@tanstack/charts';
import { type PointerEvent, useCallback, useRef, useState } from 'react';
import { timeFormat } from '../../lib/time.ts';
import type { ChartMarker } from './chart-group.tsx';

export interface PlotGeometry {
  /** The plot area in the chart's CSS pixels. */
  readonly plot: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  /** The x domain, epoch ms. */
  readonly domain: readonly [number, number];
  readonly map: (ms: number) => number;
  readonly invert: (px: number) => number;
}

/** A chart's plot geometry, captured from each render for the overlay and the zoom drag. */
export function usePlotGeometry() {
  const [geometry, setGeometry] = useState<PlotGeometry>();
  const onRender = useCallback(
    (context: {
      readonly scene: {
        readonly chart: ChartBounds;
        readonly scales: Readonly<Record<string, ResolvedScale>>;
      };
    }) => {
      const { chart, scales } = context.scene;
      const x = scales.x;
      if (!x) return;
      const domain = [Number(x.domain[0]), Number(x.domain.at(-1))] as const;
      setGeometry((prev) =>
        prev &&
        prev.plot.x === chart.x &&
        prev.plot.y === chart.y &&
        prev.plot.width === chart.width &&
        prev.plot.height === chart.height &&
        prev.domain[0] === domain[0] &&
        prev.domain[1] === domain[1]
          ? prev
          : {
              plot: { x: chart.x, y: chart.y, width: chart.width, height: chart.height },
              domain,
              map: (ms) => x.map(new Date(ms)),
              invert: (px) => Number(x.invert?.(px) ?? Number.NaN),
            },
      );
    },
    [],
  );
  return [geometry, onRender] as const;
}

/** Pixels a pointer must travel before a press becomes a zoom drag. */
const DRAG_MIN_PX = 6;

export function useZoomDrag(
  geometry: PlotGeometry | undefined,
  onZoom: ((from: number, to: number) => void) | undefined,
) {
  const start = useRef<{ x: number; pointer: number } | null>(null);
  const [selection, setSelection] = useState<readonly [number, number] | null>(null);
  const clamp = (x: number) =>
    geometry ? Math.min(Math.max(x, geometry.plot.x), geometry.plot.x + geometry.plot.width) : x;
  const local = (e: PointerEvent<HTMLElement>) => e.clientX - e.currentTarget.getBoundingClientRect().left;

  if (!geometry || !onZoom) return { selection: null, handlers: {} };
  return {
    selection,
    handlers: {
      onPointerDown: (e: PointerEvent<HTMLElement>) => {
        if (e.button !== 0) return;
        const x = local(e);
        const y = e.clientY - e.currentTarget.getBoundingClientRect().top;
        const { plot } = geometry;
        if (x < plot.x || x > plot.x + plot.width || y < plot.y || y > plot.y + plot.height) return;
        start.current = { x, pointer: e.pointerId };
      },
      onPointerMove: (e: PointerEvent<HTMLElement>) => {
        if (!start.current || start.current.pointer !== e.pointerId) return;
        const x = clamp(local(e));
        if (Math.abs(x - start.current.x) < DRAG_MIN_PX) return;
        setSelection([Math.min(start.current.x, x), Math.max(start.current.x, x)]);
      },
      onPointerUp: (e: PointerEvent<HTMLElement>) => {
        const begin = start.current;
        start.current = null;
        setSelection(null);
        if (!begin || begin.pointer !== e.pointerId) return;
        const x = clamp(local(e));
        if (Math.abs(x - begin.x) < DRAG_MIN_PX) return;
        const a = geometry.invert(Math.min(begin.x, x));
        const b = geometry.invert(Math.max(begin.x, x));
        if (Number.isFinite(a) && Number.isFinite(b) && b > a) onZoom(a, b);
      },
      onPointerCancel: () => {
        start.current = null;
        setSelection(null);
      },
    },
  };
}

export function ChartOverlay({
  geometry,
  markers,
  selection,
  utc,
}: {
  geometry: PlotGeometry;
  markers: readonly ChartMarker[];
  selection: readonly [number, number] | null;
  utc: boolean;
}) {
  const { plot, domain } = geometry;
  const shown = markers.filter((m) => m.ts >= domain[0] && m.ts <= domain[1]);
  const label = timeFormat(utc, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  // Labels that would overlap the one before them stay unlabeled (the tooltip still names them).
  const placed: Array<{ marker: ChartMarker; x: number; showLabel: boolean }> = [];
  let lastRight = Number.NEGATIVE_INFINITY;
  for (const m of shown) {
    const x = geometry.map(m.ts);
    const width = m.label.length * 6 + 10;
    const showLabel = x + 3 > lastRight + 4 && x + 3 + width <= plot.x + plot.width;
    if (showLabel) lastRight = x + 3 + width;
    placed.push({ marker: m, x, showLabel });
  }
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      {placed.map(({ marker: m, x, showLabel }) => {
        return (
          <div key={`${m.ts}:${m.label}`} title={`${m.detail} · ${label(m.ts)}`}>
            <div
              className="absolute w-px border-l border-dashed border-muted-foreground/45"
              style={{ left: x, top: plot.y, height: plot.height }}
            />
            {showLabel && (
              <div
                className="absolute rounded-sm border border-input bg-popover px-1 font-mono text-[10px] leading-[13px] text-muted-foreground"
                style={{ left: x + 3, top: Math.max(plot.y - 1, 0) }}
              >
                {m.label}
              </div>
            )}
          </div>
        );
      })}
      {selection && (
        <div
          className="absolute border-x border-ring bg-ring/15"
          style={{ left: selection[0], width: selection[1] - selection[0], top: plot.y, height: plot.height }}
        />
      )}
    </div>
  );
}
