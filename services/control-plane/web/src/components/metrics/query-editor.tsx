/**
 * Edits an explorer view's queries and expressions: one row per query
 * (metric, statistic, filters, grouping), then the expressions over them.
 * Every change goes straight to the view, which lives in the URL.
 */
import { useAtomValue } from '@effect/atom-react';
import {
  checkSeriesQuery,
  METRIC_GROUP_BY,
  METRIC_STATS,
  type MetricsView,
  type NamedSeriesQuery,
  REALTIME_MEASURES,
  type SeriesExpression,
  type SeriesFilter,
  type SeriesGroupBy,
  type SeriesMetric,
  type SeriesStat,
  SERVICE_MEASURES,
  STATUS_CLASSES,
} from '@ericminassian/platform-core';
import { Option } from 'effect';
import { AsyncResult, Atom } from 'effect/reactivity';
import { Eye, EyeOff, Plus, X } from 'lucide-react';
import { useState } from 'react';
import { ApiClient, fresh, timeToLive } from '../../client.ts';
import { family } from '../../data/atoms.ts';
import { parseExpr } from '../../lib/expr.ts';
import { apiTime, type TimeSearch } from '../../lib/time.ts';
import { cn } from '../../lib/utils.ts';
import { Button } from '../ui/button.tsx';
import { Input } from '../ui/input.tsx';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select.tsx';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip.tsx';
import { type PickerOption, ValuePicker } from '../value-picker.tsx';

export const METRIC_LABELS: Record<SeriesMetric, string> = {
  requests: 'Requests',
  latency: 'Latency',
  cold_starts: 'Cold starts',
  jobs: 'Job runs',
  job_duration: 'Job duration',
  custom: 'Custom metric',
  rate_limit: 'Rate limit checks',
  realtime: 'Realtime',
  service: 'Service',
};

export const STAT_LABELS: Record<SeriesStat, string> = {
  count: 'count',
  rate: 'per second',
  percent: 'percent',
  sum: 'sum',
  avg: 'average',
  max: 'max',
  p50: 'p50',
  p90: 'p90',
  p95: 'p95',
  p99: 'p99',
  histogram: 'histogram',
};

const GROUP_LABELS: Record<SeriesGroupBy, string> = {
  status: 'status class',
  route: 'route',
  job: 'job',
  outcome: 'outcome',
  name: 'name',
};

/** The next free id: a, b, c… after the view's queries and expressions. */
export function nextId(view: MetricsView, base = 'a'): string {
  const used = new Set([...view.queries.map((q) => q.id), ...(view.expressions ?? []).map((e) => e.id)]);
  if (base === 'e') {
    for (let i = 1; ; i++) if (!used.has(`e${i}`)) return `e${i}`;
  }
  for (let c = 97; c < 123; c++) {
    const id = String.fromCodePoint(c);
    if (!used.has(id)) return id;
  }
  return `q${used.size}`;
}

/** A metric's first statistic and no grouping: what switching metric starts from. */
function resetFor(q: NamedSeriesQuery, metric: SeriesMetric): NamedSeriesQuery {
  return {
    id: q.id,
    metric,
    stat: METRIC_STATS[metric][0]!,
    ...(metric === 'realtime'
      ? { filter: { measure: 'events' } }
      : metric === 'service'
        ? { filter: { measure: 'cpu' } }
        : {}),
    ...(q.hidden ? { hidden: q.hidden } : {}),
  };
}

type KnownKind = 'routes' | 'jobs' | 'custom' | 'limits' | 'services';

/** Where each metric's filter values come from. */
const KNOWN_KIND: Partial<Record<SeriesMetric, KnownKind>> = {
  requests: 'routes',
  latency: 'routes',
  cold_starts: 'routes',
  jobs: 'jobs',
  job_duration: 'jobs',
  custom: 'custom',
  rate_limit: 'limits',
  service: 'services',
};

const nothing = Atom.make(AsyncResult.initial<PickerOption[]>());

