/**
 * Errors grouped by fingerprint: triage them (resolve, ignore, reopen) and
 * see one group's occurrences over time, the deployments they happened on,
 * its stack with the app's frames first, and a trace that hit it.
 */
import { useAtomSet, useAtomValue } from '@effect/atom-react';
import type { ErrorGroup, ErrorStatus } from '@ericminassian/platform-core';
import { QUERY_RESOLUTION_MS } from '@ericminassian/platform-core';
import { Link, useNavigate } from '@tanstack/react-router';
import { Option } from 'effect';
import { AsyncResult } from 'effect/reactivity';
import { Bug, ChartGantt, CircleCheck, EyeOff, MousePointerClick, RotateCcw, ScrollText } from 'lucide-react';
import { type ReactNode, useMemo } from 'react';
import { ApiClient, fresh, timeToLive } from '../../client.ts';
import { report } from '../../components/actions/report.ts';
import { TimeChart } from '../../components/charts/time-chart.tsx';
import { columns, DataTable } from '../../components/data-table.tsx';
import { StackTrace } from '../../components/logs/stack.tsx';
import {
  EmptyState,
  Fact,
  Facts,
  Loaded,
  Mono,
  PageHeader,
  Panel,
  RouteLabel,
  StatusPill,
  StatusText,
  statusTone,
} from '../../components/page.tsx';
import { Button } from '../../components/ui/button.tsx';
import { Segmented } from '../../components/ui/segmented.tsx';
import { family } from '../../data/atoms.ts';
import { fmtNum, relTime, shortId } from '../../format.ts';
import { useAutoRefresh, useStage, useTime } from '../../lib/hooks.ts';
import { usePrefs } from '../../lib/prefs.tsx';
import { apiTime, timeFormat, type TimeSearch } from '../../lib/time.ts';
import { cn } from '../../lib/utils.ts';
import { errorsRoute } from '../../router.tsx';

type StatusFilter = ErrorStatus | 'all';

/** Reactivity key of an app's error groups, on every stage and status. */
const errorsChanged = (app: string) => [`errors:${app}`];

const errorsAtom = family((k: { app: string; stage: string; status: StatusFilter }) =>
  fresh(
    ApiClient.query('observe', 'errors', {
      params: { app: k.app },
      query: { stage: k.stage, ...(k.status !== 'all' ? { status: k.status } : {}) },
      reactivityKeys: errorsChanged(k.app),
      timeToLive,
    }),
    { every: '30 seconds' },
  ),
);

const occurrencesAtom = family((k: { app: string; stage: string; fingerprint: string; time: TimeSearch }) =>
  fresh(
    ApiClient.query('observe', 'errorOccurrences', {
      params: { app: k.app, fingerprint: k.fingerprint },
      query: { stage: k.stage, ...apiTime(k.time) },
      timeToLive,
    }),
    { staleTime: '1 minute' },
  ),
);

const updateError = ApiClient.mutation('observe', 'updateError');

const col = columns<ErrorGroup>();
const errorColumn = col.accessor('name', {
  header: 'Error',
  cell: ({ row }) => (
    <div className="max-w-[40rem] min-w-0">
      {/* The row opens the error on a click; the link is its way in from the keyboard. */}
      <Link
        from={errorsRoute.fullPath}
        to="."
        search={(prev) => ({ ...prev, fp: row.original.fingerprint })}
        replace
        className="block truncate rounded-sm font-medium outline-hidden focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-solid"
      >
        {row.original.name}
      </Link>
      <div className="mt-0.5 truncate text-[13px] text-muted-foreground">{row.original.message}</div>
    </div>
  ),
});
const countColumns = [
  col.accessor('count', {
    header: 'Events',
    meta: { numeric: true },
    cell: ({ getValue }) => fmtNum(getValue()),
  }),
  col.accessor('lastSeen', {
    header: 'Last seen',
    cell: ({ getValue }) => (
      <span className="whitespace-nowrap text-muted-foreground">{relTime(getValue())}</span>
    ),
  }),
];
const statusColumn = col.accessor('status', {
  header: 'Status',
  cell: ({ getValue }) => <StatusText tone={statusTone(getValue())}>{getValue()}</StatusText>,
});
/** One status shown, every row has it: the column only says something with all of them. */
const COLUMNS = {
  one: col.columns([errorColumn, ...countColumns]),
  all: col.columns([errorColumn, statusColumn, ...countColumns]),
};

