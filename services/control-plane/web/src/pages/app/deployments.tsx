/**
 * An app's stages (prod and previews) and the deployments of the one in
 * view, newest first: state and build time, where it came from, who started
 * it. A row opens the deployment's page; its menu can roll the stage back to
 * it. A preview can be destroyed. The list follows a running deployment closely.
 */
import { useAtom, useAtomValue } from '@effect/atom-react';
import type { DeploymentRecord, StageRecord } from '@ericminassian/platform-core';
import { Link, useNavigate } from '@tanstack/react-router';
import { Option } from 'effect';
import { AsyncResult } from 'effect/reactivity';
import { ArrowUpRight, Ellipsis, Layers, ScrollText, SquareArrowOutUpRight, Undo2 } from 'lucide-react';
import { type ReactElement, useMemo } from 'react';
import { ApiClient } from '../../client.ts';
import { ConfirmAction } from '../../components/actions/confirm-action.tsx';
import { report } from '../../components/actions/report.ts';
import {
  actorLabel,
  COMPUTE_LABEL,
  DeploymentSource,
  DeploymentState,
  deploymentName,
  inProgress,
  STAGE_LABEL,
  usePoll,
  useRollback,
} from '../../components/deployments/shared.tsx';
import {
  EmptyState,
  Loaded,
  Loading,
  Mono,
  PageHeader,
  Panel,
  StatusText,
  statusTone,
} from '../../components/page.tsx';
import { Badge } from '../../components/ui/badge.tsx';
import { Button } from '../../components/ui/button.tsx';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '../../components/ui/menu.tsx';
import { confirm } from '../../components/ui/overlays.tsx';
import { appChanged, deploymentsAtom } from '../../data/atoms.ts';
import { stageOf, useAppSummary } from '../../data/hooks.ts';
import { fmtDateTime, relTime, shortId } from '../../format.ts';
import { useStage } from '../../lib/hooks.ts';
import { cn } from '../../lib/utils.ts';
import { appRoute } from '../../router.tsx';

const destroyAtom = ApiClient.mutation('stages', 'destroy');

export function DeploymentsPage(): ReactElement {
  const { app } = appRoute.useParams();
  const stage = useStage();
  const summary = Option.getOrUndefined(AsyncResult.value(useAppSummary(app)));
  // The list the charts' deployment markers read, kept fresh here: closely while one runs.
  const listAtom = deploymentsAtom({ app, stage });
  const list = useAtomValue(listAtom);
  const running = Option.match(AsyncResult.value(list), {
    onNone: () => false,
    onSome: (ds) => ds.some((d) => inProgress.has(d.status)),
  });
  usePoll(listAtom, running ? 3_000 : 15_000);
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
        description="Newest first"
      >
        <Loaded result={list} loading={<Loading rows={5} />}>
          {(ds) =>
            ds.length === 0 ? (
              <EmptyState icon={<Layers />} title={`No deployments to ${stage} yet`}>
                Push to main, open a pull request, or run <Mono>plat deploy</Mono>.
              </EmptyState>
            ) : (
              <DeploymentList
                app={app}
                stage={stage}
                repo={summary?.app.repo}
                deployments={ds}
                live={current?.currentDeployment}
              />
            )
          }
        </Loaded>
      </Panel>
    </>
  );
}

