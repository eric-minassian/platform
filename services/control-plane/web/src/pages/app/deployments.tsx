/**
 * An app's stages (prod and previews) and the deployments of the one in
 * view: what each ran, who started it, how long it took, and its event log
 * and manifest in a side sheet. A succeeded deployment that isn't live can
 * be rolled back to, and a preview destroyed; both ask first. The list
 * follows a running deployment closely.
 */
import { useAtom, useAtomRefresh, useAtomValue } from '@effect/atom-react';
import type {
  DeploymentRecord,
  DeploymentStatus,
  ResolvedManifest,
  StageRecord,
} from '@ericminassian/platform-core';
import { Option } from 'effect';
import { AsyncResult, type Atom } from 'effect/reactivity';
import { ArrowUpRight, Undo2 } from 'lucide-react';
import { type ReactElement, type ReactNode, useCallback, useEffect, useMemo, useRef } from 'react';
import { ApiClient } from '../../client.ts';
import { ConfirmAction } from '../../components/actions/confirm-action.tsx';
import { report } from '../../components/actions/report.ts';
import { columns, DataTable } from '../../components/data-table.tsx';
import {
  EmptyState,
  ErrorNotice,
  Loaded,
  Loading,
  Mono,
  PageHeader,
  Panel,
  StatusPill,
  statusTone,
} from '../../components/page.tsx';
import { Badge } from '../../components/ui/badge.tsx';
import { Button } from '../../components/ui/button.tsx';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '../../components/ui/sheet.tsx';
import { appChanged, deploymentAtom, deploymentsAtom, deploymentsChanged } from '../../data/atoms.ts';
import { stageOf, useAppSummary } from '../../data/hooks.ts';
import { duration, fmtDateTime, relTime, shortId } from '../../format.ts';
import { useStage } from '../../lib/hooks.ts';
import { cn } from '../../lib/utils.ts';
import { appRoute, deploymentsRoute } from '../../router.tsx';

const rollbackAtom = ApiClient.mutation('stages', 'rollback');
const destroyAtom = ApiClient.mutation('stages', 'destroy');

const inProgress: ReadonlySet<DeploymentStatus> = new Set(['queued', 'running', 'awaiting_upload']);

const STATUS_LABEL: Record<DeploymentStatus, string> = {
  awaiting_upload: 'Uploading',
  queued: 'Queued',
  running: 'Deploying',
  succeeded: 'Succeeded',
  failed: 'Failed',
  rolled_back: 'Rolled back',
};
const STAGE_LABEL: Record<StageRecord['status'], string> = {
  active: 'Live',
  deploying: 'Deploying',
  failed: 'Failed',
  destroying: 'Destroying',
  destroyed: 'Destroyed',
};
const COMPUTE_LABEL = { request: 'Request mode', instance: 'Instance mode' } as const;

const actorLabel = (actor: string) =>
  actor === 'platform' ? 'Platform' : actor.startsWith('ci:') ? `CI ${actor.slice(3)}` : actor;

/** Refetches `atom` every `ms` while the tab is visible; no polling without `ms`. */
function usePoll(atom: Atom.Atom<unknown>, ms: number | undefined): void {
  const refresh = useAtomRefresh(atom);
  useEffect(() => {
    if (!ms) return undefined;
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') refresh();
    }, ms);
    return () => clearInterval(id);
  }, [refresh, ms]);
}

