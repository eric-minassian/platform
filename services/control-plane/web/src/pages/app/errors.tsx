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
import { ChartGantt, CircleCheck, EyeOff, RotateCcw, ScrollText } from 'lucide-react';
import { useMemo } from 'react';
import { toast } from 'sonner';
import { ApiClient, errorMessage, fresh, timeToLive } from '../../client.ts';
import { TimeChart } from '../../components/charts/time-chart.tsx';
import { columns, DataTable } from '../../components/data-table.tsx';
import { stackFrames } from '../../components/logs/log-drawer.tsx';
import {
  EmptyState,
  Loaded,
  Mono,
  PageHeader,
  Panel,
  RouteLabel,
  StatusPill,
  statusTone,
} from '../../components/page.tsx';
import { Segmented } from '../../components/segmented.tsx';
import { Button } from '../../components/ui/button.tsx';
import { family } from '../../data/atoms.ts';
import { fmtNum, relTime } from '../../format.ts';
import { useAutoRefresh, useStage, useTime } from '../../lib/hooks.ts';
import { usePrefs } from '../../lib/prefs.tsx';
import { apiTime, timeFormat, type TimeSearch } from '../../lib/time.ts';
import { cn } from '../../lib/utils.ts';
import { errorsRoute } from '../../router.tsx';

/** Reactivity key of an app's error groups, on every stage and status. */
const errorsChanged = (app: string) => [`errors:${app}`];

