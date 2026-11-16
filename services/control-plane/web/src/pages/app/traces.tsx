/**
 * Requests and jobs that started traces: their durations over time and a
 * list, filtered by route, job, outcome, duration, and whether their spans
 * were kept. Failed and slow ones always keep them, so a slow outlier opens
 * into a full waterfall.
 */
import { useAtomValue } from '@effect/atom-react';
import {
  SLOW_TRACE_MS,
  TRACE_SAMPLE_RATE,
  type TraceFilters,
  type TraceSummary,
  type TracesView,
  type SavedQuery,
} from '@ericminassian/platform-core';
import { useNavigate } from '@tanstack/react-router';
import { Option } from 'effect';
import { AsyncResult } from 'effect/reactivity';
import { useMemo, useState } from 'react';
import { ApiClient, fresh, timeToLive } from '../../client.ts';
import { DurationScatter } from '../../components/charts/scatter.tsx';
import { columns, DataTable } from '../../components/data-table.tsx';
import {
  EmptyState,
  ErrorNotice,
  Mono,
  PageHeader,
  Panel,
  RouteLabel,
  StatusPill,
} from '../../components/page.tsx';
import { SavedViews } from '../../components/saved-views.tsx';
import { Segmented } from '../../components/segmented.tsx';
import { Input } from '../../components/ui/input.tsx';
import { Label } from '../../components/ui/label.tsx';
import { Switch } from '../../components/ui/switch.tsx';
import { type PickerOption, ValuePicker } from '../../components/value-picker.tsx';
import { family } from '../../data/atoms.ts';
import { fmtMs, fmtNum, shortId } from '../../format.ts';
import { useAutoRefresh, useStage, useSticky, useTime } from '../../lib/hooks.ts';
import { usePrefs } from '../../lib/prefs.tsx';
import { apiTime, timeFormat, type TimeSearch } from '../../lib/time.ts';
import { tracesRoute } from '../../router.tsx';

const tracesAtom = family(
  (k: { app: string; stage: string; time: TimeSearch; f: TraceFilters; limit: number }) =>
    fresh(
      ApiClient.query('observe', 'traces', {
        params: { app: k.app },
        query: {
          stage: k.stage,
          ...apiTime(k.time),
          ...(Object.keys(k.f).length ? { f: k.f } : {}),
          limit: k.limit,
        },
        timeToLive,
      }),
      { staleTime: '30 seconds' },
    ),
);

const optionsAtom = family((k: { app: string; stage: string; time: TimeSearch }) =>
  fresh(
    ApiClient.query('observe', 'jobs', {
      params: { app: k.app },
      query: { stage: k.stage, ...apiTime(k.time) },
      timeToLive,
    }),
  ),
);
const routesAtom = family((k: { app: string; stage: string; time: TimeSearch }) =>
  fresh(
    ApiClient.query('observe', 'routes', {
      params: { app: k.app },
      query: { stage: k.stage, ...apiTime(k.time) },
      timeToLive,
    }),
  ),
);

const col = columns<TraceSummary>();

