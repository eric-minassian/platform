import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { invokeJob } from '@ericminassian/platform/worker';
import {
  type ArtifactFile,
  type CreateDeploymentRequest,
  type CreateDeploymentResponse,
  isPreviewStage,
  ManifestError,
  names,
  newDeploymentId,
  PROD_STAGE,
  type PresignedPost,
  parseManifest,
  publicUrl,
  stageHost,
} from '@ericminassian/platform-core';
import { Hono } from 'hono';
import type { AuthEnv } from '../auth.ts';
import { actorOf } from '../authz.ts';
import { aws } from '../aws.ts';
import { config, getRuntimeConfig } from '../config.ts';
import { ApiError, badRequest, notFound } from '../errors.ts';
import { callWorker } from '../jobs/call.ts';
import {
  createDeployment,
  type DeploymentItem,
  getDeployment,
  getStage,
  listDeployments,
  listStages,
  putStage,
  updateDeployment,
  updateStage,
} from '../store.ts';
import { memberApp, readJson, stageApp } from './context.ts';

const UPLOADABLE: readonly ArtifactFile[] = ['server.zip', 'worker.zip', 'static.zip'];
const MAX_ARTIFACT_BYTES = 250 * 1024 * 1024;

/** Strips internal fields (route, revision) from what the API returns. */
const publicDeployment = ({ route: _r, revisionId: _v, ...d }: DeploymentItem) => d;

export const stages = new Hono<AuthEnv>()
  .get('/:app/stages', async (c) => {
    const { app } = await memberApp(c);
    const all = await listStages(app.name);
    return c.json(all.map(({ route: _r, previousRoute: _p, ...s }) => s));
  })
  .delete('/:app/stages/:stage', async (c) => {
    const stage = c.req.param('stage');
    const app = await stageApp(c, c.req.param('app'), stage);
    if (stage === PROD_STAGE) {
      if (c.get('principal').kind !== 'member')
        throw new ApiError(403, 'forbidden', 'prod can only be destroyed by a member');
      if (c.req.query('confirm') !== app.name) throw badRequest(`destroying prod needs ?confirm=${app.name}`);
    }
    const st = await getStage(app.name, stage);
    if (!st || st.status === 'destroyed') return c.json({ status: 'destroyed' });
    await updateStage(app.name, stage, { status: 'destroying' });
    await invokeJob('destroy', { app: app.name, stage });
    return c.json({ status: 'destroying' }, 202);
  })
  .post('/:app/stages/:stage/rollback', async (c) => {
    const { app } = await memberApp(c);
    const body = (await c.req.json().catch(() => ({}))) as { deploymentId?: string };
    try {
      const live = await callWorker<string>('rollback', {
        app: app.name,
        stage: c.req.param('stage'),
        ...(body.deploymentId ? { deploymentId: body.deploymentId } : {}),
      });
      return c.json({ currentDeployment: live });
    } catch (err) {
      throw new ApiError(409, 'rollback_failed', err instanceof Error ? err.message : String(err));
    }
  })
  .get('/:app/deployments', async (c) => {
    const { app } = await memberApp(c);
    const stage = c.req.query('stage');
    const limit = Math.min(Number(c.req.query('limit') ?? 50) || 50, 200);
    const list = await listDeployments(app.name, stage ? 200 : limit);
    return c.json(
      list
        .filter((d) => !stage || d.stage === stage)
        .slice(0, limit)
        // List view: drop the event log and manifest (fetch one deployment for those).
        .map(({ events: _e, manifest: _m, route: _r, revisionId: _v, ...d }) => ({ ...d, events: [] })),
    );
  })
  .post('/:app/deployments', async (c) => {
    const body = await readJson<CreateDeploymentRequest>(c);
    const stage = String(body.stage ?? '');
    const app = await stageApp(c, c.req.param('app'), stage);

    let manifest: ReturnType<typeof parseManifest>;
    try {
      manifest = parseManifest(body.manifest);
    } catch (err) {
      if (err instanceof ManifestError) throw new ApiError(422, 'invalid_manifest', err.message);
      throw err;
    }
    if (manifest.name !== app.name)
      throw badRequest(`platform.json name "${manifest.name}" must be "${app.name}"`);

    // manifest.json is always uploaded; tolerate clients that list it.
    const files = [...new Set(body.files ?? [])].filter((f) => f !== 'manifest.json');
    for (const f of files) if (!UPLOADABLE.includes(f)) throw badRequest(`unknown artifact ${f}`);

    const existing = await listStages(app.name);
    const active = existing.filter((s) => s.status !== 'destroyed' && s.stage !== stage);
    if (
      !existing.some((s) => s.stage === stage && s.status !== 'destroyed') &&
      active.length >= config.limits.stagesPerApp
    ) {
      throw new ApiError(
        429,
        'limit',
        `${app.name} already has ${active.length} stages (limit ${config.limits.stagesPerApp})`,
      );
    }

    const platform = await getRuntimeConfig();
    const id = newDeploymentId();
    const p = c.get('principal');
    const deployment: DeploymentItem = {
      id,
      app: app.name,
      stage,
      status: 'awaiting_upload',
      actor: actorOf(p),
      ...(body.commit
        ? { commit: String(body.commit).slice(0, 64) }
        : p.kind === 'ci' && p.sha
          ? { commit: p.sha }
          : {}),
      ...(body.ref ? { ref: String(body.ref).slice(0, 200) } : p.kind === 'ci' ? { ref: p.ref } : {}),
      ...(body.message ? { message: String(body.message).slice(0, 500) } : {}),
      manifest,
      events: [],
      createdAt: new Date().toISOString(),
    };
    await createDeployment(deployment);

    const uploads: Partial<Record<ArtifactFile, PresignedPost>> = {};
    for (const file of ['manifest.json', ...files] as ArtifactFile[]) {
      const post = await createPresignedPost(aws.s3(), {
        Bucket: platform.artifactsBucket,
        Key: names.artifactKey(app.name, stage, id, file),
        Conditions: [['content-length-range', 1, MAX_ARTIFACT_BYTES]],
        Expires: 900,
      });
      uploads[file] = { url: post.url, fields: post.fields };
    }
    const res: CreateDeploymentResponse = { deployment: publicDeployment(deployment), uploads };
    return c.json(res, 201);
  });

