/**
 * Item layout of the `platform` state table. Pure (no AWS clients) so the
 * foundation can register the control plane's own deployment with the same
 * keys the store reads.
 *
 *   pk              sk                gsi1pk        gsi1sk           what
 *   APP#<name>      META              APPS          <name>           AppRecord
 *   APP#<name>      STAGE#<stage>     STAGES        <name>#<stage>   StageItem
 *   APP#<name>      DEP#<id>          DEP#<id>      DEP              DeploymentItem
 *
 * Required table schema (created by the foundation): string keys `pk`/`sk`,
 * GSI `gsi1` on `gsi1pk`/`gsi1sk` projecting ALL.
 */
import type { AppRecord, DeploymentRecord, RouteRecord, StageRecord } from '@eric-minassian/platform-core';

/** Stage record plus what rollback needs. */
export interface StageItem extends StageRecord {
  route?: RouteRecord;
  previousRoute?: RouteRecord;
  /** Last uptime check result (prod), used for up/down transition alerts. */
  up?: boolean;
  upChangedAt?: string;
  /** Consecutive failed uptime checks. */
  failures?: number;
}

/** Deployment record plus what a later rollback to it needs. */
export interface DeploymentItem extends DeploymentRecord {
  route?: RouteRecord;
  revisionId?: string;
}

export const appKey = (name: string) => ({ pk: `APP#${name}`, sk: 'META' });
export const stageKey = (app: string, stage: string) => ({ pk: `APP#${app}`, sk: `STAGE#${stage}` });
export const deploymentKey = (app: string, id: string) => ({ pk: `APP#${app}`, sk: `DEP#${id}` });

export function appItem(app: AppRecord) {
  return { ...appKey(app.name), gsi1pk: 'APPS', gsi1sk: app.name, ...app };
}

export function stageItem(stage: StageItem) {
  return {
    ...stageKey(stage.app, stage.stage),
    gsi1pk: 'STAGES',
    gsi1sk: `${stage.app}#${stage.stage}`,
    ...stage,
  };
}

export function deploymentItem(dep: DeploymentItem) {
  return { ...deploymentKey(dep.app, dep.id), gsi1pk: `DEP#${dep.id}`, gsi1sk: 'DEP', ...dep };
}