/** The values a metric's filter can pick, as the app reported them in the range. */
const knownValuesAtom = family((k: { app: string; stage: string; time: TimeSearch; kind: KnownKind }) => {
  const query = { stage: k.stage, ...apiTime(k.time) };
  const params = { app: k.app };
  const options = <A, E>(atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>, f: (a: A) => PickerOption[]) =>
    Atom.map(atom, (result) => AsyncResult.map(result, f));
  const read: Record<KnownKind, () => Atom.Atom<AsyncResult.AsyncResult<PickerOption[], unknown>>> = {
    routes: () =>
      options(fresh(ApiClient.query('observe', 'routes', { params, query, timeToLive })), (routes) =>
        routes
          .toSorted((a, b) => b.req - a.req)
          .map((r) => ({ value: `${r.method} ${r.route}`, hint: r.req })),
      ),
    jobs: () =>
      options(fresh(ApiClient.query('observe', 'jobs', { params, query, timeToLive })), (r) =>
        r.jobs.map((j) => ({ value: `${j.kind}:${j.name}`, hint: j.ok + j.error })),
      ),
    custom: () =>
      options(fresh(ApiClient.query('observe', 'customMetrics', { params, query, timeToLive })), (r) =>
        r.metrics.map((m) => ({ value: m.name, hint: m.count })),
      ),
    limits: () =>
      options(fresh(ApiClient.query('observe', 'limits', { params, query, timeToLive })), (r) =>
        r.limits.map((l) => ({ value: l.name, hint: l.allowed + l.denied })),
      ),
    services: () =>
      options(fresh(ApiClient.query('observe', 'services', { params, query, timeToLive })), (r) =>
        r.services.map((x) => ({ value: x.name })),
      ),
  };
  return read[k.kind]();
});

function useKnownValues(
  app: string,
  stage: string,
  time: TimeSearch,
  kind: KnownKind | undefined,
): PickerOption[] {
  const result = useAtomValue(kind ? knownValuesAtom({ app, stage, time, kind }) : nothing);
  return Option.getOrElse(AsyncResult.value(result), (): PickerOption[] => []);
}

