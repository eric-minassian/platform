/**
 * An explorer view's pure parts: which bucket size its queries share, the
 * query the series endpoint takes, and the lines a set of answers draws
 * (queries' series and expressions evaluated per bucket).
 */
import {
  autoQueryResolution,
  type MetricsView,
  type NamedSeriesQuery,
  QUERY_RESOLUTION_MS,
  type QueryResolution,
  RESOLUTION_TTL_DAYS,
  type SeriesQuery,
  type SeriesResponse,
} from '@ericminassian/platform-core';
import { evalExpr, ExprError, exprRefs, parseExpr } from './expr.ts';
import { colorSlots, linesOf, type ResolvedLine } from './series.ts';
import { resolveWindow, type TimeSearch } from './time.ts';

const MINUTE_HORIZON_MS = RESOLUTION_TTL_DAYS['1m'] * 86_400_000;

/** The resolution every query of a view asks for, so their buckets line up for expressions. */
export function viewResolution(time: TimeSearch, now = Date.now()): QueryResolution {
  const w = resolveWindow(time, now);
  return autoQueryResolution(w.from, w.to, now, MINUTE_HORIZON_MS);
}

/** A query without the view-only fields, as the series endpoint takes it. */
export function plainQuery(q: NamedSeriesQuery): SeriesQuery {
  return {
    metric: q.metric,
    stat: q.stat,
    ...(q.filter ? { filter: q.filter } : {}),
    ...(q.groupBy ? { groupBy: q.groupBy } : {}),
    ...(q.app ? { app: q.app } : {}),
    ...(q.stage ? { stage: q.stage } : {}),
  };
}

export interface ResolvedView {
  readonly timestamps: readonly number[];
  readonly stepMs: number;
  readonly lines: readonly ResolvedLine[];
  readonly histogram?: { readonly query: NamedSeriesQuery; readonly response: SeriesResponse } | undefined;
  readonly notes: readonly string[];
  readonly errors: readonly string[];
}

/** Lines for the view's visible queries and expressions, aligned on the first answer's buckets. */
export function resolveView(view: MetricsView, responses: readonly SeriesResponse[]): ResolvedView {
  const first = responses[0];
  const timestamps = first ? first.timestamps.map((t) => Date.parse(t)) : [];
  const stepMs = first ? QUERY_RESOLUTION_MS[first.res] : 60_000;
  const nextSlot = colorSlots();
  const lines: ResolvedLine[] = [];
  const byId = new Map<string, ResolvedLine[]>();
  const notes = new Set<string>();
  const errors: string[] = [];
  let histogram: ResolvedView['histogram'];
  view.queries.forEach((q, i) => {
    const response = responses[i];
    if (!response) return;
    if (response.note) notes.add(response.note);
    if (q.stat === 'histogram' && response.histogram && !histogram) histogram = { query: q, response };
    // Answers of other lengths (another app's clock, a coarser fallback) are aligned by timestamp.
    const index = new Map(response.timestamps.map((t, j) => [Date.parse(t), j]));
    const aligned = (values: ReadonlyArray<number | null>) =>
      timestamps.map((t) => {
        const j = index.get(t);
        return j === undefined ? null : (values[j] ?? null);
      });
    const qLines = linesOf(q, response, nextSlot).map((l) => ({ ...l, values: aligned(l.values) }));
    byId.set(q.id, qLines);
    if (!q.hidden && q.stat !== 'histogram') lines.push(...qLines);
  });
  for (const e of view.expressions ?? []) {
    try {
      const expr = parseExpr(e.expr);
      const refs = [...exprRefs(expr)];
      const missing = refs.filter((r) => !byId.has(r));
      if (missing.length)
        throw new ExprError(
          `${missing.join(', ')} ${missing.length > 1 ? "aren't queries" : "isn't a query"}`,
        );
      // A grouped query stands for the sum of its groups.
      const units = new Set(refs.map((r) => byId.get(r)![0]?.unit).filter(Boolean));
      const values = timestamps.map((_, t) => {
        const scope = new Map<string, number | null>();
        for (const r of refs) {
          const parts = byId.get(r)!.map((l) => l.values[t] ?? null);
          const present = parts.filter((v): v is number => v !== null);
          scope.set(r, present.length ? present.reduce((a, b) => a + b, 0) : null);
        }
        return evalExpr(expr, scope);
      });
      if (!e.hidden) {
        lines.push({
          id: e.id,
          label: e.label ?? e.expr,
          // An expression's unit is its inputs' when they share one; a ratio of counts is a plain number.
          unit: units.size === 1 && !/[*/]/.test(e.expr) ? [...units][0]! : 'count',
          color: nextSlot(),
          values,
        });
      }
    } catch (error) {
      errors.push(`${e.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { timestamps, stepMs, lines, histogram, notes: [...notes], errors };
}