const errorsAtom = family((k: { app: string; stage: string; status: string }) =>
  fresh(
    ApiClient.query('observe', 'errors', {
      params: { app: k.app },
      query: { stage: k.stage, ...(k.status !== 'all' ? { status: k.status as ErrorStatus } : {}) },
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
const errorColumns = col.columns([
  col.accessor('name', {
    header: 'Error',
    cell: ({ row }) => (
      <div className="max-w-[36rem] min-w-0">
        <div className="truncate font-medium">{row.original.name}</div>
        <div className="truncate text-xs text-muted-foreground">{row.original.message}</div>
      </div>
    ),
  }),
  col.accessor('status', {
    header: 'Status',
    cell: ({ getValue }) => <StatusPill tone={statusTone(getValue())}>{getValue()}</StatusPill>,
  }),
  col.accessor('count', {
    header: 'Events',
    meta: { numeric: true },
    cell: ({ getValue }) => fmtNum(getValue()),
  }),
  col.accessor('lastSeen', {
    header: 'Last seen',
    cell: ({ getValue }) => <span className="whitespace-nowrap">{relTime(getValue())}</span>,
  }),
]);

export function ErrorsPage() {
  const { app } = errorsRoute.useParams();
  const search = errorsRoute.useSearch();
  const navigate = useNavigate({ from: errorsRoute.fullPath });
  const stage = useStage();
  const status = search.status ?? 'open';
  const atom = errorsAtom({ app, stage, status });
  useAutoRefresh(atom, true);
  const result = useAtomValue(atom);
  const groups = Option.getOrElse(AsyncResult.value(result), (): readonly ErrorGroup[] => []);
  const selected = groups.find((g) => g.fingerprint === search.fp) ?? (search.fp ? undefined : groups[0]);

  return (
    <>
      <PageHeader
        title="Errors"
        description="Grouped by name, message and the first frame of the app's own code."
        actions={
          <Segmented
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
      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,5fr)_minmax(0,4fr)]">
        <Panel flush>
          <Loaded result={result} loading={<div className="h-64" />}>
            {(list) => (
              <DataTable
                columns={errorColumns}
                data={list}
                getRowId={(g) => g.fingerprint}
                initialSorting={[{ id: 'lastSeen', desc: true }]}
                onRowClick={(g) =>
                  void navigate({ search: (prev) => ({ ...prev, fp: g.fingerprint }), replace: true })
                }
                isSelected={(g) => g.fingerprint === selected?.fingerprint}
                empty={
                  <EmptyState
                    title={
                      status === 'open'
                        ? 'No open errors'
                        : `No ${status === 'all' ? '' : `${status} `}errors`
                    }
                  >
                    {status === 'open' ? 'New ones appear here and send an alert.' : undefined}
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
              <EmptyState title="Pick an error to see it" />
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
    void (async () => {
      const exit = await setStatus({
        params: { app, fingerprint: group.fingerprint },
        query: { stage },
        payload: { status: next },
        reactivityKeys: errorsChanged(app),
      });
      if (exit._tag === 'Failure') toast.error(errorMessage(exit.cause));
      else toast.success(next === 'open' ? 'Reopened' : next === 'resolved' ? 'Marked resolved' : 'Ignored');
    })();
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
    <div className="flex min-w-0 flex-col gap-4">
      <Panel
        title={
          <span className="flex items-center gap-2">
            {group.name}
            <StatusPill tone={statusTone(group.status)}>{group.status}</StatusPill>
          </span>
        }
        actions={
          <>
            {group.status !== 'resolved' && (
              <Button variant="outline" size="sm" onClick={() => triage('resolved')}>
                <CircleCheck />
                Resolve
              </Button>
            )}
            {group.status !== 'ignored' && (
              <Button variant="ghost" size="sm" onClick={() => triage('ignored')}>
                <EyeOff />
                Ignore
              </Button>
            )}
            {group.status !== 'open' && (
              <Button variant="ghost" size="sm" onClick={() => triage('open')}>
                <RotateCcw />
                Reopen
              </Button>
            )}
          </>
        }
      >
        <p className="text-sm break-words">{group.message}</p>
        <dl className="mt-3 grid grid-cols-[7rem_1fr] gap-y-1.5 text-sm">
          <dt className="text-muted-foreground">Events</dt>
          <dd className="tabular">{fmtNum(group.count)}</dd>
          <dt className="text-muted-foreground">First seen</dt>
          <dd>{when(group.firstSeen)}</dd>
          <dt className="text-muted-foreground">Last seen</dt>
          <dd>
            {when(group.lastSeen)} <span className="text-muted-foreground">({relTime(group.lastSeen)})</span>
          </dd>
          <dt className="text-muted-foreground">Source</dt>
          <dd>{group.source}</dd>
          {group.sample.route && (
            <>
              <dt className="text-muted-foreground">Route</dt>
              <dd>
                <RouteLabel route={group.sample.route} />
              </dd>
            </>
          )}
          {group.sample.job && (
            <>
              <dt className="text-muted-foreground">Job</dt>
              <dd>
                <Mono>{group.sample.job}</Mono>
              </dd>
            </>
          )}
          {group.sample.rev && (
            <>
              <dt className="text-muted-foreground">Deployment</dt>
              <dd>
                <Mono>{group.sample.rev.slice(-7)}</Mono>
              </dd>
            </>
          )}
        </dl>
        <div className="mt-3 flex flex-wrap gap-2">
          {group.sample.trace && (
            <Button
              variant="outline"
              size="sm"
              nativeButton={false}
              render={<Link to="/apps/$app/traces/$trace" params={{ app, trace: group.sample.trace }} />}
            >
              <ChartGantt />
              A trace that hit it
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            nativeButton={false}
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
        </div>
      </Panel>
      <Panel title="Occurrences" description="events per bucket in the window, with deployments marked">
        <Loaded result={occurrences} loading={<div className="h-40" />}>
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
                  <p className="mt-2 text-xs text-muted-foreground">
                    On{' '}
                    {series.revs.map((r, i) => (
                      <span key={r.value}>
                        {i > 0 && ', '}
                        <Mono>{r.value.slice(-7)}</Mono> ({fmtNum(r.count)})
                      </span>
                    ))}
                  </p>
                )}
              </>
            )
          }
        </Loaded>
      </Panel>
      <Panel title="Stack">
        {group.sample.stack ? (
          <pre className="overflow-x-auto rounded-md border bg-background p-3 font-mono text-[11.5px] leading-relaxed">
            {stackFrames(group.sample.stack).map(({ key, frame, own }) => (
              <span key={key} className={cn('block', own ? 'text-foreground' : 'text-subtle')}>
                {frame}
              </span>
            ))}
          </pre>
        ) : (
          <p className="text-sm text-muted-foreground">This error came without a stack trace.</p>
        )}
      </Panel>
    </div>
  );
}