export function QueryRow({
  query,
  app,
  stage,
  time,
  onChange,
  onRemove,
  removable,
  metrics = Object.keys(METRIC_LABELS) as SeriesMetric[],
  grouping = true,
  hideable = true,
}: {
  query: NamedSeriesQuery;
  app: string;
  stage: string;
  time: TimeSearch;
  onChange: (q: NamedSeriesQuery) => void;
  onRemove?: () => void;
  removable: boolean;
  /** The metrics it can pick (alert rules watch rollup metrics only). */
  metrics?: readonly SeriesMetric[];
  /** Whether it can group (alert rules watch one series). */
  grouping?: boolean;
  /** Whether it can be hidden from the chart (only a view with expressions needs that). */
  hideable?: boolean;
}) {
  const f = query.filter ?? {};
  const setFilter = (patch: Partial<SeriesFilter>) => {
    const next: Record<string, unknown> = { ...f, ...patch };
    for (const [k, v] of Object.entries(next))
      if (v === undefined || (Array.isArray(v) && v.length === 0)) delete next[k];
    const { filter: _drop, ...rest } = query;
    onChange(Object.keys(next).length ? { ...rest, filter: next } : rest);
  };
  // Only the values the current metric filters on are fetched.
  const known = useKnownValues(query.app ?? app, query.stage ?? stage, time, KNOWN_KIND[query.metric]);
  const problem = checkSeriesQuery(query, { alert: !grouping });
  const groups = METRIC_GROUP_BY[query.metric];
  const outcomes =
    query.metric === 'jobs' ? ['ok', 'error'] : query.metric === 'rate_limit' ? ['allowed', 'denied'] : [];

  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-2 border-t px-4 py-2.5 first:border-t-0',
        query.hidden && 'opacity-60',
      )}
    >
      <span className="grid size-6 shrink-0 place-items-center rounded-md border bg-secondary font-mono text-xs font-medium uppercase">
        {query.id}
      </span>
      <Select value={query.metric} onValueChange={(v) => onChange(resetFor(query, v as SeriesMetric))}>
        <SelectTrigger size="sm" aria-label="Metric" className="min-w-36">
          <SelectValue>{METRIC_LABELS[query.metric]}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {metrics.map((m) => (
            <SelectItem key={m} value={m}>
              {METRIC_LABELS[m]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={query.stat} onValueChange={(v) => onChange({ ...query, stat: v as SeriesStat })}>
        <SelectTrigger size="sm" aria-label="Statistic" className="min-w-28">
          <SelectValue>{STAT_LABELS[query.stat]}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {METRIC_STATS[query.metric].map((s) => (
            <SelectItem key={s} value={s}>
              {STAT_LABELS[s]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {(query.metric === 'requests' || query.metric === 'latency' || query.metric === 'cold_starts') && (
        <ValuePicker
          label="All routes"
          options={known}
          selected={f.routes ?? []}
          onChange={(v) => setFilter({ routes: v })}
          allowCustom
        />
      )}
      {query.metric === 'requests' && (
        <ValuePicker
          label="Any status"
          options={STATUS_CLASSES.map((s) => ({ value: s }))}
          selected={f.status ?? []}
          onChange={(v) => setFilter({ status: v as SeriesFilter['status'] })}
        />
      )}
      {(query.metric === 'jobs' || query.metric === 'job_duration') && (
        <ValuePicker
          label="All jobs"
          options={known}
          selected={f.jobs ?? []}
          onChange={(v) => setFilter({ jobs: v })}
          allowCustom
        />
      )}
      {outcomes.length > 0 && (
        <ValuePicker
          label="Any outcome"
          multiple={false}
          options={outcomes.map((o) => ({ value: o }))}
          selected={f.outcome ? [f.outcome] : []}
          onChange={(v) => setFilter({ outcome: v[0] as SeriesFilter['outcome'] })}
        />
      )}
      {query.metric === 'custom' && (
        <ValuePicker
          label="Pick a metric"
          options={known}
          selected={f.names ?? []}
          onChange={(v) => setFilter({ names: v })}
          allowCustom
        />
      )}
      {query.metric === 'rate_limit' && (
        <ValuePicker
          label="All limits"
          options={known}
          selected={f.names ?? []}
          onChange={(v) => setFilter({ names: v })}
          allowCustom
        />
      )}
      {query.metric === 'service' && (
        <ValuePicker
          label="All services"
          options={known}
          selected={f.names ?? []}
          onChange={(v) => setFilter({ names: v })}
        />
      )}
      {(query.metric === 'realtime' || query.metric === 'service') && (
        <Select value={f.measure ?? ''} onValueChange={(v) => setFilter({ measure: String(v) })}>
          <SelectTrigger size="sm" aria-label="Measure" className="min-w-28">
            <SelectValue>{f.measure}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {(query.metric === 'realtime' ? REALTIME_MEASURES : SERVICE_MEASURES).map((m) => (
              <SelectItem key={m} value={m}>
                {m}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {grouping && groups.length > 0 && (
        <Select
          value={query.groupBy ?? 'none'}
          onValueChange={(v) => {
            const { groupBy: _drop, ...rest } = query;
            onChange(v === 'none' ? rest : { ...rest, groupBy: v as SeriesGroupBy });
          }}
        >
          <SelectTrigger size="sm" aria-label="Group by" className="min-w-32">
            <SelectValue>{query.groupBy ? `by ${GROUP_LABELS[query.groupBy]}` : 'no grouping'}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">no grouping</SelectItem>
            {groups.map((g) => (
              <SelectItem key={g} value={g}>
                by {GROUP_LABELS[g]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {problem && <span className="text-xs text-warn">{problem}</span>}

      <div className="ml-auto flex items-center gap-1">
        {hideable && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={query.hidden ? `Show ${query.id}` : `Hide ${query.id}`}
                  onClick={() => onChange({ ...query, hidden: !query.hidden })}
                />
              }
            >
              {query.hidden ? <EyeOff /> : <Eye />}
            </TooltipTrigger>
            <TooltipContent>
              {query.hidden ? 'Hidden: used by expressions only' : 'Hide from the chart'}
            </TooltipContent>
          </Tooltip>
        )}
        {removable && onRemove && (
          <Button variant="ghost" size="icon-sm" aria-label={`Remove ${query.id}`} onClick={onRemove}>
            <X />
          </Button>
        )}
      </div>
    </div>
  );
}

function ExpressionRow({
  expression,
  onChange,
  onRemove,
}: {
  expression: SeriesExpression;
  onChange: (e: SeriesExpression) => void;
  onRemove: () => void;
}) {
  const [draft, setDraft] = useState(expression.expr);
  const [label, setLabel] = useState(expression.label ?? '');
  let problem: string | undefined;
  try {
    parseExpr(draft);
  } catch (error) {
    problem = error instanceof Error ? error.message : String(error);
  }
  const commit = () => {
    if (!problem && draft.trim())
      onChange({ ...expression, expr: draft.trim(), ...(label.trim() ? { label: label.trim() } : {}) });
  };
  return (
    <div className="flex flex-wrap items-center gap-2 border-t px-4 py-2.5">
      <span className="grid h-6 shrink-0 place-items-center rounded-md border border-dashed px-1.5 font-mono text-xs font-medium">
        {expression.id}
      </span>
      <Input
        aria-label={`Expression ${expression.id}`}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
        placeholder="e.g. 100 * b / a"
        className="h-7 w-64 font-mono text-[12px]"
      />
      <Input
        aria-label={`Label for ${expression.id}`}
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
        placeholder="Label"
        className="h-7 w-44"
      />
      {problem && <span className="text-xs text-warn">{problem}</span>}
      <div className="ml-auto flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={expression.hidden ? `Show ${expression.id}` : `Hide ${expression.id}`}
          onClick={() => onChange({ ...expression, hidden: !expression.hidden })}
        >
          {expression.hidden ? <EyeOff /> : <Eye />}
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label={`Remove ${expression.id}`} onClick={onRemove}>
          <X />
        </Button>
      </div>
    </div>
  );
}

export function QueryEditor({
  view,
  app,
  stage,
  time,
  onChange,
}: {
  view: MetricsView;
  app: string;
  stage: string;
  time: TimeSearch;
  onChange: (view: MetricsView) => void;
}) {
  const expressions = view.expressions ?? [];
  const setQuery = (i: number, q: NamedSeriesQuery) =>
    onChange({ ...view, queries: view.queries.map((x, j) => (j === i ? q : x)) });
  const setExpression = (i: number, e: SeriesExpression) =>
    onChange({ ...view, expressions: expressions.map((x, j) => (j === i ? e : x)) });
  return (
    <div className="rounded-lg border bg-card">
      {view.queries.map((q, i) => (
        <QueryRow
          key={q.id}
          query={q}
          app={app}
          stage={stage}
          time={time}
          removable={view.queries.length > 1}
          onChange={(next) => setQuery(i, next)}
          onRemove={() => onChange({ ...view, queries: view.queries.filter((_, j) => j !== i) })}
        />
      ))}
      {expressions.map((e, i) => (
        <ExpressionRow
          key={e.id}
          expression={e}
          onChange={(next) => setExpression(i, next)}
          onRemove={() => onChange({ ...view, expressions: expressions.filter((_, j) => j !== i) })}
        />
      ))}
      <div className="flex flex-wrap items-center gap-2 border-t px-4 py-2.5">
        <Button
          variant="outline"
          size="sm"
          disabled={view.queries.length >= 8}
          onClick={() =>
            onChange({
              ...view,
              queries: [...view.queries, { id: nextId(view), metric: 'requests', stat: 'count' }],
            })
          }
        >
          <Plus />
          Query
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={expressions.length >= 8}
          onClick={() => {
            const ids = view.queries.map((q) => q.id);
            const expr = ids.length >= 2 ? `100 * ${ids[1]} / ${ids[0]}` : `${ids[0] ?? 'a'} * 2`;
            onChange({ ...view, expressions: [...expressions, { id: nextId(view, 'e'), expr }] });
          }}
        >
          <Plus />
          Expression
        </Button>
        <span className="text-xs text-muted-foreground">
          Expressions combine queries by id per bucket; a grouped query stands for the sum of its groups.
        </span>
      </div>
    </div>
  );
}
