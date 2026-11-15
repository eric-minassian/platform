/** Data browser, storage, secrets, and job controls (run cron, redrive DLQ). */
import { ENV_NAME_PATTERN } from '@ericminassian/platform-core';
import { Hono } from 'hono';
import type { AuthEnv } from '../auth.ts';
import { listCollections, listItems, listStorage, storageDownloadUrl } from '../data.ts';
import { ApiError, badRequest, notFound } from '../errors.ts';
import { redrive, runCron } from '../jobs/queues.ts';
import { deleteSecret, listSecrets, putSecret } from '../secrets.ts';
import { liveManifest, memberApp, readJson, stageParam } from './context.ts';

/** `?scope=shared` targets the app-wide value; otherwise the stage (`?stage=`, default prod). */
function secretStage(c: Parameters<typeof stageParam>[0]): string | undefined {
  return c.req.query('scope') === 'shared' ? undefined : stageParam(c);
}

export const manage = new Hono<AuthEnv>()
  .get('/:app/data/collections', async (c) => {
    const { app } = await memberApp(c);
    return c.json(await listCollections(app.name, stageParam(c)));
  })
  .get('/:app/data/items', async (c) => {
    const { app } = await memberApp(c);
    const collection = c.req.query('collection');
    if (!collection) throw badRequest('collection is required');
    return c.json(
      await listItems({
        app: app.name,
        stage: stageParam(c),
        collection,
        ...(c.req.query('partition') ? { partition: c.req.query('partition')! } : {}),
        ...(c.req.query('cursor') ? { cursor: c.req.query('cursor')! } : {}),
        ...(c.req.query('limit') ? { limit: Number(c.req.query('limit')) } : {}),
      }),
    );
  })
  .get('/:app/storage', async (c) => {
    const { app } = await memberApp(c);
    const stage = stageParam(c);
    const store = c.req.query('store');
    if (!store) {
      const m = await liveManifest(app.name, stage);
      return c.json({ stores: m?.storage ?? [] });
    }
    return c.json(
      await listStorage({
        app: app.name,
        stage,
        store,
        ...(c.req.query('prefix') ? { prefix: c.req.query('prefix')! } : {}),
        ...(c.req.query('cursor') ? { cursor: c.req.query('cursor')! } : {}),
      }),
    );
  })
  .get('/:app/storage/url', async (c) => {
    const { app } = await memberApp(c);
    const store = c.req.query('store');
    const key = c.req.query('key');
    if (!store || !key) throw badRequest('store and key are required');
    return c.json({ url: await storageDownloadUrl({ app: app.name, stage: stageParam(c), store, key }) });
  })
  .get('/:app/secrets', async (c) => {
    const { app } = await memberApp(c);
    const stage = stageParam(c);
    const [set, m] = await Promise.all([listSecrets(app.name, stage), liveManifest(app.name, stage)]);
    const declared = m?.secrets ?? [];
    return c.json({
      secrets: set,
      declared,
      missing: declared.filter((n) => !set.some((s) => s.name === n)),
    });
  })
  .put('/:app/secrets/:name', async (c) => {
    const { app } = await memberApp(c);
    const name = c.req.param('name');
    if (!ENV_NAME_PATTERN.test(name)) throw badRequest(`secret names must match ${ENV_NAME_PATTERN}`);
    const body = await readJson<{ value?: string }>(c);
    if (typeof body.value !== 'string' || body.value.length === 0) throw badRequest('value is required');
    if (body.value.length > 4096) throw badRequest('secret values are limited to 4 KB');
    await putSecret(app.name, name, body.value, secretStage(c));
    return c.body(null, 204);
  })
  .delete('/:app/secrets/:name', async (c) => {
    const { app } = await memberApp(c);
    await deleteSecret(app.name, c.req.param('name'), secretStage(c));
    return c.body(null, 204);
  })
  .post('/:app/crons/:name/run', async (c) => {
    const { app } = await memberApp(c);
    const stage = stageParam(c);
    const name = c.req.param('name');
    const m = await liveManifest(app.name, stage);
    if (!m?.crons[name]) throw notFound(`cron ${name} on ${stage}`);
    await runCron(app.name, stage, name);
    return c.json({ started: name }, 202);
  })
  .post('/:app/queues/:name/redrive', async (c) => {
    const { app } = await memberApp(c);
    const stage = stageParam(c);
    const name = c.req.param('name');
    const m = await liveManifest(app.name, stage);
    if (!m?.queues[name]) throw notFound(`queue ${name} on ${stage}`);
    try {
      return c.json({ taskHandle: await redrive(app.name, stage, name) }, 202);
    } catch (err) {
      throw new ApiError(409, 'redrive_failed', err instanceof Error ? err.message : String(err));
    }
  });