export function DeploymentsPage(): ReactElement {
  const { app } = appRoute.useParams();
  const stage = useStage();
  const { deployment: open } = deploymentsRoute.useSearch();
  const navigate = deploymentsRoute.useNavigate();
  const summary = Option.getOrUndefined(AsyncResult.value(useAppSummary(app)));
  // The list the charts' deployment markers read, kept fresh here: closely while one runs.
  const listAtom = deploymentsAtom({ app, stage });
  const list = useAtomValue(listAtom);
  const running = Option.match(AsyncResult.value(list), {
    onNone: () => false,
    onSome: (ds) => ds.some((d) => inProgress.has(d.status)),
  });
  usePoll(listAtom, running ? 3_000 : 15_000);
  const setOpen = (id: string | undefined) =>
    void navigate({ search: (prev) => ({ ...prev, deployment: id }), replace: id === undefined });
  const current = stageOf(summary, stage);
  return (
    <>
      <PageHeader title="Deployments" description="Every stage of the app, and what was deployed to each." />
      {summary && <Stages app={app} stage={stage} stages={summary.stages} />}
      <Panel
        flush
        title={
          <>
            Deployments to <Mono className="text-sm">{stage}</Mono>
          </>
        }
        description="Newest first; select one for its event log and manifest"
      >
        <Loaded result={list} loading={<Loading rows={5} />}>
          {(ds) => (
            <DeploymentList
              app={app}
              stage={stage}
              deployments={ds}
              live={current?.currentDeployment}
              open={open}
              onOpen={setOpen}
            />
          )}
        </Loaded>
      </Panel>
      <DeploymentSheet
        app={app}
        id={open}
        repo={summary?.app.repo}
        live={stageOf(summary, stage)?.currentDeployment}
        onClose={() => setOpen(undefined)}
      />
    </>
  );
}

const stageCol = columns<StageRecord>();

function Stages({ app, stage, stages }: { app: string; stage: string; stages: readonly StageRecord[] }) {
  const navigate = deploymentsRoute.useNavigate();
  const [destroy, destroyStage] = useAtom(destroyAtom, { mode: 'promiseExit' });
  const busy = destroy.waiting;
  const ordered = useMemo(
    () =>
      // Prod first, then previews, newest first.
      stages.toSorted(
        (a, b) =>
          Number(a.stage !== 'prod') - Number(b.stage !== 'prod') || b.createdAt.localeCompare(a.createdAt),
      ),
    [stages],
  );
  const onDestroy = useCallback(
    (s: StageRecord) =>
      report(
        destroyStage({
          params: { app, stage: s.stage },
          // Prod is only destroyed when the request names the app.
          query: { confirm: s.stage === 'prod' ? app : undefined },
          reactivityKeys: appChanged(app),
        }),
        (r) => (r.status === 'destroyed' ? `${s.stage} was already gone` : `Destroying ${s.stage}`),
      ),
    [app, destroyStage],
  );
  const tableColumns = useMemo(() => stageColumns(stage, busy, onDestroy), [stage, busy, onDestroy]);
  return (
    <Panel flush title="Stages" description="Select one to see its deployments">
      <DataTable
        columns={tableColumns}
        data={ordered}
        getRowId={(s) => s.stage}
        isSelected={(s) => s.stage === stage}
        onRowClick={(s) =>
          void navigate({
            search: (prev) => ({
              ...prev,
              stage: s.stage === 'prod' ? undefined : s.stage,
              deployment: undefined,
            }),
          })
        }
        empty={
          <EmptyState title="No stages yet">
            Push to main, open a pull request, or run <Mono>plat deploy</Mono>.
          </EmptyState>
        }
      />
    </Panel>
  );
}

