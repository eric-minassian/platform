/**
 * An app stage's background work: runs per queue, event subscription, cron
 * and invoke over the page's window, runs and failures over time, jobs
 * waiting to retry, crons to run by hand, and the dead letters (jobs that
 * failed every attempt) to run again or discard.
 */
import { useAtom, useAtomValue } from '@effect/atom-react';
import type {
  DeadLetterItem,
  DeadLettersResponse,
  JobStats,
  JobsResponse,
  MetricsView,
  QueueStats,
  SeriesQuery,
} from '@ericminassian/platform-core';
import { Option } from 'effect';
import { AsyncResult } from 'effect/reactivity';
import { Play, RotateCcw, Trash2 } from 'lucide-react';
import { type MouseEvent, type ReactElement, useCallback, useMemo, useState } from 'react';
import { ApiClient, fresh, timeToLive } from '../../client.ts';
import { ConfirmAction } from '../../components/actions/confirm-action.tsx';
import { report } from '../../components/actions/report.ts';
import { Sparkline } from '../../components/charts/sparkline.tsx';
import { columns, DataTable } from '../../components/data-table.tsx';
import { ChartPanel } from '../../components/metrics/chart-panel.tsx';
import {
  EmptyState,
  Fact,
  Facts,
  Loaded,
  Mono,
  PageHeader,
  Panel,
  Stat,
  Stats,
} from '../../components/page.tsx';
import { Badge } from '../../components/ui/badge.tsx';
import { Button } from '../../components/ui/button.tsx';
import {
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from '../../components/ui/drawer.tsx';
import { confirm } from '../../components/ui/overlays.tsx';
import { family, seriesAtom } from '../../data/atoms.ts';
import { fmtDateTime, fmtMs, fmtNum, fmtPct, relTime } from '../../format.ts';
import { useAutoRefresh, useStage, useSticky, useTime } from '../../lib/hooks.ts';
import { apiTime, type TimeSearch } from '../../lib/time.ts';
import { viewResolution } from '../../lib/view.ts';
import { appRoute } from '../../router.tsx';

/** Reactivity key of an app's scheduled jobs and dead letters. */
const queuesChanged = (app: string) => [`queues:${app}`];

const jobsAtom = family((k: { app: string; stage: string; time: TimeSearch }) =>
  fresh(
    ApiClient.query('observe', 'jobs', {
      params: { app: k.app },
      query: { stage: k.stage, ...apiTime(k.time) },
      timeToLive,
    }),
  ),
);
const queuesAtom = family((k: { app: string; stage: string }) =>
  fresh(
    ApiClient.query('observe', 'queues', {
      params: { app: k.app },
      query: { stage: k.stage },
      reactivityKeys: queuesChanged(k.app),
      timeToLive,
    }),
    { every: '15 seconds' },
  ),
);
const deadLettersAtom = family((k: { app: string; stage: string }) =>
  fresh(
    ApiClient.query('observe', 'deadLetters', {
      params: { app: k.app },
      query: { stage: k.stage },
      reactivityKeys: queuesChanged(k.app),
      timeToLive,
    }),
    { every: '15 seconds' },
  ),
);
const runCronAtom = ApiClient.mutation('manage', 'runCron');
const redriveAtom = ApiClient.mutation('manage', 'redrive');
const discardAtom = ApiClient.mutation('manage', 'discard');

const RUNS: MetricsView = {
  kind: 'metrics',
  queries: [{ id: 'a', metric: 'jobs', stat: 'count', groupBy: 'outcome' }],
  chart: 'bar',
};
const FAILURES: MetricsView = {
  kind: 'metrics',
  queries: [{ id: 'a', metric: 'jobs', stat: 'count', filter: { outcome: 'error' }, groupBy: 'job' }],
  chart: 'bar',
};
const DURATION: MetricsView = {
  kind: 'metrics',
  queries: [{ id: 'a', metric: 'job_duration', stat: 'p95', groupBy: 'job' }],
  chart: 'line',
  scale: 'log',
};
const RUNS_BY_JOB: SeriesQuery = { metric: 'jobs', stat: 'count', groupBy: 'job' };

const plural = (n: number, one: string, many = `${one}s`) => `${fmtNum(n)} ${n === 1 ? one : many}`;

export function JobsPage(): ReactElement {
  const { app } = appRoute.useParams();
  const stage = useStage();
  const time = useTime();
  const atom = jobsAtom({ app, stage, time: time.search });
  useAutoRefresh(atom, time.search.from === undefined);
  const jobs = useSticky(useAtomValue(atom));
  const queues = useAtomValue(queuesAtom({ app, stage }));
  const letters = useAtomValue(deadLettersAtom({ app, stage }));
  return (
    <>
      <PageHeader title="Jobs" description={`Queue, event, cron and invoke runs on ${stage}.`} />
      <Figures
        jobs={Option.getOrUndefined(AsyncResult.value(jobs))}
        queues={Option.getOrUndefined(AsyncResult.value(queues))}
        letters={Option.getOrUndefined(AsyncResult.value(letters))}
      />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <ChartPanel
          title="Runs"
          description="by outcome"
          app={app}
          stage={stage}
          time={time.search}
          view={RUNS}
          height={180}
        />
        <ChartPanel
          title="Failed runs"
          description="by job"
          app={app}
          stage={stage}
          time={time.search}
          view={FAILURES}
          height={180}
        />
        <ChartPanel
          title="Duration"
          description="p95 by job, log scale"
          app={app}
          stage={stage}
          time={time.search}
          view={DURATION}
          height={180}
        />
      </div>
      <Panel flush title="Jobs" description="Runs in this range">
        <Loaded result={jobs} loading={<div className="h-40" />}>
          {(d) => <JobsTable app={app} stage={stage} time={time.search} jobs={d.jobs} />}
        </Loaded>
      </Panel>
      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-2">
        <Queues queues={queues} />
        <Crons app={app} stage={stage} jobs={jobs} />
      </div>
      <DeadLetters app={app} stage={stage} />
    </>
  );
}

function Figures({
  jobs,
  queues,
  letters,
}: {
  jobs: JobsResponse | undefined;
  queues: readonly QueueStats[] | undefined;
  letters: DeadLettersResponse | undefined;
}) {
  const ok = jobs?.jobs.reduce((n, j) => n + j.ok, 0);
  const failed = jobs?.jobs.reduce((n, j) => n + j.error, 0);
  const runs = ok === undefined || failed === undefined ? undefined : ok + failed;
  const scheduled = queues?.reduce((n, q) => n + q.scheduled, 0);
  return (
    <Stats>
      <Stat label="Runs" value={fmtNum(runs)} note={jobs ? plural(jobs.jobs.length, 'job') : undefined} />
      <Stat
        label="Failed"
        value={fmtNum(failed)}
        tone={failed ? 'bad' : undefined}
        note={runs ? `${fmtPct((failed ?? 0) / runs, 2)} of runs` : 'no runs in this range'}
      />
      <Stat label="Waiting to retry" value={fmtNum(scheduled)} note="retries and delayed sends, all queues" />
      <Stat
        label="Dead letters"
        value={fmtNum(letters?.total)}
        tone={letters?.total ? 'bad' : undefined}
        note="jobs that failed every attempt"
      />
    </Stats>
  );
}

function KindBadge({ kind }: { kind: string }) {
  return (
    <Badge variant="secondary" className="font-normal text-muted-foreground">
      {kind}
    </Badge>
  );
}

const job = columns<JobStats & { readonly trend: ReadonlyArray<number | null> }>();
const jobColumns = job.columns([
  job.accessor((j) => `${j.kind}:${j.name}`, {
    id: 'job',
    header: 'Job',
    cell: ({ row }) => (
      <div className="flex items-center gap-2">
        <KindBadge kind={row.original.kind} />
        <Mono>{row.original.name}</Mono>
      </div>
    ),
  }),
  job.display({
    id: 'trend',
    header: 'Runs over time',
    cell: ({ row }) => <Sparkline values={row.original.trend} width={96} height={20} />,
  }),
  job.accessor((j) => j.ok + j.error, {
    id: 'runs',
    header: 'Runs',
    meta: { numeric: true },
    cell: ({ getValue }) => fmtNum(getValue()),
  }),
  job.accessor('error', {
    header: 'Failed',
    meta: { numeric: true },
    cell: ({ getValue }) => (
      <span className={getValue() ? 'text-bad' : 'text-muted-foreground'}>{fmtNum(getValue())}</span>
    ),
  }),
  job.accessor((j) => (j.ok + j.error ? j.error / (j.ok + j.error) : -1), {
    id: 'rate',
    header: 'Failure rate',
    meta: { numeric: true },
    cell: ({ getValue }) => {
      const rate = getValue();
      if (rate < 0) return '–';
      return <span className={rate > 0.01 ? 'text-bad' : undefined}>{rate ? fmtPct(rate, 2) : '0%'}</span>;
    },
  }),
  job.accessor((j) => j.p95 ?? -1, {
    id: 'p95',
    header: 'p95',
    meta: { numeric: true },
    cell: ({ row }) => fmtMs(row.original.p95),
  }),
  job.accessor((j) => j.lastRun ?? '', {
    id: 'lastRun',
    header: 'Last run',
    meta: { numeric: true },
    cell: ({ row }) => (
      <span title={row.original.lastRun ? fmtDateTime(row.original.lastRun) : undefined}>
        {row.original.lastRun ? relTime(row.original.lastRun) : 'never'}
      </span>
    ),
  }),
]);

function JobsTable({
  app,
  stage,
  time,
  jobs,
}: {
  app: string;
  stage: string;
  time: TimeSearch;
  jobs: readonly JobStats[];
}) {
  const trend = Option.getOrUndefined(
    AsyncResult.value(
      useAtomValue(seriesAtom({ app, stage, time, res: viewResolution(time), query: RUNS_BY_JOB })),
    ),
  );
  const rows = jobs.map((j) => ({
    ...j,
    trend: trend?.series.find((s) => s.key === `${j.kind}:${j.name}`)?.values ?? [],
  }));
  return (
    <DataTable
      columns={jobColumns}
      data={rows}
      getRowId={(j) => `${j.kind}:${j.name}`}
      initialSorting={[{ id: 'runs', desc: true }]}
      empty={
        <EmptyState title="No queues, event subscriptions or crons">
          Declare them in <Mono>plat.config.ts</Mono>.
        </EmptyState>
      }
    />
  );
}

const queue = columns<QueueStats>();
const queueColumns = queue.columns([
  queue.accessor('name', { header: 'Queue', cell: ({ getValue }) => <Mono>{getValue()}</Mono> }),
  queue.accessor('scheduled', {
    header: 'Waiting to retry',
    meta: { numeric: true },
    cell: ({ getValue }) => (
      <span title="Retries and delayed sends waiting for their time">{fmtNum(getValue())}</span>
    ),
  }),
  queue.accessor('deadLetter', {
    header: 'Dead letters',
    meta: { numeric: true },
    cell: ({ getValue }) => (
      <span className={getValue() ? 'font-medium text-bad' : 'text-muted-foreground'}>
        {fmtNum(getValue())}
      </span>
    ),
  }),
]);

function Queues({ queues }: { queues: AsyncResult.AsyncResult<readonly QueueStats[], unknown> }) {
  return (
    <Panel flush title="Queues">
      <Loaded result={queues} loading={<div className="h-24" />}>
        {(qs) => (
          <DataTable
            columns={queueColumns}
            data={qs}
            getRowId={(q) => q.name}
            empty={<EmptyState title="No queues on this stage" />}
          />
        )}
      </Loaded>
    </Panel>
  );
}

function Crons({
  app,
  stage,
  jobs,
}: {
  app: string;
  stage: string;
  jobs: AsyncResult.AsyncResult<JobsResponse, unknown>;
}) {
  const [run, runCron] = useAtom(runCronAtom, { mode: 'promiseExit' });
  return (
    <Panel flush title="Crons" description="Schedules in UTC">
      <Loaded result={jobs} loading={<div className="h-24" />}>
        {(d) =>
          d.crons.length === 0 ? (
            <EmptyState title="No crons on this stage" />
          ) : (
            <ul>
              {d.crons.map((c) => {
                const last = d.jobs.find((j) => j.kind === 'cron' && j.name === c.name)?.lastRun;
                return (
                  <li key={c.name} className="flex items-center gap-3 border-b px-5 py-3 last:border-0">
                    <div className="min-w-0 flex-1">
                      <Mono>{c.name}</Mono>
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        <Mono className="text-xs">{c.schedule}</Mono>
                        {' · '}
                        {last ? `last ran ${relTime(last)}` : 'no runs yet'}
                      </div>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label={`Run ${c.name} now`}
                      disabled={run.waiting}
                      onClick={() =>
                        void report(
                          runCron({ params: { app, name: c.name }, query: { stage } }),
                          `Started ${c.name} on ${stage}`,
                        )
                      }
                    >
                      <Play />
                      Run now
                    </Button>
                  </li>
                );
              })}
            </ul>
          )
        }
      </Loaded>
    </Panel>
  );
}

/**
 * Jobs that failed every attempt, from the stage's dead-letter queue. Redrive
 * runs them again from their first attempt, on the function their handler
 * runs in now; a message the platform didn't write (`unknown`) can only be
 * discarded. Redriving or discarding all of them, or discarding one, asks first.
 */
function DeadLetters({ app, stage }: { app: string; stage: string }) {
  const letters = useAtomValue(deadLettersAtom({ app, stage }));
  const [redrive, runRedrive] = useAtom(redriveAtom, { mode: 'promiseExit' });
  const [discard, runDiscard] = useAtom(discardAtom, { mode: 'promiseExit' });
  const [open, setOpen] = useState<string>();
  const busy = redrive.waiting || discard.waiting;
  const data = Option.getOrUndefined(AsyncResult.value(letters));
  const total = data?.total ?? 0;
  const act = useCallback(
    (which: 'redrive' | 'discard', ids?: readonly string[]) =>
      report(
        (which === 'redrive' ? runRedrive : runDiscard)({
          params: { app },
          query: { stage },
          payload: ids ? { ids } : {},
          reactivityKeys: queuesChanged(app),
        }),
        ({ count }) =>
          which === 'redrive'
            ? `Running ${plural(count, 'job')} again`
            : `Discarded ${plural(count, 'dead letter')}`,
      ),
    [app, stage, runRedrive, runDiscard],
  );
  const selected = data?.items.find((l) => l.id === open);
  const columnsOf = useMemo(() => letterColumns(busy, act), [busy, act]);

  return (
    <Panel
      flush
      title="Dead letters"
      description={total > 0 ? `${fmtNum(total)} in the stage's dead-letter queue` : undefined}
      actions={
        total > 0 && (
          <>
            <ConfirmAction
              trigger={<Button variant="outline" size="sm" />}
              destructive={false}
              disabled={busy}
              title={`Redrive ${plural(total, 'dead letter')}?`}
              description="Each runs again from its first attempt, on the function its handler runs in now. Messages the platform didn't write stay in the queue."
              confirmLabel={`Redrive ${fmtNum(total)}`}
              onConfirm={() => act('redrive')}
            >
              <RotateCcw />
              Redrive all
            </ConfirmAction>
            <ConfirmAction
              trigger={<Button variant="ghost" size="sm" />}
              disabled={busy}
              title={`Discard ${plural(total, 'dead letter')}?`}
              description="They're deleted from the dead-letter queue and won't run again."
              confirmLabel={`Discard ${fmtNum(total)}`}
              onConfirm={() => act('discard')}
            >
              <Trash2 />
              Discard all
            </ConfirmAction>
          </>
        )
      }
      footer={
        data && data.total > data.items.length
          ? `${fmtNum(data.items.length)} of about ${fmtNum(data.total)} shown.`
          : undefined
      }
    >
      <Loaded result={letters} loading={<div className="h-24" />}>
        {(d) => (
          <DataTable
            columns={columnsOf}
            data={d.items}
            getRowId={(l) => l.id}
            onRowClick={(l) => setOpen(l.id)}
            isSelected={(l) => l.id === open}
            empty={
              <EmptyState title="No dead letters">
                Every job that ran either succeeded or will retry.
              </EmptyState>
            }
          />
        )}
      </Loaded>
      <DeadLetterDrawer
        letter={selected}
        busy={busy}
        onOpenChange={(o) => !o && setOpen(undefined)}
        onAct={async (which, id) => {
          const done = await act(which, [id]);
          if (done) setOpen(undefined);
          return done;
        }}
      />
    </Panel>
  );
}

const discardOne = (l: DeadLetterItem) =>
  confirm({
    title: l.kind === 'unknown' ? 'Discard this message?' : `Discard this ${l.name} dead letter?`,
    description: "It's deleted from the dead-letter queue and won't run again.",
    confirmLabel: 'Discard',
    destructive: true,
  });

const letterColumn = columns<DeadLetterItem>();
function letterColumns(
  busy: boolean,
  act: (which: 'redrive' | 'discard', ids: readonly string[]) => Promise<boolean>,
) {
  return letterColumn.columns([
    letterColumn.accessor((l) => `${l.kind}:${l.name}`, {
      id: 'job',
      header: 'Job',
      cell: ({ row }) => (
        <div className="flex items-center gap-2 whitespace-nowrap">
          <KindBadge kind={row.original.kind} />
          {row.original.kind !== 'unknown' && <Mono>{row.original.name}</Mono>}
        </div>
      ),
    }),
    letterColumn.accessor((l) => l.error.name, {
      id: 'error',
      header: 'Error',
      meta: { className: 'max-w-[32rem]' },
      cell: ({ row }) => {
        const l = row.original;
        return (
          <div className="min-w-0">
            <div className="truncate" title={l.error.message}>
              <span className="text-bad">{l.error.name}</span> {l.error.message}
            </div>
            {l.preview && <Mono className="block truncate text-xs text-muted-foreground">{l.preview}</Mono>}
          </div>
        );
      },
    }),
    letterColumn.accessor((l) => l.attempts ?? -1, {
      id: 'attempts',
      header: 'Attempts',
      meta: { numeric: true },
      cell: ({ row }) => row.original.attempts ?? '–',
    }),
    letterColumn.accessor((l) => l.failedAt ?? '', {
      id: 'failedAt',
      header: 'Failed',
      meta: { numeric: true },
      cell: ({ row }) => (
        <span
          className="whitespace-nowrap"
          title={row.original.failedAt ? fmtDateTime(row.original.failedAt) : undefined}
        >
          {row.original.failedAt ? relTime(row.original.failedAt) : '–'}
        </span>
      ),
    }),
    letterColumn.display({
      id: 'actions',
      header: () => <span className="sr-only">Actions</span>,
      meta: { className: 'w-0 whitespace-nowrap text-right' },
      cell: ({ row }) => {
        const l = row.original;
        const label = l.kind === 'unknown' ? 'message' : l.name;
        // A row click opens the letter; its buttons act on it instead. Discard asks
        // in the shared dialog, outside the row, so its clicks never reach the row.
        const onRedrive = (e: MouseEvent) => {
          e.stopPropagation();
          void act('redrive', [l.id]);
        };
        const onDiscard = (e: MouseEvent) => {
          e.stopPropagation();
          void discardOne(l).then((yes) => (yes ? act('discard', [l.id]) : false));
        };
        return (
          <div className="flex justify-end gap-1">
            {l.kind !== 'unknown' && (
              <Button
                variant="outline"
                size="xs"
                aria-label={`Redrive ${label}`}
                disabled={busy}
                onClick={onRedrive}
              >
                Redrive
              </Button>
            )}
            <Button
              variant="ghost"
              size="xs"
              aria-label={`Discard ${label}`}
              disabled={busy}
              onClick={onDiscard}
            >
              Discard
            </Button>
          </div>
        );
      },
    }),
  ]);
}

const SOURCE: Record<DeadLetterItem['source'], string> = {
  sdk: 'the SDK, after its last retry',
  lambda: 'Lambda, after its last retry',
  scheduler: 'EventBridge Scheduler',
  eventbridge: 'EventBridge',
  unknown: 'unknown',
};

function DeadLetterDrawer({
  letter,
  busy,
  onOpenChange,
  onAct,
}: {
  letter: DeadLetterItem | undefined;
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onAct: (which: 'redrive' | 'discard', id: string) => Promise<boolean>;
}) {
  // The letter stays on screen while the drawer slides out.
  const [kept, setKept] = useState(letter);
  if (letter && letter !== kept) setKept(letter);
  const l = letter ?? kept;
  return (
    <Drawer open={letter !== undefined} onOpenChange={onOpenChange}>
      {/* Focus lands on what's read, not on Discard, so Enter can't throw a letter away. */}
      <DrawerContent width="36rem" initialFocus="content">
        {l && (
          <>
            <DrawerHeader>
              <DrawerTitle>
                <KindBadge kind={l.kind} />
                {l.kind === 'unknown' ? 'Unknown message' : <Mono className="text-base">{l.name}</Mono>}
              </DrawerTitle>
              <DrawerDescription>
                Failed{' '}
                {l.failedAt ? `${relTime(l.failedAt)}, ${fmtDateTime(l.failedAt)}` : 'at an unknown time'}
              </DrawerDescription>
            </DrawerHeader>
            <DrawerBody className="flex flex-col gap-5">
              <div className="rounded-lg border border-bad-mark/30 bg-bad-mark/8 px-3.5 py-2.5">
                <div className="font-medium text-bad">{l.error.name}</div>
                <div className="mt-0.5 break-words whitespace-pre-wrap">{l.error.message}</div>
              </div>
              <Facts>
                <Fact label="Attempts">
                  <span className="tabular">{l.attempts ?? 'unknown'}</span>
                </Fact>
                <Fact label="Given up by">{SOURCE[l.source]}</Fact>
                <Fact label="Message">
                  <Mono className="break-all">{l.id}</Mono>
                </Fact>
              </Facts>
              <section>
                <h3 className="mb-2 text-[13px] font-medium text-muted-foreground">
                  Payload, cut to a few hundred characters
                </h3>
                <pre className="overflow-x-auto rounded-lg bg-muted p-3.5 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap">
                  {prettyJson(l.preview) || '–'}
                </pre>
              </section>
            </DrawerBody>
            <DrawerFooter>
              <ConfirmAction
                trigger={<Button variant="ghost" />}
                disabled={busy}
                title={l.kind === 'unknown' ? 'Discard this message?' : `Discard this ${l.name} dead letter?`}
                description="It's deleted from the dead-letter queue and won't run again."
                confirmLabel="Discard"
                onConfirm={() => onAct('discard', l.id)}
              >
                Discard
              </ConfirmAction>
              {l.kind !== 'unknown' && (
                <Button disabled={busy} onClick={() => void onAct('redrive', l.id)}>
                  <RotateCcw />
                  Redrive
                </Button>
              )}
            </DrawerFooter>
          </>
        )}
      </DrawerContent>
    </Drawer>
  );
}

/** The payload indented when it's complete JSON; a cut preview stays as it came. */
function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}
