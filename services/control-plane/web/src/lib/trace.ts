/**
 * A trace's events as a tree for a waterfall: the requests and jobs that
 * started it, and every span under the request, job or span that made it
 * (`parent` → `span`), in start order, in milliseconds from the trace's start.
 * Log lines, errors and metrics are moments rather than spans: each is listed
 * with the span it happened in.
 *
 * Events log at their end, so an event starts at `ts - dur` unless a span says
 * where it started (`start`, relative to its request or job).
 */
import type { TelemetryEvent } from '@ericminassian/platform-core';

type Of<T extends TelemetryEvent['t']> = Extract<TelemetryEvent, { t: T }>;

export type SpanEventOf = Of<'req'> | Of<'job'> | Of<'span'>;
export type LineEventOf = Exclude<TelemetryEvent, SpanEventOf>;

/** One bar of the waterfall. Its first four fields are what the waterfall reads. */
export interface TraceSpan {
  /** Unique in the trace. */
  readonly value: string;
  /** `GET /api/items`, `db.query items`: what typing on the waterfall matches. */
  readonly label: string;
  readonly start: number;
  readonly duration: number;
  readonly children?: TraceSpan[];
  readonly event: SpanEventOf;
  /** What kind of call: `GET`, `queue`, `db.query`, `fetch`… */
  readonly op: string;
  /** The route, the job, or what the span touched. */
  readonly name: string;
  /** A request's status code, else `ok` or `error`. */
  readonly status: string;
  readonly failed: boolean;
  readonly depth: number;
  /** Calls made but not written (the request or job kept no spans). */
  readonly unrecorded?: { readonly calls: number; readonly ms: number } | undefined;
}

export interface TraceLine {
  readonly key: string;
  readonly event: LineEventOf;
  /** Milliseconds from the trace's start. */
  readonly at: number;
  /** The span it was written in, when the trace has one for it. */
  readonly span: string | undefined;
  /** `error`, `warn`, `info`, `debug`, `metric`, `limit` or `env`. */
  readonly level: string;
  readonly text: string;
  readonly failed: boolean;
}

export interface TraceLayout {
  /** The top-level spans, each with its children. */
  readonly spans: TraceSpan[];
  readonly byValue: ReadonlyMap<string, TraceSpan>;
  /** The request or job that started the trace (else its first span). */
  readonly root: TraceSpan | undefined;
  /** Every line, oldest first. */
  readonly lines: readonly TraceLine[];
  /** Epoch ms of the earliest start. */
  readonly t0: number;
  /** Milliseconds from the earliest start to the latest end. */
  readonly total: number;
}

const isSpan = (e: TelemetryEvent): e is SpanEventOf => e.t === 'req' || e.t === 'job' || e.t === 'span';

function describe(e: SpanEventOf): { op: string; name: string; status: string; failed: boolean } {
  if (e.t === 'req')
    return { op: e.method, name: e.route, status: String(e.status), failed: e.status >= 500 };
  if (e.t === 'job') {
    return {
      op: e.kind,
      name: `${e.name}${e.attempt ? ` (attempt ${e.attempt})` : ''}`,
      status: e.status,
      failed: e.status === 'error',
    };
  }
  return { op: e.op, name: e.name ?? '', status: e.status, failed: e.status === 'error' };
}

function line(e: LineEventOf): { level: string; text: string; failed: boolean } {
  if (e.t === 'log') return { level: e.level, text: e.msg, failed: e.level === 'error' };
  if (e.t === 'err') return { level: 'error', text: `${e.name}: ${e.message}`, failed: true };
  if (e.t === 'metric')
    return { level: 'metric', text: `${e.name} = ${e.value}${e.unit ? ` ${e.unit}` : ''}`, failed: false };
  if (e.t === 'limit')
    return { level: 'limit', text: `${e.name} ${e.ok ? 'allowed' : 'denied'}`, failed: false };
  const detail = e.initMs !== undefined ? ` (init ${e.initMs}ms)` : '';
  return { level: 'env', text: `${e.runtime} ${e.event}${detail}`, failed: false };
}

const durOf = (e: TelemetryEvent): number => ('dur' in e && typeof e.dur === 'number' ? e.dur : 0);

export function layoutTrace(events: readonly TelemetryEvent[]): TraceLayout {
  if (events.length === 0)
    return { spans: [], byValue: new Map(), root: undefined, lines: [], t0: 0, total: 0 };
  const t0 = Math.min(...events.map((e) => e.ts - durOf(e)));
  const spanEvents = events.filter(isSpan);
  const keyOf = (e: SpanEventOf) => e.span ?? `${e.t}:${e.ts}:${spanEvents.indexOf(e)}`;
  const ids = new Set(spanEvents.flatMap((e) => (e.span ? [e.span] : [])));

  // Children by the span id they hang from; roots have no parent, or one the trace doesn't hold.
  const children = new Map<string, SpanEventOf[]>();
  const roots: SpanEventOf[] = [];
  for (const e of spanEvents) {
    if (e.parent && ids.has(e.parent) && e.parent !== e.span)
      children.set(e.parent, [...(children.get(e.parent) ?? []), e]);
    else roots.push(e);
  }

  const byValue = new Map<string, TraceSpan>();
  const seen = new Set<SpanEventOf>();
  // A span's `start` counts from its request or job, which may not be the trace's first.
  const build = (e: SpanEventOf, depth: number, rootStart: number | undefined): TraceSpan => {
    seen.add(e);
    const start =
      e.t === 'span' && typeof e.start === 'number' && rootStart !== undefined
        ? rootStart + e.start
        : e.ts - durOf(e) - t0;
    const own = e.t === 'req' || e.t === 'job' ? start : rootStart;
    const kids = (e.span ? (children.get(e.span) ?? []) : [])
      .filter((c) => !seen.has(c))
      .map((c) => build(c, depth + 1, own))
      .toSorted((a, b) => a.start - b.start);
    const d = describe(e);
    const span: TraceSpan = {
      value: keyOf(e),
      label: `${d.op} ${d.name}`.trim(),
      start,
      duration: durOf(e),
      ...(kids.length ? { children: kids } : {}),
      event: e,
      ...d,
      depth,
      ...((e.t === 'req' || e.t === 'job') && e.calls
        ? { unrecorded: { calls: e.calls, ms: e.callMs ?? 0 } }
        : {}),
    };
    byValue.set(span.value, span);
    return span;
  };
  // Requests and jobs first among roots at the same moment, so the trace reads from its entry point.
  const rank = (s: TraceSpan) => (s.event.t === 'span' ? 1 : 0);
  const spans = roots
    .map((e) => build(e, 0, undefined))
    .toSorted((a, b) => a.start - b.start || rank(a) - rank(b));
  const entries = spans.filter((s) => s.event.t !== 'span');
  const root = entries[0] ?? spans[0];

  // A line without a known span happened in the request or job running at the time.
  const ownerAt = (at: number) =>
    entries.findLast((s) => s.start <= at && at <= s.start + s.duration)?.value ?? root?.value;
  const lines = events
    .filter((e): e is LineEventOf => !isSpan(e))
    .map((e, i): TraceLine => {
      const at = e.ts - t0;
      return {
        key: `${e.ts}:${i}`,
        event: e,
        at,
        span: e.parent && ids.has(e.parent) ? e.parent : ownerAt(at),
        ...line(e),
      };
    })
    .toSorted((a, b) => a.at - b.at);

  const total = Math.max(
    1,
    ...[...byValue.values()].map((s) => s.start + s.duration),
    ...lines.map((l) => l.at),
  );
  return { spans, byValue, root, lines, t0, total };
}