const EMPTY: Record<StatusFilter, { icon: ReactNode; title: string; body?: string }> = {
  open: { icon: <CircleCheck />, title: 'No open errors', body: 'New ones appear here and send an alert.' },
  resolved: { icon: <CircleCheck />, title: 'No resolved errors' },
  ignored: { icon: <EyeOff />, title: 'No ignored errors' },
  all: { icon: <Bug />, title: 'No errors' },
};

export function ErrorsPage() {
  const { app } = errorsRoute.useParams();
  const search = errorsRoute.useSearch();
  const navigate = useNavigate({ from: errorsRoute.fullPath });
  const stage = useStage();
  const status: StatusFilter = search.status ?? 'open';
  const atom = errorsAtom({ app, stage, status });
  useAutoRefresh(atom, true);
  const result = useAtomValue(atom);
  const groups = Option.getOrElse(AsyncResult.value(result), (): readonly ErrorGroup[] => []);
  const selected = groups.find((g) => g.fingerprint === search.fp) ?? (search.fp ? undefined : groups[0]);
  const empty = EMPTY[status];

  return (
    <>
      <PageHeader
        title="Errors"
        description="Grouped by name, message and the first frame of the app's own code."
        actions={
          <Segmented<StatusFilter>
            label="Status"
            value={status}
            onChange={(next) =>
              void navigate({
                search: (prev) => ({ ...prev, status: next === 'open' ? undefined : next, fp: undefined }),
              })
            }
            options={[
              { value: 'open', label: 'Open' },
              { value: 'resolved', label: 'Resolved' },
              { value: 'ignored', label: 'Ignored' },
              { value: 'all', label: 'All' },
            ]}
          />
        }
      />
      <div
        className={cn(
          'grid grid-cols-1 items-start gap-5',
          groups.length > 0 && 'xl:grid-cols-[minmax(0,1fr)_minmax(0,30rem)]',
        )}
      >
        <Panel flush>
          <Loaded result={result} loading={<div className="h-64" />}>
            {(list) => (
              <DataTable
                columns={status === 'all' ? COLUMNS.all : COLUMNS.one}
                data={list}
                getRowId={(g) => g.fingerprint}
                initialSorting={[{ id: 'lastSeen', desc: true }]}
                onRowClick={(g) =>
                  void navigate({ search: (prev) => ({ ...prev, fp: g.fingerprint }), replace: true })
                }
                isSelected={(g) => g.fingerprint === selected?.fingerprint}
                empty={
                  <EmptyState icon={empty.icon} title={empty.title} className="py-16">
                    {empty.body}
                  </EmptyState>
                }
              />
            )}
          </Loaded>
        </Panel>
        {selected ? (
          <Detail app={app} stage={stage} group={selected} />
        ) : (
          groups.length > 0 && (
            <Panel>
              <EmptyState icon={<MousePointerClick />} title="Pick an error to see it" />
            </Panel>
          )
        )}
      </div>
    </>
  );
}

