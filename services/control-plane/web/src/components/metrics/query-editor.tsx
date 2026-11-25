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
import { fmtNum } from '../../format.ts';
import { parseExpr } from '../../lib/expr.ts';
import { apiTime, type TimeSearch } from '../../lib/time.ts';
import { cn } from '../../lib/utils.ts';
import { Button } from '../ui/button.tsx';
import { Input } from '../ui/input.tsx';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select.tsx';
import { Tip } from '../ui/tooltip.tsx';
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
          .map((r) => ({ value: `${r.method} ${r.route}`, hint: fmtNum(r.req) })),
      ),
    jobs: () =>
      options(fresh(ApiClient.query('observe', 'jobs', { params, query, timeToLive })), (r) =>
        r.jobs.map((j) => ({ value: `${j.kind}:${j.name}`, hint: fmtNum(j.ok + j.error) })),
      ),
    custom: () =>
      options(fresh(ApiClient.query('observe', 'customMetrics', { params, query, timeToLive })), (r) =>
        r.metrics.map((m) => ({ value: m.name, hint: fmtNum(m.count) })),
      ),
    limits: () =>
      options(fresh(ApiClient.query('observe', 'limits', { params, query, timeToLive })), (r) =>
        r.limits.map((l) => ({ value: l.name, hint: fmtNum(l.allowed + l.denied) })),
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

/** A select of a few labeled choices, sized for an editor row. */
function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
  className,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ readonly value: T; readonly label: string }>;
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <Select items={[...options]} value={value} onValueChange={(next) => next !== null && onChange(next)}>
      <SelectTrigger size="sm" aria-label={label} className={className}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** A query's or expression's id, as expressions refer to it. */