/** The stages table's columns; `stage` is the one in view. */
function stageColumns(stage: string, busy: boolean, onDestroy: (s: StageRecord) => Promise<boolean>) {
  return stageCol.columns([
    stageCol.accessor('stage', {
      header: 'Stage',
      enableSorting: false,
      cell: ({ row }) => (
        <div className="flex items-center gap-2">
          <Mono className={row.original.stage === stage ? 'font-medium' : undefined}>
            {row.original.stage}
          </Mono>
          {row.original.preview && <span className="text-xs text-muted-foreground">preview</span>}
        </div>
      ),
    }),
    stageCol.accessor('status', {
      header: 'Status',
      enableSorting: false,
      cell: ({ getValue }) => (
        <StatusPill tone={statusTone(getValue())}>{STAGE_LABEL[getValue()]}</StatusPill>
      ),
    }),
    stageCol.accessor('host', {
      header: 'URL',
      enableSorting: false,
      cell: ({ row }) =>
        row.original.status === 'destroyed' ? (
          <span className="text-muted-foreground">{row.original.host}</span>
        ) : (
          <a
            href={row.original.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            {row.original.host}
            <ArrowUpRight className="size-3.5 text-muted-foreground" />
          </a>
        ),
    }),
    stageCol.accessor((s) => s.currentDeployment ?? '', {
      id: 'live',
      header: 'Live deployment',
      enableSorting: false,
      cell: ({ getValue }) => (getValue() ? <Mono>{shortId(getValue())}</Mono> : '–'),
    }),
    stageCol.accessor((s) => s.compute ?? '', {
      id: 'compute',
      header: 'Compute',
      enableSorting: false,
      cell: ({ row }) => (row.original.compute ? COMPUTE_LABEL[row.original.compute] : '–'),
    }),
    stageCol.accessor('updatedAt', {
      header: 'Updated',
      enableSorting: false,
      meta: { numeric: true },
      cell: ({ getValue }) => <span title={fmtDateTime(getValue())}>{relTime(getValue())}</span>,
    }),
    stageCol.display({
      id: 'actions',
      header: () => <span className="sr-only">Actions</span>,
      meta: { className: 'w-0 text-right' },
      cell: ({ row }) => {
        const s = row.original;
        if (!s.preview || s.status === 'destroying' || s.status === 'destroyed') return null;
        return (
          <ConfirmAction
            trigger={<Button variant="ghost" size="xs" />}
            disabled={busy}
            title={`Destroy ${s.stage}?`}
            description={`Removes the preview at ${s.host} and everything it created: its data, files and secrets. Its deployments stay listed.`}
            confirmLabel="Destroy preview"
            onConfirm={() => onDestroy(s)}
          >
            Destroy
          </ConfirmAction>
        );
      },
    }),
  ]);
}

function StatusOf({ d }: { d: DeploymentRecord }) {
  return <StatusPill tone={statusTone(d.status)}>{STATUS_LABEL[d.status]}</StatusPill>;
}

function ComputeOf({ d }: { d: DeploymentRecord }) {
  if (!d.compute) return <span className="text-muted-foreground">–</span>;
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap">
      {COMPUTE_LABEL[d.compute]}
      {d.computeSwitchOf && (
        <Badge
          variant="secondary"
          className="font-normal"
          title={`Runs the build of ${shortId(d.computeSwitchOf)}`}
        >
          switch
        </Badge>
      )}
    </span>
  );
}

const deployCol = columns<DeploymentRecord>();

function DeploymentList({
  app,
  stage,
  deployments,
  live,
  open,
  onOpen,
}: {
  app: string;
  stage: string;
  deployments: readonly DeploymentRecord[];
  live: string | undefined;
  open: string | undefined;
  onOpen: (id: string) => void;
}) {
  const [rollback, rollBackTo] = useRollback();
  const busy = rollback.waiting;
  const onRollback = useCallback(
    (d: DeploymentRecord) => rollBack(rollBackTo, app, stage, d),
    [app, stage, rollBackTo],
  );
  const tableColumns = useMemo(
    () => deploymentColumns(stage, live, busy, onRollback),
    [stage, live, busy, onRollback],
  );
  return (
    <DataTable
      columns={tableColumns}
      data={deployments}
      getRowId={(d) => d.id}
      onRowClick={(d) => onOpen(d.id)}
      isSelected={(d) => d.id === open}
      empty={
        <EmptyState title={`No deployments to ${stage} yet`}>
          Push to main, open a pull request, or run <Mono>plat deploy</Mono>.
        </EmptyState>
      }
    />
  );
}

