/**
 * Every 5 minutes: fail deployments whose deploy job died.
 *
 * The deploy job runs in the worker, so a Lambda timeout, out-of-memory kill
 * or a lost async invoke leaves nothing to mark the deployment finished. The
 * stage would then show `deploying` forever and the CLI would poll until it
 * gave up. A job can't outlive the worker's 15-minute limit, so anything still
 * `queued`/`running` well past that is dead.
 */
import { log } from '@eric-minassian/platform';
import type { DeploymentRecord } from '@eric-minassian/platform-core';
import {
  type DeploymentItem,
  listAllStages,
  listDeployments,
  type StageItem,
  updateDeployment,
  updateStage,
} from '../store.ts';

/** Worker timeout (15 min) plus slack for queueing and clock skew. */
export const STUCK_AFTER_MS = 20 * 60_000;

const IN_FLIGHT: ReadonlySet<DeploymentRecord['status']> = new Set(['queued', 'running']);

function startedAt(d: DeploymentItem): number {
  return Date.parse(d.startedAt ?? d.createdAt);
}

/** In-flight deployments of `stage` that started before the cutoff. */
export function stuckDeployments(
  deployments: readonly DeploymentItem[],
  stage: string,
  now = Date.now(),
): DeploymentItem[] {
  const cutoff = now - STUCK_AFTER_MS;
  return deployments.filter((d) => d.stage === stage && IN_FLIGHT.has(d.status) && startedAt(d) < cutoff);
}

/** Stages left in `deploying` since before the cutoff. */
export function suspectStages(stages: readonly StageItem[], now = Date.now()): StageItem[] {
  const cutoff = now - STUCK_AFTER_MS;
  return stages.filter((s) => s.status === 'deploying' && Date.parse(s.updatedAt) < cutoff);
}

export async function runWatchdog(now = Date.now()): Promise<{ failed: string[] }> {
  const failed: string[] = [];
  for (const stage of suspectStages(await listAllStages(), now)) {
    const deployments = await listDeployments(stage.app);
    // A newer deployment that is still within its time budget owns the stage.
    const fresh = deployments.some(
      (d) => d.stage === stage.stage && IN_FLIGHT.has(d.status) && startedAt(d) >= now - STUCK_AFTER_MS,
    );
    if (fresh) continue;
    for (const d of stuckDeployments(deployments, stage.stage, now)) {
      const marked = await updateDeployment(
        d.app,
        d.id,
        {
          status: 'failed',
          finishedAt: new Date(now).toISOString(),
          error: 'the deploy job stopped without finishing (worker timeout or crash); redeploy to retry',
        },
        d.status,
      );
      if (marked) failed.push(`${d.app}/${d.stage}/${d.id}`);
    }
    await updateStage(stage.app, stage.stage, { status: stage.currentDeployment ? 'active' : 'failed' });
    log.warn('recovered a stuck stage', { app: stage.app, stage: stage.stage });
  }
  return { failed };
}