function Detail({ app, stage, group }: { app: string; stage: string; group: ErrorGroup }) {
  const time = useTime();
  const { utc } = usePrefs();
  const setStatus = useAtomSet(updateError, { mode: 'promiseExit' });
  const occurrences = useAtomValue(
    occurrencesAtom({ app, stage, fingerprint: group.fingerprint, time: time.search }),
  );
  const when = timeFormat(utc, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const triage = (next: ErrorStatus) =>
    void report(
      setStatus({
        params: { app, fingerprint: group.fingerprint },
        query: { stage },
        payload: { status: next },
        reactivityKeys: errorsChanged(app),
      }),
      next === 'open' ? 'Reopened' : next === 'resolved' ? 'Marked resolved' : 'Ignored',
    );
  const series = useMemo(() => {
    const o = Option.getOrUndefined(AsyncResult.value(occurrences));
    return o
      ? {
          timestamps: o.timestamps.map((t) => Date.parse(t)),
          stepMs: QUERY_RESOLUTION_MS[o.res],
          series: [{ key: 'events', label: 'events', color: 'var(--s5xx)', values: o.counts }],
          revs: o.revs,
        }
      : undefined;
  }, [occurrences]);

  return (
    <section aria-label={group.name} className="flex min-w-0 flex-col rounded-xl border bg-card">
      <header className="px-5 pt-4 pb-4">
        <div className="flex items-start gap-3">
          <h2 className="min-w-0 flex-1 text-base font-semibold tracking-tight break-words">{group.name}</h2>
          <StatusPill tone={statusTone(group.status)} className="mt-0.5">
            {group.status}
          </StatusPill>
        </div>
        <p className="mt-1 text-sm break-words text-muted-foreground">{group.message}</p>
        <div className="mt-4 flex flex-wrap gap-2">
          {group.status !== 'resolved' && (
            <Button variant="outline" size="sm" onClick={() => triage('resolved')}>
              <CircleCheck />
              Resolve
            </Button>
          )}
          {group.status !== 'ignored' && (
            <Button variant="outline" size="sm" onClick={() => triage('ignored')}>
              <EyeOff />
              Ignore
            </Button>
          )}
          {group.status !== 'open' && (
            <Button variant="outline" size="sm" onClick={() => triage('open')}>
              <RotateCcw />
              Reopen
            </Button>
          )}
        </div>
      </header>
      <div className="border-t px-5 py-4">
        <Facts>
          <Fact label="Events">
            <span className="tabular">{fmtNum(group.count)}</span>
          </Fact>
          <Fact label="First seen">{when(group.firstSeen)}</Fact>
          <Fact label="Last seen">
            {when(group.lastSeen)} <span className="text-muted-foreground">· {relTime(group.lastSeen)}</span>
          </Fact>
          <Fact label="Source">{group.source}</Fact>
          {group.sample.route && (
            <Fact label="Route">
              <RouteLabel route={group.sample.route} />
            </Fact>
          )}
          {group.sample.job && (
            <Fact label="Job">
              <Mono>{group.sample.job}</Mono>
            </Fact>
          )}
          {group.sample.rev && (
            <Fact label="Deployment">
              <Link
                to="/apps/$app/deployments/$deployment"
                params={{ app, deployment: group.sample.rev }}
                className="rounded-sm font-mono text-[13px] outline-hidden hover:underline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-solid"
              >
                {shortId(group.sample.rev)}
              </Link>
            </Fact>
          )}
        </Facts>
      </div>
      <div className="border-t px-5 py-4">
        <h3 className="text-sm font-semibold">Occurrences</h3>
        <p className="mt-0.5 text-[13px] text-muted-foreground">
          Events in the window, with deployments marked
        </p>
        <div className="mt-3">
          <Loaded result={occurrences} loading={<div className="h-[150px]" />}>
            {() =>
              series && (
                <>
                  <TimeChart
                    timestamps={series.timestamps}
                    stepMs={series.stepMs}
                    series={series.series}
                    kind="bar"
                    format={fmtNum}
                    height={150}
                    ariaLabel={`${group.name} events over time`}
                  />
                  {series.revs.length > 0 && (
                    <ul aria-label="Events by deployment" className="mt-3 flex flex-col text-[13px]">
                      {series.revs.map((r) => (
                        <li
                          key={r.value}
                          className="flex h-8 items-center justify-between gap-3 border-t first:border-t-0"
                        >
                          <Link
                            to="/apps/$app/deployments/$deployment"
                            params={{ app, deployment: r.value }}
                            className="rounded-sm font-mono outline-hidden hover:underline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-solid"
                          >
                            {shortId(r.value)}
                          </Link>
                          <span className="text-muted-foreground tabular">{fmtNum(r.count)} events</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )
            }
          </Loaded>
        </div>
      </div>
      <div className="border-t px-5 py-4">
        <h3 className="mb-3 text-sm font-semibold">Stack</h3>
        {group.sample.stack ? (
          <StackTrace stack={group.sample.stack} />
        ) : (
          <p className="text-[13px] text-muted-foreground">This error came without a stack trace.</p>
        )}
      </div>
      <footer className="flex flex-wrap gap-2 rounded-b-xl border-t bg-muted px-5 py-3">
        <Button
          variant="outline"
          size="sm"
          render={
            <Link
              to="/apps/$app/logs"
              params={{ app }}
              search={(prev) => ({ ...prev, q: group.name, f: { levels: ['error'] } })}
            />
          }
        >
          <ScrollText />
          Its log lines
        </Button>
        {group.sample.trace && (
          <Button
            variant="outline"
            size="sm"
            render={<Link to="/apps/$app/traces/$trace" params={{ app, trace: group.sample.trace }} />}
          >
            <ChartGantt />
            A trace that hit it
          </Button>
        )}
      </footer>
    </section>
  );
}
