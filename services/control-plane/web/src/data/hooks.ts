/** Reads of an app's summary and its stage's live manifest, shared by the shell and the pages. */
import { useAtomValue } from '@effect/atom-react';
import type {
  AppSummary,
  DeploymentRecord,
  ResolvedManifest,
  StageRecord,
} from '@ericminassian/platform-core';
import { Option } from 'effect';
import { AsyncResult, Atom } from 'effect/reactivity';
import { appAtom, deploymentAtom } from './atoms.ts';

/** Stands in for a query that has nothing to ask yet (no app, no live deployment). */
const nothing = Atom.make(AsyncResult.initial());

export function useAppSummary(app: string | undefined) {
  return useAtomValue(app ? appAtom(app) : nothing);
}

export function stageOf(summary: AppSummary | undefined, stage: string): StageRecord | undefined {
  return summary?.stages.find((s) => s.stage === stage);
}

/** The manifest of the stage's live deployment, once both are loaded. */
export function useLiveManifest(app: string | undefined, stage: string): ResolvedManifest | undefined {
  const summary = Option.getOrUndefined(AsyncResult.value(useAppSummary(app)));
  const deployment = stageOf(summary, stage)?.currentDeployment;
  return useDeploymentManifest(deployment);
}

/** A deployment by id, once loaded (nothing is fetched without an id). */
export function useDeployment(id: string | undefined): DeploymentRecord | undefined {
  return Option.getOrUndefined(AsyncResult.value(useAtomValue(id ? deploymentAtom(id) : nothing)));
}

function useDeploymentManifest(id: string | undefined): ResolvedManifest | undefined {
  return useDeployment(id)?.manifest;
}
