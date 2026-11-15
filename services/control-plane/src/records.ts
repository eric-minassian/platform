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
import { type AppRecord, DeploymentRecord, StageRecord } from '@ericminassian/platform-core';
import { Schema } from 'effect';

/** A route record (`RouteRecord` in core) as the store keeps it, for rollbacks. */
const StoredRoute = Schema.Struct({
  v: Schema.Literal(1),
  app: Schema.String,
  stage: Schema.String,
  d: Schema.String,
  o: Schema.optional(Schema.String),
  s: Schema.optional(Schema.String),
  r: Schema.optional(Schema.Array(Schema.String)),
  spa: Schema.optional(Schema.Literals([0, 1])),
});

/** Stage record plus what rollback and the uptime pinger need. */
export const StageItem = Schema.Struct({
  ...StageRecord.fields,
  route: Schema.optional(StoredRoute),
  previousRoute: Schema.optional(StoredRoute),
  /** Last uptime check result (prod), used for up/down transition alerts. */
  up: Schema.optional(Schema.Boolean),
  upChangedAt: Schema.optional(Schema.String),
  /** Consecutive failed uptime checks. */
  failures: Schema.optional(Schema.Finite),
  /** Whether SES had paused the stage's sending at the last check (prod stages that send email). */
  emailPaused: Schema.optional(Schema.Boolean),
  /** When `emailPaused` last changed. */
  emailChangedAt: Schema.optional(Schema.String),
});
export type StageItem = typeof StageItem.Type;

/** Deployment record plus what a later rollback to it needs. */
export const DeploymentItem = Schema.Struct({
  ...DeploymentRecord.fields,
  route: Schema.optional(StoredRoute),
  revisionId: Schema.optional(Schema.String),
});
export type DeploymentItem = typeof DeploymentItem.Type;

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
