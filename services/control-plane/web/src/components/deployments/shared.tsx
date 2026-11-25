/**
 * What the Deployments list, a deployment's page and the Overview share:
 * how a deployment's state, source and author read, following a running one
 * closely, and rolling a stage back.
 */
import { useAtom, useAtomRefresh } from '@effect/atom-react';
import type { DeploymentRecord, DeploymentStatus, StageRecord } from '@ericminassian/platform-core';
import type { Atom } from 'effect/reactivity';
import { GitBranch, GitCommitHorizontal, GitPullRequest, Undo2 } from 'lucide-react';
import { type ReactElement, useEffect } from 'react';
import { ApiClient } from '../../client.ts';
import { appChanged, deploymentsChanged } from '../../data/atoms.ts';
import { duration, shortId } from '../../format.ts';
import { cn } from '../../lib/utils.ts';
import { ConfirmAction } from '../actions/confirm-action.tsx';
import { report } from '../actions/report.ts';
import { StatusText, statusTone, type Tone } from '../page.tsx';

export const inProgress: ReadonlySet<DeploymentStatus> = new Set(['queued', 'running', 'awaiting_upload']);

export const STATUS_LABEL: Record<DeploymentStatus, string> = {
  awaiting_upload: 'Uploading',
  queued: 'Queued',
  running: 'Building',
  succeeded: 'Ready',
  failed: 'Error',
  rolled_back: 'Rolled back',
};

export const STAGE_LABEL: Record<StageRecord['status'], string> = {
  active: 'Live',
  deploying: 'Deploying',
  failed: 'Failed',
  destroying: 'Destroying',
  destroyed: 'Destroyed',
};

export const COMPUTE_LABEL = { request: 'Request mode', instance: 'Instance mode' } as const;

export const actorLabel = (actor: string) =>
  actor === 'platform' ? 'Platform' : actor.startsWith('ci:') ? `CI ${actor.slice(3)}` : actor;

/** A deployment's name in lists: its commit, or its id when it has none. */
export const deploymentName = (d: DeploymentRecord) => (d.commit ? d.commit.slice(0, 7) : shortId(d.id));

/** How long it took, or that it's still going. */
export const tookOf = (d: DeploymentRecord) =>
  inProgress.has(d.status) ? undefined : duration(d.startedAt, d.finishedAt);

/** The deployment's state as a dot and a word, with its build time beside it. */
export function DeploymentState({ d, className }: { d: DeploymentRecord; className?: string }) {
  const took = tookOf(d);
  const tone: Tone = d.status === 'succeeded' ? 'ok' : statusTone(d.status);
  return (
    <span className={cn('inline-flex items-center gap-2 whitespace-nowrap', className)}>
      <StatusText tone={tone}>{STATUS_LABEL[d.status]}</StatusText>
      {took && took !== '—' && <span className="text-muted-foreground tabular">{took}</span>}
    </span>
  );
}

/** Where a deployment came from: its branch or pull request, and its commit. */
export function DeploymentSource({
  d,
  repo,
  className,
  message = true,
}: {
  d: DeploymentRecord;
  repo?: string | undefined;
  className?: string;
  message?: boolean;
}) {
  const pr = d.ref?.match(/^refs\/pull\/(\d+)\//)?.[1];
  const branch = d.ref?.replace(/^refs\/heads\//, '');
  return (
    <span className={cn('flex min-w-0 items-center gap-x-3 text-sm', className)}>
      {pr ? (
        <span className="inline-flex shrink-0 items-center gap-1.5">
          <GitPullRequest aria-hidden className="size-3.5 text-subtle" />#{pr}
        </span>
      ) : branch ? (
        <span className="inline-flex shrink-0 items-center gap-1.5">
          <GitBranch aria-hidden className="size-3.5 text-subtle" />
          <span className="max-w-40 truncate">{branch}</span>
        </span>
      ) : null}
      {d.commit && (
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <GitCommitHorizontal aria-hidden className="size-3.5 shrink-0 text-subtle" />
          {repo ? (
            <a
              href={`https://github.com/${repo}/commit/${d.commit}`}
              target="_blank"
              rel="noreferrer"
              className="relative z-10 shrink-0 rounded-sm font-mono text-[13px] outline-hidden hover:underline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-solid"
            >
              {d.commit.slice(0, 7)}
            </a>
          ) : (
            <span className="shrink-0 font-mono text-[13px]">{d.commit.slice(0, 7)}</span>
          )}
          {message && d.message && (
            <span className="min-w-0 truncate text-muted-foreground" title={d.message}>
              {d.message.split('\n')[0]}
            </span>
          )}
        </span>
      )}
    </span>
  );
}

/** Refetches `atom` every `ms` while the tab is visible; no polling without `ms`. */
export function usePoll(atom: Atom.Atom<unknown>, ms: number | undefined): void {
  const refresh = useAtomRefresh(atom);
  useEffect(() => {
    if (!ms) return undefined;
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') refresh();
    }, ms);
    return () => clearInterval(id);
  }, [refresh, ms]);
}

const rollbackAtom = ApiClient.mutation('stages', 'rollback');

/** Points a stage back at a deployment's build; resolves whether it worked, and says so. */
export function useRollback(app: string) {
  const [state, run] = useAtom(rollbackAtom, { mode: 'promiseExit' });
  const rollBack = (stage: string, d: DeploymentRecord): Promise<boolean> =>
    report(
      run({
        params: { app, stage },
        payload: { deploymentId: d.id },
        reactivityKeys: [...deploymentsChanged(app), ...appChanged(app)],
      }),
      `${stage} now runs ${deploymentName(d)}`,
    );
  return { busy: state.waiting, rollBack };
}

export function RollbackButton({
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
  return (
    <ConfirmAction
      trigger={trigger}
      destructive={false}
      disabled={busy}
      title={`Roll ${stage} back to ${deploymentName(d)}?`}
      description={
        <>
          {stage} goes back to serving this deployment's build
          {d.message ? <> ({d.message.split('\n')[0]})</> : null}, without a new build.
        </>
      }
      confirmLabel={`Roll back to ${deploymentName(d)}`}
      onConfirm={onRollback}
    >
      <Undo2 />
      {label}
    </ConfirmAction>
  );
}