/** The deployments table's columns; `live` is the stage's live deployment. */
function deploymentColumns(
  stage: string,
  live: string | undefined,
  busy: boolean,
  onRollback: (d: DeploymentRecord) => Promise<boolean>,
) {
  return deployCol.columns([
    deployCol.accessor('id', {
      header: 'Deployment',
      enableSorting: false,
      cell: ({ getValue }) => (
        <div className="flex items-center gap-2 whitespace-nowrap">
          <Mono>{shortId(getValue())}</Mono>
          {getValue() === live && <StatusPill tone="ok">Live</StatusPill>}
        </div>
      ),
    }),
    deployCol.accessor('status', {
      header: 'Status',
      enableSorting: false,
      cell: ({ row }) => <StatusOf d={row.original} />,
    }),
    deployCol.accessor((d) => d.compute ?? '', {
      id: 'compute',
      header: 'Compute',
      enableSorting: false,
      cell: ({ row }) => <ComputeOf d={row.original} />,
    }),
    deployCol.accessor((d) => d.commit ?? '', {
      id: 'commit',
      header: 'Commit',
      enableSorting: false,
      meta: { className: 'max-w-[26rem]' },
      cell: ({ row }) => (
        <div className="flex min-w-0 items-baseline gap-2" title={row.original.message}>
          {row.original.commit && <Mono className="shrink-0">{row.original.commit.slice(0, 7)}</Mono>}
          <span className="truncate text-muted-foreground">{row.original.message?.split('\n')[0]}</span>
        </div>
      ),
    }),
    deployCol.accessor('actor', {
      header: 'By',
      enableSorting: false,
      cell: ({ getValue }) => <span className="whitespace-nowrap">{actorLabel(getValue())}</span>,
    }),
    deployCol.accessor('createdAt', {
      header: 'Created',
      enableSorting: false,
      meta: { numeric: true },
      cell: ({ getValue }) => (
        <span className="whitespace-nowrap" title={fmtDateTime(getValue())}>
          {relTime(getValue())}
        </span>
      ),
    }),
    deployCol.accessor((d) => duration(d.startedAt, d.finishedAt), {
      id: 'took',
      header: 'Took',
      enableSorting: false,
      meta: { numeric: true },
      cell: ({ row, getValue }) =>
        inProgress.has(row.original.status) ? <span className="text-info">running</span> : getValue(),
    }),
    deployCol.display({
      id: 'actions',
      header: () => <span className="sr-only">Actions</span>,
      meta: { className: 'w-0 text-right' },
      cell: ({ row }) => {
        const d = row.original;
        if (d.id === live || d.status !== 'succeeded') return null;
        return (
          <RollbackButton
            stage={stage}
            deployment={d}
            busy={busy}
            onRollback={() => onRollback(d)}
            trigger={<Button variant="ghost" size="xs" />}
          />
        );
      },
    }),
  ]);
}

type RollbackRun = ReturnType<typeof useRollback>[1];
function useRollback() {
  return useAtom(rollbackAtom, { mode: 'promiseExit' });
}

/** Points `stage` back at a deployment's build, and says how that went. */
function rollBack(run: RollbackRun, app: string, stage: string, d: DeploymentRecord): Promise<boolean> {
  return report(
    run({
      params: { app, stage },
      payload: { deploymentId: d.id },
      reactivityKeys: [...deploymentsChanged(app), ...appChanged(app)],
    }),
    `${stage} now runs ${d.commit ? d.commit.slice(0, 7) : shortId(d.id)}`,
  );
}

function RollbackButton({
  stage,
  deployment: d,
  busy,
  onRollback,
  trigger,
  label = 'Roll back',
}: {
  stage: string;
  deployment: DeploymentRecord;
  busy: boolean;
  onRollback: () => Promise<boolean>;
  trigger: ReactElement;
  label?: string;
}) {
  const what = d.commit ? d.commit.slice(0, 7) : shortId(d.id);
  return (
    <ConfirmAction
      trigger={trigger}
      destructive={false}
      disabled={busy}
      title={`Roll ${stage} back to ${what}?`}
      description={
        <>
          {stage} goes back to serving this deployment's build
          {d.message ? <> ({d.message.split('\n')[0]})</> : null}, without a new build.
        </>
      }
      confirmLabel="Roll back"
      onConfirm={onRollback}
    >
      <Undo2 />
      {label}
    </ConfirmAction>
  );
}

/** A deployment's record, its event log followed every two seconds while it runs. */
function DeploymentSheet({
  app,
  id,
  repo,
  live,
  onClose,
}: {
  app: string;
  id: string | undefined;
  repo: string | undefined;
  live: string | undefined;
  onClose: () => void;
}) {
  return (
    <Sheet open={id !== undefined} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full gap-0 data-[side=right]:sm:max-w-2xl">
        {id && <DeploymentDetail app={app} id={id} repo={repo} live={live} />}
      </SheetContent>
    </Sheet>
  );
}