function Stages({ app, stage, stages }: { app: string; stage: string; stages: readonly StageRecord[] }) {
  const [destroy, destroyStage] = useAtom(destroyAtom, { mode: 'promiseExit' });
  const ordered = useMemo(
    () =>
      // Prod first, then previews, newest first.
      stages.toSorted(
        (a, b) =>
          Number(a.stage !== 'prod') - Number(b.stage !== 'prod') || b.createdAt.localeCompare(a.createdAt),
      ),
    [stages],
  );
  const onDestroy = (s: StageRecord) =>
    report(
      destroyStage({
        params: { app, stage: s.stage },
        // Prod is only destroyed when the request names the app.
        query: { confirm: s.stage === 'prod' ? app : undefined },
        reactivityKeys: appChanged(app),
      }),
      (r) => (r.status === 'destroyed' ? `${s.stage} was already gone` : `Destroying ${s.stage}`),
    );
  return (
    <Panel flush title="Stages" description="Choose one to see its deployments">
      {ordered.length === 0 ? (
        <EmptyState title="No stages yet">
          Push to main, open a pull request, or run <Mono>plat deploy</Mono>.
        </EmptyState>
      ) : (
        <ul>
          {ordered.map((s) => (
            <li
              key={s.stage}
              data-selected={s.stage === stage || undefined}
              className="relative grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 gap-y-1 border-t px-5 py-3 first:border-t-0 hover:bg-muted data-selected:bg-accent/60 md:grid-cols-[10rem_6rem_minmax(0,1fr)_8rem_5rem_4.5rem]"
            >
              <Link
                to="/apps/$app/deployments"
                params={{ app }}
                search={(prev) => ({ ...prev, stage: s.stage === 'prod' ? undefined : s.stage })}
                aria-current={s.stage === stage ? 'true' : undefined}
                className="flex min-w-0 items-center gap-2 rounded-sm outline-hidden after:absolute after:inset-0 focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-solid"
              >
                <Mono className="truncate text-sm font-medium">{s.stage}</Mono>
                {s.preview ? (
                  <Badge variant="outline">Preview</Badge>
                ) : (
                  <Badge variant="info">Production</Badge>
                )}
              </Link>
              <StatusText tone={statusTone(s.status)} className="max-md:hidden">
                {STAGE_LABEL[s.status]}
              </StatusText>
              <span className="min-w-0 truncate max-md:col-span-2">
                {s.status === 'destroyed' ? (
                  <span className="text-muted-foreground">{s.host}</span>
                ) : (
                  <a
                    href={s.url}
                    target="_blank"
                    rel="noreferrer"
                    className="relative z-10 inline-flex max-w-full items-center gap-1 rounded-sm outline-hidden hover:underline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-solid"
                  >
                    <span className="truncate">{s.host}</span>
                    <ArrowUpRight className="size-3.5 shrink-0 text-subtle" />
                  </a>
                )}
              </span>
              <span className="truncate text-muted-foreground max-md:hidden">
                {s.compute ? COMPUTE_LABEL[s.compute] : '–'}
              </span>
              <span
                className="text-right text-muted-foreground tabular max-md:hidden"
                title={fmtDateTime(s.updatedAt)}
              >
                {relTime(s.updatedAt)}
              </span>
              <span className="relative z-10 flex justify-end max-md:col-start-2 max-md:row-start-1">
                {s.preview && s.status !== 'destroying' && s.status !== 'destroyed' && (
                  <ConfirmAction
                    trigger={<Button variant="ghost" size="xs" />}
                    disabled={destroy.waiting}
                    title={`Destroy ${s.stage}?`}
                    description={`Removes the preview at ${s.host} and everything it created: its data, files and secrets. Its deployments stay listed.`}
                    confirmLabel={`Destroy ${s.stage}`}
                    onConfirm={() => onDestroy(s)}
                  >
                    Destroy
                  </ConfirmAction>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function DeploymentList({
  app,
  stage,
  repo,
  deployments,
  live,
}: {
  app: string;
  stage: string;
  repo: string | undefined;
  deployments: readonly DeploymentRecord[];
  live: string | undefined;
}) {
  const navigate = useNavigate();
  const { busy, rollBack } = useRollback(app);
  const askRollback = async (d: DeploymentRecord) => {
    const yes = await confirm({
      title: `Roll ${stage} back to ${deploymentName(d)}?`,
      description: `${stage} goes back to serving this deployment's build${d.message ? ` (${d.message.split('\n')[0]})` : ''}, without a new build.`,
      confirmLabel: `Roll back to ${deploymentName(d)}`,
    });
    if (yes) await rollBack(stage, d);
  };
  return (
    <ul aria-label={`Deployments to ${stage}`}>
      {deployments.map((d) => {
        const isLive = d.id === live;
        const canRollBack = !isLive && d.status === 'succeeded';
        return (
          <li
            key={d.id}
            className="relative grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 gap-y-1.5 border-t px-5 py-3.5 first:border-t-0 hover:bg-muted md:grid-cols-[minmax(9rem,12rem)_minmax(7rem,9rem)_minmax(0,1fr)_minmax(8rem,auto)_2rem]"
          >
            <div className="flex min-w-0 flex-col gap-0.5">
              <Link
                to="/apps/$app/deployments/$deployment"
                params={{ app, deployment: d.id }}
                className="flex min-w-0 items-center gap-2 rounded-sm outline-hidden after:absolute after:inset-0 focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-solid"
              >
                <Mono className="truncate text-sm font-medium">{shortId(d.id)}</Mono>
                {isLive && <Badge variant="info">Current</Badge>}
              </Link>
              <span className="truncate text-xs text-muted-foreground">
                {d.compute ? COMPUTE_LABEL[d.compute] : 'Deployment'}
                {d.computeSwitchOf && ' · compute switch'}
              </span>
            </div>
            <DeploymentState d={d} className="max-md:hidden" />
            <DeploymentSource d={d} repo={repo} className="max-md:col-span-2" />
            <div className="text-right text-[13px] whitespace-nowrap text-muted-foreground max-md:hidden">
              <span title={fmtDateTime(d.createdAt)}>{relTime(d.createdAt)}</span> by {actorLabel(d.actor)}
            </div>
            <div className="relative z-10 flex justify-end max-md:col-start-2 max-md:row-start-1">
              <Menu
                onAction={(value) => {
                  if (value === 'inspect')
                    void navigate({
                      to: '/apps/$app/deployments/$deployment',
                      params: { app, deployment: d.id },
                    });
                  else if (value === 'logs')
                    void navigate({
                      to: '/apps/$app/logs',
                      params: { app },
                      search: (prev) => ({ ...prev, f: { revs: [d.id] } }),
                    });
                  else if (value === 'visit' && d.url) window.open(d.url, '_blank', 'noreferrer');
                  else if (value === 'rollback') void askRollback(d);
                }}
              >
                <MenuTrigger
                  aria-label={`Actions for ${deploymentName(d)}`}
                  render={<Button variant="ghost" size="icon-sm" />}
                >
                  <Ellipsis />
                </MenuTrigger>
                <MenuContent align="end" className="w-52">
                  <MenuItem value="inspect">
                    <Layers />
                    Inspect deployment
                  </MenuItem>
                  <MenuItem value="logs">
                    <ScrollText />
                    Its log lines
                  </MenuItem>
                  {d.url && (
                    <MenuItem value="visit">
                      <SquareArrowOutUpRight />
                      Visit
                    </MenuItem>
                  )}
                  {canRollBack && (
                    <>
                      <MenuSeparator />
                      <MenuItem value="rollback" disabled={busy}>
                        <Undo2 />
                        Roll back to this
                      </MenuItem>
                    </>
                  )}
                </MenuContent>
              </Menu>
            </div>
            <DeploymentState d={d} className={cn('md:hidden', 'text-[13px]')} />
          </li>
        );
      })}
    </ul>
  );
}
