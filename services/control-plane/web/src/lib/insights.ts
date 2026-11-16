import type { InsightsResponse } from '@ericminassian/platform-core';
import { CATEGORICAL } from './series.ts';

export interface InsightsChart {
  readonly timestamps: number[];
  readonly stepMs: number;
  readonly series: Array<{ key: string; label: string; color: string; values: Array<number | null> }>;
}

/**
 * A `stats … by bin(…)` result as chart series: the bin column is time, the
 * first numeric column the value, any other column splits it into series.
 */
export function chartOf(r: InsightsResponse): InsightsChart | undefined {
  const binCol = r.columns.findIndex((c) => /^bin\(/i.test(c));
  if (binCol < 0 || r.rows.length === 0) return undefined;
  const valueCol = r.columns.findIndex(
    (_, i) => i !== binCol && r.rows.every((row) => row[i] === null || Number.isFinite(Number(row[i]))),
  );
  if (valueCol < 0) return undefined;
  const groupCol = r.columns.findIndex((_, i) => i !== binCol && i !== valueCol);
  const parse = (s: string | null) => Date.parse(`${(s ?? '').replace(' ', 'T')}Z`);
  const times = [
    ...new Set(r.rows.map((row) => parse(row[binCol] ?? null)).filter(Number.isFinite)),
  ].toSorted((a, b) => a - b);
  if (times.length === 0) return undefined;
  const stepMs = times.length > 1 ? Math.min(...times.slice(1).map((t, i) => t - times[i]!)) : 60_000;
  const index = new Map(times.map((t, i) => [t, i]));
  const byGroup = new Map<string, Array<number | null>>();
  for (const row of r.rows) {
    const key = groupCol >= 0 ? (row[groupCol] ?? '(none)') : r.columns[valueCol]!;
    const values = byGroup.get(key) ?? times.map(() => null);
    const i = index.get(parse(row[binCol] ?? null));
    if (i !== undefined) values[i] = Number(row[valueCol]);
    byGroup.set(key, values);
  }
  const series = [...byGroup.entries()].slice(0, CATEGORICAL.length).map(([key, values], i) => ({
    key,
    label: key,
    color: CATEGORICAL[i]!,
    values,
  }));
  return { timestamps: times, stepMs, series };
}
