/**
 * Turning series answers into what charts draw: one formatter per unit,
 * colors that follow the series (never its rank), and the figures a number
 * or table view shows.
 */
import {
  describeQuery,
  type NamedSeriesQuery,
  type SeriesQuery,
  type SeriesResponse,
} from '@ericminassian/platform-core';
import { fmtMs, fmtNum } from '../format.ts';

/** Categorical colors in their validated order (adjacent pairs stay distinguishable, also for color-blind readers). */
export const CATEGORICAL = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
  'var(--chart-6)',
  'var(--chart-7)',
  'var(--chart-8)',
] as const;

export const STATUS_COLORS: Record<string, string> = {
  '2xx': 'var(--s2xx)',
  '3xx': 'var(--s3xx)',
  '4xx': 'var(--s4xx)',
  '5xx': 'var(--s5xx)',
  ok: 'var(--chart-1)',
  allowed: 'var(--chart-1)',
  error: 'var(--s5xx)',
  denied: 'var(--s4xx)',
};

export const PERCENTILE_COLORS: Record<string, string> = {
  p50: 'var(--p50)',
  p90: 'var(--p90)',
  p95: 'var(--p95)',
  p99: 'var(--p99)',
};

const formatters = new Map<string, (value: number) => string>();

/** One formatter per unit, the same function each time (charts rebuild when it changes). */
export function formatterFor(unit: string): (value: number) => string {
  let f = formatters.get(unit);
  if (!f) {
    f = makeFormatter(unit);
    formatters.set(unit, f);
  }
  return f;
}

function makeFormatter(unit: string): (value: number) => string {
  switch (unit) {
    case 'ms':
      return fmtMs;
    case 'percent':
      return (v) => `${v >= 10 || v === 0 ? v.toFixed(0) : v >= 1 ? v.toFixed(1) : v.toFixed(2)}%`;
    case 'per_second':
      return (v) => `${v >= 100 ? fmtNum(v) : v >= 1 ? v.toFixed(1) : v.toFixed(2)}/s`;
    case 'count':
      return (v) => (Number.isInteger(v) || v >= 100 ? fmtNum(v) : v.toFixed(2));
    default:
      return (v) => `${Number.isInteger(v) || v >= 100 ? fmtNum(v) : v.toFixed(2)} ${unit}`;
  }
}

export function unitLabel(unit: string): string {
  switch (unit) {
    case 'ms':
      return 'milliseconds';
    case 'percent':
      return 'percent';
    case 'per_second':
      return 'per second';
    case 'count':
      return 'count';
    default:
      return unit;
  }
}

/** A chart line: a query's series, or an expression's. */
export interface ResolvedLine {
  /** Stable identity: `<query id>:<group key>`, or the expression id. */
  readonly id: string;
  readonly label: string;
  readonly unit: string;
  readonly color: string;
  readonly values: ReadonlyArray<number | null>;
}

/**
 * The lines of one query's answer, colored by what they are: status classes
 * and outcomes by their meaning, percentiles on the blue ramp, everything
 * else by categorical slot in the order the lines first appear.
 */
const FIXED_ORDER = ['2xx', '3xx', '4xx', '5xx', 'ok', 'allowed', 'error', 'denied'];

export function linesOf(
  query: NamedSeriesQuery,
  response: SeriesResponse,
  nextSlot: () => string,
): ResolvedLine[] {
  const base = query.label ?? describeQuery(query);
  // Status classes and outcomes keep one order, so a stack always reads bottom to top the same way.
  const ordered =
    query.groupBy === 'status' || query.groupBy === 'outcome'
      ? response.series.toSorted((a, b) => FIXED_ORDER.indexOf(a.key) - FIXED_ORDER.indexOf(b.key))
      : response.series;
  return ordered.map((s) => {
    const grouped = query.groupBy !== undefined;
    const color =
      (grouped && (query.groupBy === 'status' || query.groupBy === 'outcome')
        ? STATUS_COLORS[s.key]
        : undefined) ??
      (!grouped &&
      PERCENTILE_COLORS[query.stat] &&
      (query.metric === 'latency' || query.metric === 'job_duration')
        ? PERCENTILE_COLORS[query.stat]
        : undefined) ??
      nextSlot();
    return {
      id: `${query.id}:${s.key}`,
      label: grouped ? s.key : base,
      unit: response.unit,
      color,
      values: s.values,
    };
  });
}

/** A slot allocator for one chart: each call hands out the next categorical color. */
export function colorSlots(): () => string {
  let i = 0;
  return () => CATEGORICAL[i++ % CATEGORICAL.length]!;
}

/** Whether a statistic adds up over time (a total means something) or is a level (average it). */
export const isAdditive = (q: Pick<SeriesQuery, 'stat'>): boolean => q.stat === 'count' || q.stat === 'sum';

export interface LineSummary {
  readonly total: number | null;
  readonly avg: number | null;
  readonly min: number | null;
  readonly max: number | null;
  readonly last: number | null;
}

export function summarize(values: ReadonlyArray<number | null>): LineSummary {
  const present = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (present.length === 0) return { total: null, avg: null, min: null, max: null, last: null };
  const total = present.reduce((a, b) => a + b, 0);
  return {
    total,
    avg: total / present.length,
    min: Math.min(...present),
    max: Math.max(...present),
    last: present.at(-1) ?? null,
  };
}