function IdChip({ id, dashed = false }: { id: string; dashed?: boolean }) {
  return (
    <span
      className={cn(
        'grid h-6 min-w-6 shrink-0 place-items-center rounded-md px-1.5 font-mono text-xs font-medium text-muted-foreground',
        dashed ? 'border border-dashed border-border-strong' : 'bg-accent',
      )}
    >
      {id}
    </span>
  );
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
  const known = useKnownValues(app, query.stage ?? stage, time, KNOWN_KIND[query.metric]);
  const problem = checkSeriesQuery(query, { alert: !grouping });
  const groups = METRIC_GROUP_BY[query.metric];
  const outcomes: ReadonlyArray<NonNullable<SeriesFilter['outcome']>> =
    query.metric === 'jobs' ? ['ok', 'error'] : query.metric === 'rate_limit' ? ['allowed', 'denied'] : [];
  const of = ` of ${query.id}`;

  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-2 border-t px-4 py-2.5 first:border-t-0',
        query.hidden && 'opacity-60',
      )}
    >
      <IdChip id={query.id} />
      <Choice
        label={`Metric${of}`}
        value={query.metric}
        options={metrics.map((m) => ({ value: m, label: METRIC_LABELS[m] }))}
        onChange={(m) => onChange(resetFor(query, m))}
        className="min-w-36"
      />
      <Choice
        label={`Statistic${of}`}
        value={query.stat}
        options={METRIC_STATS[query.metric].map((s) => ({ value: s, label: STAT_LABELS[s] }))}
        onChange={(stat) => onChange({ ...query, stat })}
        className="min-w-28"
      />

      {(query.metric === 'requests' || query.metric === 'latency' || query.metric === 'cold_starts') && (
        <ValuePicker
          label="All routes"
          name={`Routes${of}`}
          options={known}
          selected={f.routes ?? []}
          onChange={(v) => setFilter({ routes: v })}
          allowCustom
        />
      )}
      {query.metric === 'requests' && (
        <ValuePicker
          label="Any status"
          name={`Status classes${of}`}
          options={STATUS_CLASSES.map((s) => ({ value: s }))}
          selected={f.status ?? []}
          onChange={(v) => setFilter({ status: v as SeriesFilter['status'] })}
        />
      )}
      {(query.metric === 'jobs' || query.metric === 'job_duration') && (
        <ValuePicker
          label="All jobs"
          name={`Jobs${of}`}
          options={known}
          selected={f.jobs ?? []}
          onChange={(v) => setFilter({ jobs: v })}
          allowCustom
        />
      )}
      {outcomes.length > 0 && (
        <Choice
          label={`Outcome${of}`}
          value={f.outcome ?? 'any'}
          options={[{ value: 'any', label: 'any outcome' }, ...outcomes.map((o) => ({ value: o, label: o }))]}
          onChange={(o) => setFilter({ outcome: o === 'any' ? undefined : o })}
        />
      )}
      {(query.metric === 'custom' || query.metric === 'rate_limit' || query.metric === 'service') && (
        <ValuePicker
          label={
            query.metric === 'custom'
              ? 'Pick a metric'
              : query.metric === 'rate_limit'
                ? 'All limits'
                : 'All services'
          }
          name={`${query.metric === 'custom' ? 'Metrics' : query.metric === 'rate_limit' ? 'Limits' : 'Services'}${of}`}
          options={known}
          selected={f.names ?? []}
          onChange={(v) => setFilter({ names: v })}
          allowCustom={query.metric !== 'service'}
        />
      )}
      {(query.metric === 'realtime' || query.metric === 'service') && (
        <Choice
          label={`Measure${of}`}
          value={f.measure ?? ''}
          options={(query.metric === 'realtime' ? REALTIME_MEASURES : SERVICE_MEASURES).map((m) => ({
            value: m,
            label: m,
          }))}
          onChange={(measure) => setFilter({ measure })}
          className="min-w-28"
        />
      )}

      {grouping && groups.length > 0 && (
        <Choice
          label={`Group by${of}`}
          value={query.groupBy ?? 'none'}
          options={[
            { value: 'none', label: 'no grouping' },
            ...groups.map((g) => ({ value: g, label: `by ${GROUP_LABELS[g]}` })),
          ]}
          onChange={(g) => {
            const { groupBy: _drop, ...rest } = query;
            onChange(g === 'none' ? rest : { ...rest, groupBy: g });
          }}
          className="min-w-32"
        />
      )}

      {problem && <span className="text-xs text-warn">{problem}</span>}

      <div className="ml-auto flex items-center gap-0.5">
        {hideable && (
          <Tip label={query.hidden ? 'Hidden: used by expressions only' : 'Hide from the chart'}>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={query.hidden ? `Show ${query.id}` : `Hide ${query.id}`}
              aria-pressed={query.hidden ?? false}
              onClick={() => onChange({ ...query, hidden: !query.hidden })}
            >
              {query.hidden ? <EyeOff /> : <Eye />}
            </Button>
          </Tip>
        )}
        {removable && onRemove && (
          <Tip label="Remove">
            <Button variant="ghost" size="icon-sm" aria-label={`Remove ${query.id}`} onClick={onRemove}>
              <X />
            </Button>
          </Tip>
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
    if (problem || !draft.trim()) return;
    const { label: _drop, ...rest } = expression;
    onChange({ ...rest, expr: draft.trim(), ...(label.trim() ? { label: label.trim() } : {}) });
  };
  const onEnter = (e: { key: string }) => e.key === 'Enter' && commit();
  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-2 border-t px-4 py-2.5',
        expression.hidden && 'opacity-60',
      )}
    >
      <IdChip id={expression.id} dashed />
      <Input
        size="sm"
        aria-label={`Expression ${expression.id}`}
        aria-invalid={problem ? true : undefined}
        value={draft}
        onValueChange={setDraft}
        onBlur={commit}
        onKeyDown={onEnter}
        placeholder="e.g. 100 * b / a"
        className="w-64 font-mono text-[12px]"
      />
      <Input
        size="sm"
        aria-label={`Label for ${expression.id}`}
        value={label}
        onValueChange={setLabel}
        onBlur={commit}
        onKeyDown={onEnter}
        placeholder="Label"
        className="w-44"
      />
      {problem && <span className="text-xs text-warn">{problem}</span>}
      <div className="ml-auto flex items-center gap-0.5">
        <Tip label={expression.hidden ? 'Show on the chart' : 'Hide from the chart'}>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={expression.hidden ? `Show ${expression.id}` : `Hide ${expression.id}`}
            aria-pressed={expression.hidden ?? false}
            onClick={() => onChange({ ...expression, hidden: !expression.hidden })}
          >
            {expression.hidden ? <EyeOff /> : <Eye />}
          </Button>
        </Tip>
        <Tip label="Remove">
          <Button variant="ghost" size="icon-sm" aria-label={`Remove ${expression.id}`} onClick={onRemove}>
            <X />
          </Button>
        </Tip>
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
  const setQuery = (id: string, q: NamedSeriesQuery) =>
    onChange({ ...view, queries: view.queries.map((x) => (x.id === id ? q : x)) });
  const setExpression = (id: string, e: SeriesExpression) =>
    onChange({ ...view, expressions: expressions.map((x) => (x.id === id ? e : x)) });
  return (
    <section aria-label="Queries" className="rounded-xl border bg-card">
      {view.queries.map((q) => (
        <QueryRow
          key={q.id}
          query={q}
          app={app}
          stage={stage}
          time={time}
          removable={view.queries.length > 1}
          hideable={expressions.length > 0 || q.hidden === true}
          onChange={(next) => setQuery(q.id, next)}
          onRemove={() => onChange({ ...view, queries: view.queries.filter((x) => x.id !== q.id) })}
        />
      ))}
      {expressions.map((e) => (
        <ExpressionRow
          key={e.id}
          expression={e}
          onChange={(next) => setExpression(e.id, next)}
          onRemove={() => onChange({ ...view, expressions: expressions.filter((x) => x.id !== e.id) })}
        />
      ))}
      <div className="flex flex-wrap items-center gap-2 rounded-b-xl border-t bg-muted px-4 py-2.5">
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
    </section>
  );
}
