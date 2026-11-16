/**
 * What every time chart on a page shares: one cursor (hovering one chart
 * shows the same moment on the others), the deployment markers, the time
 * zone, and what a drag across a chart does (zoom the page's window).
 */
import { type ChartCursorController, createChartCursor } from '@tanstack/charts/cursor';
import { createContext, type ReactNode, useContext, useMemo } from 'react';

export interface ChartMarker {
  /** Epoch ms. */
  readonly ts: number;
  /** Short label drawn on the chart, e.g. a commit. */
  readonly label: string;
  /** What the tooltip says about it. */
  readonly detail: string;
}

export interface ChartGroupValue {
  readonly cursor: ChartCursorController<Date, number> | undefined;
  readonly markers: readonly ChartMarker[];
  readonly utc: boolean;
  readonly onZoom: ((from: number, to: number) => void) | undefined;
}

const NO_MARKERS: readonly ChartMarker[] = [];

const Context = createContext<ChartGroupValue>({
  cursor: undefined,
  markers: NO_MARKERS,
  utc: false,
  onZoom: undefined,
});

export function ChartGroup({
  markers = NO_MARKERS,
  utc,
  onZoom,
  children,
}: {
  markers?: readonly ChartMarker[];
  utc: boolean;
  onZoom?: (from: number, to: number) => void;
  children: ReactNode;
}) {
  const cursor = useMemo(() => createChartCursor<Date, number>(), []);
  const value = useMemo(() => ({ cursor, markers, utc, onZoom }), [cursor, markers, utc, onZoom]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export const useChartGroup = (): ChartGroupValue => useContext(Context);
