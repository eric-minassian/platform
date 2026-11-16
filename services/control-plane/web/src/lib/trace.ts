/**
 * A trace's events as a waterfall: each span under the request, job or span
 * that made it (`parent` → `span`), in start order, on one timeline.
 * Events log at their end, so an event starts at `ts - dur` unless a span
 * says where it started (`start`, relative to the trace root).
 */
import type { TelemetryEvent } from '@ericminassian/platform-core';

export type TraceRowKind = 'req' | 'job' | 'span' | 'log' | 'err' | 'other';

export interface TraceRow {
  readonly key: string;
  readonly event: TelemetryEvent;
  readonly kind: TraceRowKind;
  readonly label: string;
  /** What kind of call: `GET`, `db.query`, `fetch`, `queue`… */
  readonly op: string;
  readonly depth: number;
  /** Milliseconds from the trace's start. */
  readonly start: number;
  readonly dur: number;
  readonly failed: boolean;
  /** Calls made but not written (the request or job kept no spans). */
  readonly unrecorded?: { readonly calls: number; readonly ms: number } | undefined;
}

export interface TraceLayout {
  readonly rows: readonly TraceRow[];
  /** Epoch ms of the earliest start. */
  readonly t0: number;
  /** Milliseconds from the earliest start to the latest end. */
  readonly total: number;
}

const durOf = (e: TelemetryEvent): number => ('dur' in e && typeof e.dur === 'number' ? e.dur : 0);

function describe(e: TelemetryEvent): { kind: TraceRowKind; op: string; label: string; failed: boolean } {
  let row: { kind: TraceRowKind; op: string; label: string; failed: boolean };
  switch (e.t) {
    case 'req':
      row = { kind: 'req', op: e.method, label: `${e.route} → ${e.status}`, failed: e.status >= 500 };
      break;
    case 'job':
      row = {
        kind: 'job',
        op: e.kind,
        label: `${e.name}${e.attempt ? ` (attempt ${e.attempt})` : ''}`,
        failed: e.status === 'error',
      };
      break;
    case 'span':
      row = { kind: 'span', op: e.op, label: e.name ?? '', failed: e.status === 'error' };
      break;
    case 'err':
      row = { kind: 'err', op: e.name, label: e.message, failed: true };
      break;
    case 'log':
      row = { kind: 'log', op: e.level, label: e.msg, failed: e.level === 'error' };
      break;
    case 'metric':
    case 'limit':
    case 'env':
      row = { kind: 'other', op: e.t, label: '', failed: false };
      break;
  }
  return row;
}

export function layoutTrace(events: readonly TelemetryEvent[]): TraceLayout {
  if (events.length === 0) return { rows: [], t0: 0, total: 0 };
  const starts = events.map((e) => e.ts - durOf(e));
  const t0 = Math.min(...starts);
  const startOf = (e: TelemetryEvent, i: number) =>
    e.t === 'span' && typeof e.start === 'number' ? e.start : starts[i]! - t0;

  // Children by the span id they hang from; roots have no parent or an unknown one.
  const ids = new Set(events.flatMap((e) => (e.span ? [e.span] : [])));
  const children = new Map<string, number[]>();
  const roots: number[] = [];
  events.forEach((e, i) => {
    if (e.parent && ids.has(e.parent) && e.parent !== e.span) {
      children.set(e.parent, [...(children.get(e.parent) ?? []), i]);
    } else roots.push(i);
  });
  const byStart = (a: number, b: number) => startOf(events[a]!, a) - startOf(events[b]!, b);

  const rows: TraceRow[] = [];
  const visit = (i: number, depth: number, seen: Set<number>) => {
    if (seen.has(i)) return;
    seen.add(i);
    const e = events[i]!;
    const d = describe(e);
    const unwritten =
      (e.t === 'req' || e.t === 'job') && e.calls ? { calls: e.calls, ms: e.callMs ?? 0 } : undefined;
    rows.push({
      key: `${i}`,
      event: e,
      ...d,
      depth,
      start: startOf(e, i),
      dur: durOf(e),
      ...(unwritten ? { unrecorded: unwritten } : {}),
    });
    for (const c of (e.span ? children.get(e.span) : undefined)?.toSorted(byStart) ?? [])
      visit(c, depth + 1, seen);
  };
  const seen = new Set<number>();
  // Requests and jobs first among roots at the same moment, so the trace reads from its entry point.
  const rank = (i: number) => (events[i]!.t === 'req' || events[i]!.t === 'job' ? 0 : 1);
  for (const r of roots.toSorted((a, b) => byStart(a, b) || rank(a) - rank(b))) visit(r, 0, seen);

  const total = Math.max(1, ...rows.map((r) => r.start + r.dur));
  return { rows, t0, total };
}