function traceColumns(utc: boolean, longest: number) {
  const when = timeFormat(utc, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  return col.columns([
    col.accessor('ts', {
      header: 'Started',
      cell: ({ getValue }) => (
        <span className="font-mono text-[12px] text-muted-foreground">{when(getValue())}</span>
      ),
    }),
    col.accessor('name', {
      header: 'Request or job',
      cell: ({ row }) =>
        row.original.kind === 'req' ? (
          <RouteLabel route={row.original.name} />
        ) : (
          <span className="font-mono text-[12.5px]">{row.original.name}</span>
        ),
    }),
    col.accessor((t) => (t.failed ? 1 : 0), {
      id: 'outcome',
      header: 'Outcome',
      cell: ({ row }) => {
        const t = row.original;
        return (
          <StatusPill tone={t.failed ? 'bad' : 'ok'}>
            {t.status !== undefined ? t.status : t.failed ? 'failed' : 'ok'}
          </StatusPill>
        );
      },
    }),
    col.accessor('dur', {
      header: 'Duration',
      meta: { numeric: true },
      cell: ({ row }) => {
        const t = row.original;
        return (
          <span className="inline-flex items-center justify-end gap-2">
            <span
              aria-hidden
              className="h-1.5 rounded-full"
              style={{
                width: `${Math.max(2, (t.dur / longest) * 96)}px`,
                background: t.failed ? 'var(--s5xx)' : 'var(--chart-1)',
              }}
            />
            <span className="w-14 text-right">{fmtMs(t.dur)}</span>
          </span>
        );
      },
    }),
    col.accessor((t) => (t.recorded ? 1 : 0), {
      id: 'spans',
      header: 'Spans',
      cell: ({ row }) => {
        const t = row.original;
        return t.recorded ? (
          <span>kept</span>
        ) : (
          <span className="text-muted-foreground">
            {t.calls !== undefined ? `${fmtNum(t.calls)} calls, not kept` : 'not kept'}
          </span>
        );
      },
    }),
    col.accessor((t) => t.rev ?? '', {
      id: 'rev',
      header: 'Deployment',
      cell: ({ getValue }) => <Mono className="text-muted-foreground">{shortId(getValue())}</Mono>,
    }),
  ]);
}

export function TracesPage() {
  const { app } = tracesRoute.useParams();
  const search = tracesRoute.useSearch();
  const navigate = useNavigate({ from: tracesRoute.fullPath });
  const stage = useStage();
  const time = useTime();
  const { utc } = usePrefs();
  const f = search.f ?? {};
  const atom = tracesAtom({ app, stage, time: time.search, f, limit: 300 });
  useAutoRefresh(atom, time.search.from === undefined);
  const result = useSticky(useAtomValue(atom));
  const value = Option.getOrUndefined(AsyncResult.value(result));
  // The newest few hundred cover only minutes of a busy app; traces with spans spread over the whole window.
  const spreadAtom = tracesAtom({ app, stage, time: time.search, f: { ...f, recorded: true }, limit: 1000 });
  useAutoRefresh(spreadAtom, time.search.from === undefined);
  const spread = Option.getOrUndefined(AsyncResult.value(useSticky(useAtomValue(spreadAtom))));
  const [minDraft, setMinDraft] = useState(f.minMs !== undefined ? String(f.minMs) : '');

  const routeOptions: PickerOption[] = Option.getOrElse(
    AsyncResult.value(useAtomValue(routesAtom({ app, stage, time: time.search }))),
    () => [],
  )
    .toSorted((a, b) => b.req - a.req)
    .map((r) => ({ value: `${r.method} ${r.route}`, hint: r.req }));
  const jobOptions: PickerOption[] =
    Option.getOrUndefined(
      AsyncResult.value(useAtomValue(optionsAtom({ app, stage, time: time.search }))),
    )?.jobs.map((j) => ({
      value: `${j.kind}:${j.name}`,
      hint: j.ok + j.error,
    })) ?? [];

  const setFilters = (next: TraceFilters) => {
    const clean = Object.fromEntries(
      Object.entries(next).filter(([, v]) => v !== undefined && !(Array.isArray(v) && v.length === 0)),
    ) as TraceFilters;
    void navigate({
      search: (prev) => ({ ...prev, f: Object.keys(clean).length ? clean : undefined, saved: undefined }),
    });
  };
  const view: TracesView = { kind: 'traces', filters: f };
  const open = (q: SavedQuery) => {
    if (q.view.kind !== 'traces') return;
    setMinDraft(q.view.filters.minMs !== undefined ? String(q.view.filters.minMs) : '');
    void navigate({
      search: (prev) => ({
        ...prev,
        f: q.view.kind === 'traces' ? q.view.filters : undefined,
        saved: q.id,
        ...(q.range ? { range: q.range, from: undefined, to: undefined } : {}),
      }),
    });
  };

  const traces = value?.traces ?? [];
  const points = useMemo(
    () =>
      (spread?.traces ?? []).map((t) => ({
        id: t.trace,
        at: new Date(t.ts),
        ms: Math.max(t.dur, 1),
        failed: t.failed,
        label: t.name,
      })),
    [spread],
  );
  const longest = Math.max(1, ...traces.map((t) => t.dur));
  const tableColumns = useMemo(() => traceColumns(utc, longest), [utc, longest]);
  const openTrace = (trace: string) =>
    void navigate({ to: '/apps/$app/traces/$trace', params: { app, trace } });

  return (
    <>
      <PageHeader
        title="Traces"
        description={`Spans are kept for failed requests and jobs, for those taking ${SLOW_TRACE_MS / 1000}s or longer, and for 1 in ${Math.round(1 / TRACE_SAMPLE_RATE)} traces.`}
        actions={
          <SavedViews
            app={app}
            stage={stage}
            kind="traces"
            view={view}
            range={time.search.from === undefined ? (time.search.range ?? '24h') : undefined}
            currentId={search.saved}
            onOpen={open}
            onSaved={(q) => void navigate({ search: (prev) => ({ ...prev, saved: q.id }), replace: true })}
          />
        }
      />
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          label="Kind"
          value={f.kind ?? 'all'}
          onChange={(k) => setFilters({ ...f, kind: k === 'all' ? undefined : k })}
          options={[
            { value: 'all', label: 'All' },
            { value: 'req', label: 'Requests' },
            { value: 'job', label: 'Jobs' },
          ]}
        />
        {f.kind !== 'job' && (
          <ValuePicker
            label="All routes"
            options={routeOptions}
            selected={f.routes ?? []}
            onChange={(routes) => setFilters({ ...f, routes })}
            allowCustom
          />
        )}
        {f.kind !== 'req' && jobOptions.length > 0 && (
          <ValuePicker
            label="All jobs"
            options={jobOptions}
            selected={f.jobs ?? []}
            onChange={(jobs) => setFilters({ ...f, jobs })}
            allowCustom
          />
        )}
        <Segmented
          label="Outcome"
          value={f.outcome ?? 'any'}
          onChange={(o) => setFilters({ ...f, outcome: o === 'any' ? undefined : o })}
          options={[
            { value: 'any', label: 'Any outcome' },
            { value: 'error', label: 'Failed' },
            { value: 'ok', label: 'Succeeded' },
          ]}
        />
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const n = Number(minDraft);
            setFilters({ ...f, minMs: minDraft.trim() && Number.isFinite(n) && n > 0 ? n : undefined });
          }}
        >
          <Label htmlFor="traces-min" className="text-sm font-normal text-muted-foreground">
            At least
          </Label>
          <Input
            id="traces-min"
            inputMode="numeric"
            className="h-7 w-20 tabular"
            placeholder="0"
            value={minDraft}
            onChange={(e) => setMinDraft(e.target.value)}
            onBlur={(e) => e.currentTarget.form?.requestSubmit()}
          />
          <span className="text-sm text-muted-foreground">ms</span>
        </form>
        <div className="flex items-center gap-2">
          <Switch
            id="traces-recorded"
            checked={f.recorded ?? false}
            onCheckedChange={(on) => setFilters({ ...f, recorded: on || undefined })}
          />
          <Label htmlFor="traces-recorded" className="text-sm font-normal">
            Only with spans
          </Label>
        </div>
      </div>
      {result._tag === 'Failure' && <ErrorNotice error={result.cause} />}
      <Panel
        title="Duration"
        description="traces with spans (failed, slow and sampled); click one to open it, drag to zoom"
        actions={
          spread && (
            <span className="text-xs text-muted-foreground tabular">
              {fmtNum(points.length)}
              {spread.truncated ? '+' : ''} traces · {fmtNum(points.filter((p) => p.failed).length)} failed
            </span>
          )
        }
      >
        <DurationScatter
          points={points}
          from={time.window.from}
          to={time.window.to}
          onOpen={openTrace}
          ariaLabel="Trace durations over time"
        />
      </Panel>
      <Panel
        flush
        title="Newest first"
        description={
          value?.truncated
            ? 'More matched than shown; narrow the range or filters to see the rest.'
            : undefined
        }
      >
        <DataTable
          columns={tableColumns}
          data={traces}
          getRowId={(t) => t.trace}
          onRowClick={(t) => openTrace(t.trace)}
          dense
          empty={
            AsyncResult.isInitial(result) ? (
              <EmptyState title="Finding traces…" />
            ) : (
              <EmptyState title="No traces match">
                Widen the time range or loosen the filters. Requests older than the stage's log retention are
                gone.
              </EmptyState>
            )
          }
        />
      </Panel>
    </>
  );
}
