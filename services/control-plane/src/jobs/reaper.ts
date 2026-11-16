/** Daily: destroys preview stages nobody has deployed to for `previewTtlDays`. */
import { isPreviewStage } from '@ericminassian/platform-core';
import { Clock, Context, Effect, Layer } from 'effect';
import { Settings } from '../config.ts';
import { type StageItem, Store } from '../store.ts';
import { WorkerJobs } from './call.ts';

/** Live preview stages last updated before the TTL (pure). */
export function stalePreviews(stages: ReadonlyArray<StageItem>, ttlDays: number, now: number): StageItem[] {
  const cutoff = now - ttlDays * 86_400_000;
  return stages.filter(
    (s) =>
      isPreviewStage(s.stage) &&
      (s.status === 'active' || s.status === 'failed') &&
      Date.parse(s.updatedAt) < cutoff,
  );
}

export class Reaper extends Context.Service<
  Reaper,
  {
    /** Queues a destroy for each stale preview; answers `app/stage` of each. */
    readonly run: Effect.Effect<{ readonly destroyed: ReadonlyArray<string> }>;
  }
>()('@ericminassian/platform-control-plane/Reaper') {
  static readonly layer: Layer.Layer<Reaper, never, Settings | Store | WorkerJobs> = Layer.effect(
    Reaper,
    Effect.gen(function* () {
      const settings = yield* Settings;
      const store = yield* Store;
      const jobs = yield* WorkerJobs;

      const run = Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const stale = stalePreviews(yield* store.listAllStages, settings.platform.previewTtlDays, now);
        for (const s of stale) {
          yield* Effect.logInfo('reaping stale preview').pipe(
            Effect.annotateLogs({ app: s.app, stage: s.stage, updatedAt: s.updatedAt }),
          );
          yield* store.updateStage(s.app, s.stage, { status: 'destroying' });
          yield* jobs.start({ kind: 'destroy', app: s.app, stage: s.stage });
        }
        return { destroyed: stale.map((s) => `${s.app}/${s.stage}`) };
      }).pipe(Effect.withSpan('Reaper.run'));

      return Reaper.of({ run });
    }),
  );
}
