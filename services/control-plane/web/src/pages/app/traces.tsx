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
} from '@ericminassian/platform-core';
import { Link, useNavigate } from '@tanstack/react-router';
import { Option } from 'effect';
import { AsyncResult } from 'effect/reactivity';
import { X } from 'lucide-react';
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
  StatusText,
} from '../../components/page.tsx';
import { Badge } from '../../components/ui/badge.tsx';
import { Button } from '../../components/ui/button.tsx';
import { Label } from '../../components/ui/label.tsx';
import { NumberInput } from '../../components/ui/number-input.tsx';
import { Segmented } from '../../components/ui/segmented.tsx';
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

const jobsAtom = family((k: { app: string; stage: string; time: TimeSearch }) =>
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

const KINDS = [
  { value: 'all', label: 'All' },
  { value: 'req', label: 'Requests' },
  { value: 'job', label: 'Jobs' },
] as const;

const OUTCOMES = [
  { value: 'any', label: 'Any outcome' },
  { value: 'error', label: 'Failed' },
  { value: 'ok', label: 'Succeeded' },
] as const;

const col = columns<TraceSummary>();

function traceColumns(app: string, utc: boolean, longest: number) {
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
        <span className="font-mono text-[12px] whitespace-nowrap text-muted-foreground">
          {when(getValue())}
        </span>
      ),
    }),
    col.accessor('name', {
      header: 'Request or job',
      cell: ({ row, getValue }) => (
        <Link
          to="/apps/$app/traces/$trace"
          params={{ app, trace: row.original.trace }}
          onClick={(e) => e.stopPropagation()}
          className="inline-flex max-w-full rounded-sm outline-hidden hover:underline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-solid"
        >
          <RouteLabel route={getValue()} />
        </Link>
      ),
    }),
    col.accessor((t) => (t.failed ? 1 : 0), {
      id: 'outcome',
      header: 'Outcome',
      cell: ({ row }) => {
        const t = row.original;
        return (
          <StatusText tone={t.failed ? 'bad' : 'ok'} className="tabular">
            {t.status ?? (t.failed ? 'Failed' : 'OK')}
          </StatusText>
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
              className={t.failed ? 'h-1.5 rounded-full bg-bad-mark' : 'h-1.5 rounded-full bg-(--chart-1)'}
              style={{ width: `${Math.max(2, (t.dur / longest) * 96)}px` }}
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
        if (t.recorded) return <Badge variant="info">Kept</Badge>;
        if (!t.calls) return <span className="text-subtle">None</span>;
        return (
          <span className="whitespace-nowrap text-muted-foreground">
            <span className="text-foreground tabular">{fmtNum(t.calls)}</span> not kept
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
  const [minDraft, setMinDraft] = useState<number | null>(f.minMs ?? null);

  const routeOptions: PickerOption[] = Option.getOrElse(
    AsyncResult.value(useAtomValue(routesAtom({ app, stage, time: time.search }))),
    () => [],
  )
    .toSorted((a, b) => b.req - a.req)
    .map((r) => ({ value: `${r.method} ${r.route}`, hint: fmtNum(r.req) }));
  const jobOptions: PickerOption[] =
    Option.getOrUndefined(
      AsyncResult.value(useAtomValue(jobsAtom({ app, stage, time: time.search }))),
    )?.jobs.map((j) => ({ value: `${j.kind}:${j.name}`, hint: fmtNum(j.ok + j.error) })) ?? [];

  const setFilters = (next: TraceFilters) => {
    const clean = Object.fromEntries(
      Object.entries(next).filter(([, v]) => v !== undefined && !(Array.isArray(v) && v.length === 0)),
    ) as TraceFilters;
    void navigate({ search: (prev) => ({ ...prev, f: Object.keys(clean).length ? clean : undefined }) });
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
  const tableColumns = useMemo(() => traceColumns(app, utc, longest), [app, utc, longest]);
  const openTrace = (trace: string) =>
    void navigate({ to: '/apps/$app/traces/$trace', params: { app, trace } });

  return (
    <>
      <PageHeader
        title="Traces"
        description={`Spans are kept for failed requests and jobs, for those taking ${SLOW_TRACE_MS / 1000}s or longer, and for 1 in ${Math.round(1 / TRACE_SAMPLE_RATE)} traces.`}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          label="Kind"
          value={f.kind ?? 'all'}
          onChange={(k) => setFilters({ ...f, kind: k === 'all' ? undefined : k })}
          options={KINDS}
        />
        {f.kind !== 'job' && (
          <ValuePicker
            label="All routes"
            name="Routes"
            options={routeOptions}
            selected={f.routes ?? []}
            onChange={(routes) => setFilters({ ...f, routes })}
            allowCustom
          />
        )}
        {f.kind !== 'req' && jobOptions.length > 0 && (
          <ValuePicker
            label="All jobs"
            name="Jobs"
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
          options={OUTCOMES}
        />
        <div className="flex items-center gap-2">
          <Label htmlFor="traces-min" className="font-normal text-muted-foreground">
            At least
          </Label>
          <NumberInput
            id="traces-min"
            className="h-7 w-32"
            placeholder="0ms"
            min={0}
            step={50}
            largeStep={500}
            format={{ style: 'unit', unit: 'millisecond', unitDisplay: 'narrow' }}
            value={minDraft}
            onValueChange={setMinDraft}
            onValueCommit={(ms) => setFilters({ ...f, minMs: ms !== null && ms > 0 ? ms : undefined })}
          />
        </div>
        <div className="flex items-center gap-2 pl-1">
          <Switch
            id="traces-recorded"
            size="sm"
            checked={f.recorded ?? false}
            onCheckedChange={(on) => setFilters({ ...f, recorded: on || undefined })}
          />
          <Label htmlFor="traces-recorded" className="font-normal">
            Only with spans
          </Label>
        </div>
        {Object.keys(f).length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setMinDraft(null);
              setFilters({});
            }}
          >
            <X />
            Clear filters
          </Button>
        )}
      </div>
      {result._tag === 'Failure' && <ErrorNotice error={result.cause} />}
      <Panel
        title="Duration"
        description="Traces with spans: failed, slow and sampled. Click one to open it, drag to zoom."
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