function DeploymentDetail({
  app,
  id,
  repo,
  live,
}: {
  app: string;
  id: string;
  repo: string | undefined;
  live: string | undefined;
}) {
  const atom = deploymentAtom(id);
  const result = useAtomValue(atom);
  const d = Option.getOrUndefined(AsyncResult.value(result));
  usePoll(atom, d && inProgress.has(d.status) ? 2_000 : undefined);
  const [rollback, rollBackTo] = useRollback();
  return (
    <>
      <SheetHeader className="border-b pr-12">
        <SheetTitle className="flex items-center gap-2.5">
          <Mono className="text-base">{shortId(id)}</Mono>
          {d && <StatusOf d={d} />}
          {d && d.id === live && <StatusPill tone="ok">Live</StatusPill>}
        </SheetTitle>
        <SheetDescription className="truncate">
          {d ? (d.message?.split('\n')[0] ?? `Deployment to ${d.stage}`) : 'Loading…'}
        </SheetDescription>
      </SheetHeader>
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4">
        <Loaded result={result} loading={<Loading rows={8} />}>
          {(dep) => (
            <div className="flex flex-col gap-5">
              {dep.error && <ErrorNotice error={dep.error} />}
              <Facts d={dep} repo={repo} />
              <EventLog d={dep} />
              {dep.manifest && <ManifestSummary manifest={dep.manifest} />}
            </div>
          )}
        </Loaded>
      </div>
      {d && d.id !== live && d.status === 'succeeded' && (
        <SheetFooter className="flex-row justify-end border-t">
          <RollbackButton
            stage={d.stage}
            deployment={d}
            busy={rollback.waiting}
            onRollback={() => rollBack(rollBackTo, app, d.stage, d)}
            trigger={<Button variant="outline" size="sm" />}
            label={`Roll ${d.stage} back to this`}
          />
        </SheetFooter>
      )}
    </>
  );
}