export const deployments = new Hono<AuthEnv>()
  .get('/:id', async (c) => {
    const dep = await getDeployment(c.req.param('id'));
    if (!dep) throw notFound('deployment');
    await stageApp(c, dep.app, dep.stage);
    return c.json(publicDeployment(dep));
  })
  .post('/:id/start', async (c) => {
    const dep = await getDeployment(c.req.param('id'));
    if (!dep) throw notFound('deployment');
    const app = await stageApp(c, dep.app, dep.stage);
    if (dep.status !== 'awaiting_upload')
      throw new ApiError(409, 'already_started', `deployment is ${dep.status}`);

    const platform = await getRuntimeConfig();
    await aws
      .s3()
      .send(
        new HeadObjectCommand({
          Bucket: platform.artifactsBucket,
          Key: names.artifactKey(dep.app, dep.stage, dep.id, 'manifest.json'),
        }),
      )
      .catch(() => {
        throw badRequest('manifest.json was not uploaded');
      });

    if (!(await updateDeployment(dep.app, dep.id, { status: 'queued' }, 'awaiting_upload'))) {
      throw new ApiError(409, 'already_started', 'deployment was started concurrently');
    }
    const now = new Date().toISOString();
    const st = await getStage(app.name, dep.stage);
    if (!st || st.status === 'destroyed') {
      const host = stageHost(app.name, dep.stage, platform.domain);
      await putStage({
        app: app.name,
        stage: dep.stage,
        host,
        url: publicUrl(platform, host),
        status: 'deploying',
        preview: isPreviewStage(dep.stage),
        createdAt: now,
        updatedAt: now,
      });
    } else {
      await updateStage(app.name, dep.stage, { status: 'deploying' });
    }
    await invokeJob('deploy', { id: dep.id });
    return c.json(publicDeployment({ ...dep, status: 'queued' }), 202);
  });
