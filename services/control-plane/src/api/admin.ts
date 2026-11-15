/** Admin-only overview: members, app/stage counts, platform-wide cost. */
import { Hono } from 'hono';
import { type AuthEnv, requireAdmin } from '../auth.ts';
import { config } from '../config.ts';
import { PLATFORM_COST_KEY, TOTAL_COST_KEY } from '../jobs/cost.ts';
import { listAllStages, listApps } from '../store.ts';
import { readCost } from '../telemetry/query.ts';

export const admin = new Hono<AuthEnv>().get('/overview', async (c) => {
  requireAdmin(c);
  const [apps, stages, total, shared] = await Promise.all([
    listApps(),
    listAllStages(),
    readCost(TOTAL_COST_KEY).catch(() => null),
    readCost(PLATFORM_COST_KEY).catch(() => null),
  ]);
  const live = stages.filter((s) => s.status !== 'destroyed');
  return c.json({
    members: config.members,
    limits: config.limits,
    apps: apps.length,
    stages: live.length,
    previews: live.filter((s) => s.preview).length,
    down: live.filter((s) => s.up === false).map((s) => s.app),
    cost: { total, shared },
  });
});