function Facts({ d, repo }: { d: DeploymentRecord; repo: string | undefined }) {
  const rows: Array<[string, ReactNode]> = [
    ['Stage', <Mono key="stage">{d.stage}</Mono>],
    [
      'Commit',
      d.commit ? (
        repo ? (
          <a
            key="commit"
            href={`https://github.com/${repo}/commit/${d.commit}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 font-mono text-[0.8125rem] hover:underline"
          >
            {d.commit.slice(0, 10)}
            <ArrowUpRight className="size-3.5 text-muted-foreground" />
          </a>
        ) : (
          <Mono key="commit">{d.commit.slice(0, 10)}</Mono>
        )
      ) : (
        '–'
      ),
    ],
    ['Ref', d.ref ? <Mono key="ref">{d.ref.replace(/^refs\/heads\//, '')}</Mono> : '–'],
    ['By', actorLabel(d.actor)],
    ['Compute', <ComputeOf key="compute" d={d} />],
    ['SDK', d.sdk ? <Mono key="sdk">{d.sdk}</Mono> : 'before 0.4.0'],
    ['Created', fmtDateTime(d.createdAt)],
    ['Took', inProgress.has(d.status) ? 'still running' : duration(d.startedAt, d.finishedAt)],
  ];
  return (
    <dl className="grid grid-cols-[6rem_1fr] gap-x-4 gap-y-2 text-sm sm:grid-cols-[6rem_1fr_6rem_1fr]">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="min-w-0 truncate">{value}</dd>
        </div>
      ))}
      {d.computeSwitchOf && (
        <p className="col-span-full text-xs text-muted-foreground">
          A switch of the server's mode by the platform: it runs the build of{' '}
          <Mono className="text-xs">{shortId(d.computeSwitchOf)}</Mono> again.
        </p>
      )}
    </dl>
  );
}

const LEVEL_CLASS = { info: '', warn: 'text-warn', error: 'text-bad' } as const;

function EventLog({ d }: { d: DeploymentRecord }) {
  const end = useRef<HTMLDivElement>(null);
  const running = inProgress.has(d.status);
  const lines = d.events.length;
  // Keeps the newest line in view while the log grows.
  useEffect(() => {
    if (running && lines > 0) end.current?.scrollIntoView({ block: 'nearest' });
  }, [lines, running]);
  return (
    <section>
      <h3 className="mb-2 text-xs font-medium text-muted-foreground">Event log</h3>
      <div className="max-h-96 overflow-y-auto rounded-md border bg-background p-3 font-mono text-xs leading-relaxed">
        {d.events.length === 0 ? (
          <span className="text-muted-foreground">
            {running ? 'Waiting for the first step…' : 'No events.'}
          </span>
        ) : (
          d.events.map((e) => (
            <div
              key={`${e.ts}:${e.level}:${e.msg}:${e.resource ?? ''}`}
              className={cn('break-words', LEVEL_CLASS[e.level])}
            >
              <span className="text-muted-foreground tabular">{new Date(e.ts).toLocaleTimeString()}</span>{' '}
              {e.msg}
              {e.resource && <span className="text-muted-foreground"> · {e.resource}</span>}
            </div>
          ))
        )}
        <div ref={end} />
      </div>
    </section>
  );
}

function ManifestSummary({ manifest: m }: { manifest: ResolvedManifest }) {
  const queues = Object.keys(m.queues);
  const crons = Object.entries(m.crons);
  const services = Object.entries(m.services);
  const rows: Array<[string, ReactNode]> = [
    [
      'Web',
      m.web
        ? [
            m.web.server && `server ${m.web.server}`,
            m.web.static && `static ${m.web.static}${m.web.spa ? ' (SPA)' : ''}`,
            `compute ${m.web.compute}`,
            `${m.web.memoryMb} MB`,
            `${m.web.timeoutSeconds}s timeout`,
          ]
            .filter(Boolean)
            .join(' · ')
        : 'none',
    ],
    ['Sign-in', m.auth.enabled ? (m.auth.required ? 'required' : 'optional') : 'off'],
    ['Database', m.db ? 'on' : 'off'],
    ['Queues', <Names key="queues" names={queues} />],
    ['Events', <Names key="events" names={m.events} />],
    [
      'Crons',
      crons.length ? (
        <span key="crons" className="flex flex-col">
          {crons.map(([name, c]) => (
            <span key={name}>
              <Mono>{name}</Mono> <Mono className="text-muted-foreground">{c.schedule}</Mono>
            </span>
          ))}
        </span>
      ) : (
        'none'
      ),
    ],
    ['Storage', <Names key="storage" names={m.storage} />],
    ['Secrets', <Names key="secrets" names={m.secrets} />],
    [
      'Realtime',
      m.realtime ? (
        <span key="realtime">
          <Names names={m.realtime.channels} /> ·{' '}
          {m.realtime.subscribe === 'signed-in' ? 'signed-in' : 'public'}
        </span>
      ) : (
        'off'
      ),
    ],
    ['Email', m.email ? `${m.email.name ?? 'on'} · ${m.email.dailyLimit} recipients a day` : 'off'],
    [
      'Services',
      services.length ? (
        <span key="services" className="flex flex-col">
          {services.map(([name, s]) => (
            <span key={name}>
              <Mono>{name}</Mono>{' '}
              <span className="text-muted-foreground">
                {s.cpu} vCPU · {s.memoryMb} MB{s.spot ? ' · Spot' : ''}
              </span>
            </span>
          ))}
        </span>
      ) : (
        'none'
      ),
    ],
  ];
  return (
    <section>
      <h3 className="mb-2 text-xs font-medium text-muted-foreground">Manifest</h3>
      <dl className="grid grid-cols-[6rem_1fr] gap-x-4 gap-y-2 rounded-md border px-3 py-2.5 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="min-w-0 break-words">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function Names({ names }: { names: readonly string[] }) {
  if (names.length === 0) return <>none</>;
  return (
    <span className="font-mono text-[0.8125rem]">
      {names.map((n, i) => (
        <span key={n}>
          {i > 0 && <span className="text-subtle">, </span>}
          {n}
        </span>
      ))}
    </span>
  );
}
