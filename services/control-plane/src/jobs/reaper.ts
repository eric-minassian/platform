/** Daily: destroys preview stages nobody has deployed to for `previewTtlDays`. */
import { log } from '@ericminassian/platform';
import { invokeJob } from '@ericminassian/platform/worker';
import { isPreviewStage } from '@ericminassian/platform-core';
import { config } from '../config.ts';
import { listAllStages, type StageItem, updateStage } from '../store.ts';

export function stalePreviews(stages: readonly StageItem[], ttlDays: number, now = Date.now()): StageItem[] {
  const cutoff = now - ttlDays * 86_400_000;
  return stages.filter(
    (s) =>
      isPreviewStage(s.stage) &&
      (s.status === 'active' || s.status === 'failed') &&
      Date.parse(s.updatedAt) < cutoff,
  );
}

export async function runReaper(): Promise<{ destroyed: string[] }> {
  const stale = stalePreviews(await listAllStages(), config.previewTtlDays);
  for (const s of stale) {
    log.info('reaping stale preview', { app: s.app, stage: s.stage, updatedAt: s.updatedAt });
    await updateStage(s.app, s.stage, { status: 'destroying' });
    await invokeJob('destroy', { app: s.app, stage: s.stage });
  }
  return { destroyed: stale.map((s) => `${s.app}/${s.stage}`) };
}
