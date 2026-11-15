/**
 * Every 5 minutes: fail deployments whose deploy job died.
 *
 * The deploy job runs in the worker, so a Lambda timeout, out-of-memory kill
 * or a lost async invoke leaves nothing to mark the deployment finished. The
 * stage would then show `deploying` forever and the CLI would poll until it
 * gave up. A job can't outlive the worker's 15-minute limit, so anything still
 * `queued`/`running` well past that is dead.
 */
import type { DeploymentStatus } from '@ericminassian/platform-core';
import { Clock, Context, Effect, Layer } from 'effect';
import { type DeploymentItem, type StageItem, Store } from '../store.ts';

/** Worker timeout (15 min) plus slack for queueing and clock skew. */
export const STUCK_AFTER_MS = 20 * 60_000;

const IN_FLIGHT: ReadonlySet<DeploymentStatus> = new Set(['queued', 'running']);

function startedAt(d: DeploymentItem): number {
  return Date.parse(d.startedAt ?? d.createdAt);
}

/** In-flight deployments of `stage` that started before the cutoff (pure). */
export function stuckDeployments(
  deployments: ReadonlyArray<DeploymentItem>,
  stage: string,
  now: number,
): DeploymentItem[] {
  const cutoff = now - STUCK_AFTER_MS;
  return deployments.filter((d) => d.stage === stage && IN_FLIGHT.has(d.status) && startedAt(d) < cutoff);
}

/** Stages left in `deploying` since before the cutoff (pure). */
export function suspectStages(stages: ReadonlyArray<StageItem>, now: number): StageItem[] {
  const cutoff = now - STUCK_AFTER_MS;
  return stages.filter((s) => s.status === 'deploying' && Date.parse(s.updatedAt) < cutoff);
}

export class Watchdog extends Context.Service<
  Watchdog,
  {
    /** Fails stuck deployments and frees their stages; answers `app/stage/id` of each failed deployment. */
    readonly run: Effect.Effect<{ readonly failed: ReadonlyArray<string> }>;
  }
>()('@ericminassian/platform-control-plane/Watchdog') {
  static readonly layer: Layer.Layer<Watchdog, never, Store> = Layer.effect(
    Watchdog,
    Effect.gen(function* () {
      const store = yield* Store;

      const run = Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const failed: string[] = [];
        for (const stage of suspectStages(yield* store.listAllStages, now)) {
          const deployments = yield* store.listDeployments(stage.app);
          // A newer deployment that is still within its time budget owns the stage.
          const fresh = deployments.some(
            (d) => d.stage === stage.stage && IN_FLIGHT.has(d.status) && startedAt(d) >= now - STUCK_AFTER_MS,
          );
          if (fresh) continue;
          for (const d of stuckDeployments(deployments, stage.stage, now)) {
            const marked = yield* store.updateDeployment(
              d.app,
              d.id,
              {
                status: 'failed',
                finishedAt: new Date(now).toISOString(),
                error:
                  'the deploy job stopped without finishing (worker timeout or crash); redeploy to retry',
              },
              d.status,
            );
            if (marked) failed.push(`${d.app}/${d.stage}/${d.id}`);
          }
          yield* store.updateStage(stage.app, stage.stage, {
            status: stage.currentDeployment ? 'active' : 'failed',
          });
          yield* Effect.logWarning('recovered a stuck stage').pipe(
            Effect.annotateLogs({ app: stage.app, stage: stage.stage }),
          );
        }
        return { failed };
      }).pipe(Effect.withSpan('Watchdog.run'));

      return Watchdog.of({ run });
    }),
  );
}
