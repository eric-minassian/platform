import type { Resolution } from '@ericminassian/platform-core';
import { CliError, EXIT } from './output.ts';

const UNITS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

/** `"90s" | "15m" | "6h" | "7d" | "2w"` → milliseconds. */
export function parseDuration(input: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*([smhdw])$/.exec(input.trim());
  if (!m)
    throw new CliError(`invalid duration "${input}"`, { hint: 'use e.g. 30m, 6h, 7d', exitCode: EXIT.usage });
  return Number(m[1]) * UNITS[m[2]!]!;
}

/** Pick a rollup resolution that yields a readable number of points. */
export function resolutionFor(rangeMs: number): Resolution {
  if (rangeMs <= 6 * UNITS.h!) return '1m';
  if (rangeMs <= 14 * UNITS.d!) return '1h';
  return '1d';
}

export function sinceRange(since: string, now = Date.now()): { from: number; to: number; res: Resolution } {
  const ms = parseDuration(since);
  return { from: now - ms, to: now, res: resolutionFor(ms) };
}

export function shortTime(iso: string | number): string {
  const d = new Date(iso);
  return d
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d+Z$/, 'Z');
}
