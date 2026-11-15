import {
  type AppRecord,
  type AppSummary,
  type CreateAppRequest,
  PROD_STAGE,
  stageHost,
  validateAppName,
} from '@ericminassian/platform-core';
import { Hono } from 'hono';
import type { AuthEnv } from '../auth.ts';
import { requireMember } from '../auth.ts';
import { canAccessApp, canCreateApp } from '../authz.ts';
import { config } from '../config.ts';
import { hostConflict } from '../dns.ts';
import { ApiError, badRequest } from '../errors.ts';
import { createApp, deleteApp, getApp, listApps, listDeployments, listStages, updateApp } from '../store.ts';
import { readCost, readHealth } from '../telemetry/query.ts';
import { pool } from '../util.ts';
import { memberApp, readJson } from './context.ts';

export const REPO_PATTERN = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

export async function summarize(app: AppRecord): Promise<AppSummary> {
  const [stages, deployments, cost] = await Promise.all([
    listStages(app.name),
    listDeployments(app.name, 1),
    readCost(app.name).catch(() => undefined),
  ]);
  const prod = stages.find((s) => s.stage === PROD_STAGE && s.status === 'active');
  const health = prod ? await readHealth(app.name, prod.up ?? null).catch(() => null) : null;
  return {
    app,
    stages: stages
      .filter((s) => s.status !== 'destroyed')
      .map(({ route: _r, previousRoute: _p, up: _u, upChangedAt: _c, failures: _f, ...s }) => s),
    health,
    ...(cost ? { costMonthToDateUsd: cost.monthToDateUsd } : {}),
    ...(deployments[0] ? { lastDeployment: deployments[0] } : {}),
  };
}

export const apps = new Hono<AuthEnv>()
  .get('/', async (c) => {
    const me = requireMember(c);
    const visible = (await listApps()).filter((a) => canAccessApp(me, a));
    const out: AppSummary[] = [];
    await pool(visible, 8, async (a) => {
      out.push(await summarize(a));
    });
    out.sort((x, y) => x.app.name.localeCompare(y.app.name));
    return c.json(out);
  })
  .post('/', async (c) => {
    const me = requireMember(c);
    const body = await readJson<CreateAppRequest>(c);
    const name = String(body.name ?? '').trim();
    const repo = String(body.repo ?? '').trim();
    const nameErr = validateAppName(name, config.reservedAppNames);
    if (nameErr) throw badRequest(nameErr);
    if (!REPO_PATTERN.test(repo)) throw badRequest('repo must be "owner/name"');
    if (await getApp(name)) throw new ApiError(409, 'exists', `app ${name} already exists`);
    const mine = (await listApps()).filter(
      (a) => a.createdBy.toLowerCase() === me.github.toLowerCase(),
    ).length;
    const allowed = canCreateApp(me, mine, config);
    if (!allowed.ok) throw new ApiError(429, 'limit', allowed.reason);
    const conflict = await hostConflict(stageHost(name, PROD_STAGE, config.domain), config.edgeHost);
    if (conflict) throw new ApiError(409, 'dns_conflict', conflict);
    const record: AppRecord = {
      name,
      repo,
      ...(body.description ? { description: String(body.description).slice(0, 200) } : {}),
      owners: [me.github],
      createdBy: me.github,
      createdAt: new Date().toISOString(),
    };
    try {
      await createApp(record);
    } catch (err) {
      if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
        throw new ApiError(409, 'exists', `app ${name} already exists`);
      }
      throw err;
    }
    return c.json(record, 201);
  })
  .get('/:app', async (c) => {
    const { app } = await memberApp(c);
    return c.json(await summarize(app));
  })
  .patch('/:app', async (c) => {
    const { app } = await memberApp(c);
    const body = await readJson<Partial<Pick<AppRecord, 'description' | 'owners' | 'repo'>>>(c);
    const patch: Partial<AppRecord> = {};
    if (body.description !== undefined) patch.description = String(body.description).slice(0, 200);
    if (body.repo !== undefined) {
      if (!REPO_PATTERN.test(body.repo)) throw badRequest('repo must be "owner/name"');
      patch.repo = body.repo;
    }
    if (body.owners !== undefined) {
      if (!Array.isArray(body.owners) || body.owners.length === 0)
        throw badRequest('owners must be a non-empty list');
      patch.owners = [...new Set(body.owners.map(String))];
    }
    return c.json(await updateApp(app.name, patch));
  })
  .delete('/:app', async (c) => {
    const { app } = await memberApp(c);
    const live = (await listStages(app.name)).filter((s) => s.status !== 'destroyed');
    if (live.length) {
      throw new ApiError(409, 'has_stages', `destroy stages first: ${live.map((s) => s.stage).join(', ')}`);
    }
    await deleteApp(app.name);
    return c.body(null, 204);
  });
