import type { AppRecord, ResolvedManifest } from '@ericminassian/platform-core';
import { PROD_STAGE, validateStageName } from '@ericminassian/platform-core';
import type { Context } from 'hono';
import type { AuthEnv } from '../auth.ts';
import { canAccessApp, checkStageAccess, type MemberPrincipal } from '../authz.ts';
import { config } from '../config.ts';
import { ApiError, badRequest, notFound } from '../errors.ts';
import { getApp, getDeployment, getStage } from '../store.ts';

export type Ctx = Context<AuthEnv>;

/** Loads `:app` and checks that the (member) principal may manage it. */
export async function memberApp(
  c: Ctx,
  name = c.req.param('app'),
): Promise<{ app: AppRecord; member: MemberPrincipal }> {
  const p = c.get('principal');
  if (p.kind !== 'member') throw new ApiError(403, 'members_only', 'this endpoint needs a member token');
  if (!name) throw badRequest('missing app');
  const app = await getApp(name);
  if (!app || !canAccessApp(p, app)) throw notFound(`app ${name}`);
  return { app, member: p };
}

/** Loads `:app` for a stage-scoped action; members and (rule-checked) CI runs are allowed. */
export async function stageApp(c: Ctx, name: string, stage: string): Promise<AppRecord> {
  const app = await getApp(name);
  if (!app) throw notFound(`app ${name}`);
  const p = c.get('principal');
  const decision = checkStageAccess(p, app, stage, config);
  if (!decision.ok) {
    if (p.kind === 'member' && !canAccessApp(p, app)) throw notFound(`app ${name}`);
    throw new ApiError(403, 'forbidden', decision.reason);
  }
  return app;
}

/** `?stage=` (default prod), validated. */
export function stageParam(c: Ctx): string {
  const stage = c.req.query('stage') ?? PROD_STAGE;
  const err = validateStageName(stage);
  if (err) throw badRequest(err);
  return stage;
}

/** The manifest of the deployment currently live on a stage, if any. */
export async function liveManifest(app: string, stage: string): Promise<ResolvedManifest | undefined> {
  const st = await getStage(app, stage);
  if (!st?.currentDeployment) return undefined;
  return (await getDeployment(st.currentDeployment))?.manifest;
}

export async function readJson<T>(c: Ctx): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw badRequest('body must be JSON');
  }
}
