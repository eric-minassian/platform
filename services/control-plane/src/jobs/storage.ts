/** Daily: deletes files that stores with `expireAfterDays` no longer keep. */
import { publicStores } from '@ericminassian/platform-core';
import { Clock, Context, Effect, Layer, Option } from 'effect';
import { Settings } from '../config.ts';
import { type DeployFailed, StageEngine } from '../deploy.ts';
import { type StageItem, Store } from '../store.ts';

/** Stages whose live deployment's stores may hold files to expire (pure). */
export function liveStages(stages: ReadonlyArray<StageItem>): StageItem[] {
  return stages.filter((s) => s.currentDeployment && s.status !== 'destroying' && s.status !== 'destroyed');
}

export class StorageExpiry extends Context.Service<
  StorageExpiry,
  {
    /**
     * Goes through every live stage. Answers how many files it deleted, by
     * `app/stage/store`. A stage that fails doesn't stop the others; the run
     * fails afterwards, so it shows as a failed job.
     */
    readonly run: Effect.Effect<{ readonly deleted: Readonly<Record<string, number>> }, DeployFailed>;
  }
>()('@ericminassian/platform-control-plane/StorageExpiry') {
  static readonly layer: Layer.Layer<StorageExpiry, never, Settings | StageEngine | Store> = Layer.effect(
    StorageExpiry,
    Effect.gen(function* () {
      const settings = yield* Settings;
      const engine = yield* StageEngine;
      const store = yield* Store;

      const run = Effect.gen(function* () {
        const platform = yield* settings.runtime;
        const now = new Date(yield* Clock.currentTimeMillis);
        const deleted: Record<string, number> = {};
        const failures: DeployFailed[] = [];
        for (const stage of liveStages(yield* store.listAllStages)) {
          const deployment = yield* store.getDeployment(stage.currentDeployment!);
          const manifest = Option.getOrUndefined(Option.flatMapNullishOr(deployment, (d) => d.manifest));
          if (!manifest?.storage.some((s) => manifest.storageOptions[s]?.expireAfterDays)) continue;
          const result = yield* engine
            .expireStorage({ app: stage.app, stage: stage.stage, platform, manifest, now })
            .pipe(Effect.result);
          if (result._tag === 'Failure') {
            failures.push(result.failure);
            yield* Effect.logError('could not expire files').pipe(
              Effect.annotateLogs({ app: stage.app, stage: stage.stage, error: result.failure.message }),
            );
            continue;
          }
          for (const [name, n] of Object.entries(result.success)) {
            deleted[`${stage.app}/${stage.stage}/${name}`] = n;
            if (n) {
              yield* Effect.logInfo('deleted expired files').pipe(
                Effect.annotateLogs({
                  app: stage.app,
                  stage: stage.stage,
                  store: name,
                  public: publicStores(manifest).includes(name),
                  files: n,
                }),
              );
            }
          }
        }
        if (failures[0]) return yield* failures[0];
        return { deleted };
      }).pipe(Effect.withSpan('StorageExpiry.run'));

      return StorageExpiry.of({ run });
    }),
  );
}
