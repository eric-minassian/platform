/**
 * The console's one time model. Every page that shows data over time reads
 * the same URL state: a relative range (`?range=24h`, "the last 24 hours",
 * which moves with now) or an absolute window (`?from=&to=`, epoch ms, what
 * a zoom or a custom range sets). The API takes either form, so a relative
 * range is sent as is and the server applies its own clock.
 */
import { Schema } from 'effect';

export const DEFAULT_RANGE = '24h';

export interface TimeSearch {
  readonly range?: string | undefined;
  readonly from?: number | undefined;
  readonly to?: number | undefined;
}

export const RANGE_PATTERN = /^(\d{1,3})(m|h|d)$/;

const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

export function rangeMs(range: string): number | undefined {
  const m = RANGE_PATTERN.exec(range);
  if (!m) return undefined;
  return Number(m[1]) * UNIT_MS[m[2] as keyof typeof UNIT_MS];
}

export const RANGE_PRESETS: ReadonlyArray<{ readonly value: string; readonly label: string }> = [
  { value: '15m', label: 'Last 15 minutes' },
  { value: '1h', label: 'Last hour' },
  { value: '3h', label: 'Last 3 hours' },
  { value: '6h', label: 'Last 6 hours' },
  { value: '12h', label: 'Last 12 hours' },
  { value: '24h', label: 'Last 24 hours' },
  { value: '2d', label: 'Last 2 days' },
  { value: '7d', label: 'Last 7 days' },
  { value: '14d', label: 'Last 14 days' },
  { value: '30d', label: 'Last 30 days' },
];

const Millis = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 8.64e15 }));
const decodeMillis = Schema.decodeUnknownOption(
  Schema.Union([Millis, Schema.FiniteFromString.pipe(Schema.decodeTo(Millis))]),
);

/** Reads the time params of a URL leniently: anything unusable is dropped, never an error page. */
export function validateTimeSearch(search: Record<string, unknown>): TimeSearch {
  const from = decodeMillis(search.from);
  const to = decodeMillis(search.to);
  if (from._tag === 'Some' && to._tag === 'Some' && from.value < to.value) {
    return { from: from.value, to: to.value };
  }
  const range = typeof search.range === 'string' && rangeMs(search.range) ? search.range : undefined;
  return range ? { range } : {};
}

export interface TimeWindow {
  readonly from: number;
  readonly to: number;
  /** Set when the window moves with now. */
  readonly relative?: string;
}

export function resolveWindow(search: TimeSearch, now: number): TimeWindow {
  if (search.from !== undefined && search.to !== undefined) return { from: search.from, to: search.to };
  const range = search.range ?? DEFAULT_RANGE;
  return { from: now - (rangeMs(range) ?? 86_400_000), to: now, relative: range };
}

/** The API's `range` or `from`/`to` query params for the URL's time. */
export function apiTime(search: TimeSearch): { range?: string; from?: string; to?: string } {
  if (search.from !== undefined && search.to !== undefined) {
    return { from: String(search.from), to: String(search.to) };
  }
  return { range: search.range ?? DEFAULT_RANGE };
}

/** The search that zooms into `from`..`to` (Back returns to the previous window). */
export function zoomTo(from: number, to: number): TimeSearch {
  const a = Math.round(Math.min(from, to));
  const b = Math.round(Math.max(from, to));
  return { from: a, to: Math.max(b, a + 60_000), range: undefined };
}

/** The window twice as wide around the same center, or the relative range that covers it. */
export function zoomOut(window: TimeWindow): TimeSearch {
  const span = window.to - window.from;
  const center = (window.from + window.to) / 2;
  return zoomTo(center - span, center + span);
}

export interface TimeZoneSetting {
  readonly utc: boolean;
}

export function timeFormat(
  utc: boolean,
  options: Intl.DateTimeFormatOptions,
): (ms: number | string | Date) => string {
  const format = new Intl.DateTimeFormat(undefined, { ...options, ...(utc ? { timeZone: 'UTC' } : {}) });
  return (value) => format.format(typeof value === 'object' ? value : new Date(value));
}

/** "Last 24 hours", or the absolute window as dates and times. */
export function describeTime(search: TimeSearch, utc: boolean): string {
  if (search.from !== undefined && search.to !== undefined) {
    const sameDay = new Date(search.from).toDateString() === new Date(search.to).toDateString();
    const day = timeFormat(utc, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const time = timeFormat(utc, { hour: '2-digit', minute: '2-digit' });
    return `${day(search.from)} – ${sameDay ? time(search.to) : day(search.to)}${utc ? ' UTC' : ''}`;
  }
  const range = search.range ?? DEFAULT_RANGE;
  return RANGE_PRESETS.find((p) => p.value === range)?.label ?? `Last ${range}`;
}

/** Axis ticks: time of day within two days, dates beyond. */
export function axisTimeFormat(spanMs: number, utc: boolean): (value: Date) => string {
  return spanMs <= 2 * 86_400_000
    ? timeFormat(utc, { hour: '2-digit', minute: '2-digit' })
    : timeFormat(utc, { month: 'short', day: 'numeric' });
}

/** A bucket's label in a tooltip: its start, with the date when the range spans days. */
export function bucketFormat(spanMs: number, utc: boolean): (value: Date | number) => string {
  return spanMs <= 86_400_000
    ? timeFormat(utc, { hour: '2-digit', minute: '2-digit' })
    : timeFormat(utc, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
