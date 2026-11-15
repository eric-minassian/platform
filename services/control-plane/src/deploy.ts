/**
 * The deployer: runs one deployment through the engine and records progress.
 * Runs in the worker (`invoke.deploy`) so it gets the 15-minute timeout; the
 * API only queues it. Rollback is fast (route + revision swap), so the API
 * calls `rollbackStage` inline.
 */
import { GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { log } from '@ericminassian/platform';
import {
  type ArtifactFile,
  type DeploymentEventEntry,
  names,
  type PlatformRuntimeConfig,
  parseManifest,
} from '@ericminassian/platform-core';
import { createEngine, type DeployStageInput, type S3Location } from '@ericminassian/platform-engine';
import { aws } from './aws.ts';
import { getRuntimeConfig, logRetentionDays } from './config.ts';
import { waitForEdge } from './edge.ts';
import { appendDeploymentEvents, getDeployment, getStage, updateDeployment, updateStage } from './store.ts';

const now = () => new Date().toISOString();

/** Buffers engine log lines and appends them to the deployment record in small batches. */
class EventLog {
  private pending: DeploymentEventEntry[] = [];
  private timer: NodeJS.Timeout | undefined;
  private chain: Promise<void> = Promise.resolve();
  private readonly app: string;
  private readonly id: string;
  constructor(app: string, id: string) {
    this.app = app;
    this.id = id;
  }
  push(e: Omit<DeploymentEventEntry, 'ts'>): void {
    this.pending.push({ ts: Date.now(), ...e });
    if (this.pending.length >= 20) void this.flush();
    else this.timer ??= setTimeout(() => void this.flush(), 1_500);
  }
  flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    const batch = this.pending.splice(0);
    this.chain = this.chain
      .then(() => appendDeploymentEvents(this.app, this.id, batch))
      .catch((err) => log.warn('failed to record deployment events', { err: String(err) }));
    return this.chain;
  }
}

async function readText(bucket: string, key: string): Promise<string> {
  const res = await aws.s3().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return (await res.Body?.transformToString()) ?? '';
}

async function locate(bucket: string, key: string): Promise<S3Location | undefined> {
  try {
    const head = await aws.s3().send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return { bucket, key, ...(head.VersionId ? { versionId: head.VersionId } : {}) };
  } catch (err) {
    const name = (err as { name?: string }).name;
    if (name === 'NotFound' || name === 'NoSuchKey') return undefined;
    throw err;
  }
}

export async function findArtifacts(
  platform: PlatformRuntimeConfig,
  app: string,
  stage: string,
  id: string,
): Promise<DeployStageInput['artifacts']> {
  const files: Array<[keyof DeployStageInput['artifacts'], ArtifactFile]> = [
    ['server', 'server.zip'],
    ['worker', 'worker.zip'],
    ['static', 'static.zip'],
  ];
  const found = await Promise.all(
    files.map(
      async ([slot, file]) =>
        [slot, await locate(platform.artifactsBucket, names.artifactKey(app, stage, id, file))] as const,
    ),
  );
  const artifacts: DeployStageInput['artifacts'] = {};
  for (const [slot, loc] of found) if (loc) artifacts[slot] = loc;
  return artifacts;
}

export async function runDeployment(id: string): Promise<void> {
  const dep = await getDeployment(id);
  if (!dep) {
    log.warn('deploy job for unknown deployment', { id });
    return;
  }
  // Idempotent under Lambda async retries: only one run moves it out of `queued`.
  if (!(await updateDeployment(dep.app, id, { status: 'running', startedAt: now() }, 'queued'))) {
    log.info('deployment already handled', { id, status: dep.status });
    return;
  }
  const { app, stage } = dep;
  const events = new EventLog(app, id);
  const before = await getStage(app, stage);
  try {
    const platform = await getRuntimeConfig();
    events.push({ level: 'info', msg: `deploying ${app} to ${stage}` });
    const raw = await readText(platform.artifactsBucket, names.artifactKey(app, stage, id, 'manifest.json'));
    // `plat build` writes { manifest, resolved, build }; accept a bare manifest too.
    const doc = JSON.parse(raw) as { manifest?: unknown };
    const manifest = parseManifest(doc.manifest ?? doc);
    if (manifest.name !== app)
      throw new Error(`platform.json name "${manifest.name}" does not match app "${app}"`);
    const artifacts = await findArtifacts(platform, app, stage, id);
    if (manifest.web?.server && !artifacts.server)
      throw new Error('manifest declares web.server but server.zip was not uploaded');
    if (manifest.worker && !artifacts.worker)
      throw new Error('manifest needs a worker but worker.zip was not uploaded');

    const engine = createEngine({
      region: platform.region,
      log: (e) => {
        events.push(e);
        log.info(e.msg, { deployment: id, ...(e.resource ? { resource: e.resource } : {}) });
      },
    });
    const result = await engine.deployStage({
      manifest,
      stage,
      deploymentId: id,
      platform,
      artifacts,
      webMode: 'function',
      logRetentionDays: logRetentionDays(stage),
    });

    await updateStage(app, stage, {
      status: 'active',
      host: result.host,
      url: result.url,
      currentDeployment: id,
      previousDeployment: before?.currentDeployment,
      currentRevision: result.webFunction?.revisionId,
      previousRevision: before?.currentRevision,
      route: result.route,
      previousRoute: before?.route,
    });
    if (result.webFunction) {
      events.push({ level: 'info', msg: 'waiting for the edge to serve this deployment' });
      await events.flush();
      const served = await waitForEdge(result.url, id);
      events.push(
        served
          ? { level: 'info', msg: 'edge is serving this deployment' }
          : {
              level: 'warn',
              msg: 'the edge was not serving this deployment after 90s; it should catch up shortly',
            },
      );
    }
    events.push({ level: 'info', msg: `live at ${result.url}` });
    await events.flush();
    await updateDeployment(app, id, {
      status: 'succeeded',
      finishedAt: now(),
      url: result.url,
      manifest,
      route: result.route,
      revisionId: result.webFunction?.revisionId,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('deployment failed', { id, err });
    events.push({ level: 'error', msg: message });
    await events.flush();
    await updateDeployment(app, id, { status: 'failed', finishedAt: now(), error: message });
    // The previous deployment (if any) is still live: failures never flip the route.
    await updateStage(app, stage, { status: before?.currentDeployment ? 'active' : 'failed' });
  }
}

export async function runDestroy(app: string, stage: string): Promise<void> {
  const platform = await getRuntimeConfig();
  const engine = createEngine({
    region: platform.region,
    log: (e) => log.info(e.msg, { app, stage, ...(e.resource ? { resource: e.resource } : {}) }),
  });
  try {
    await engine.destroyStage({ app, stage, platform, keepData: stage === 'prod' });
    await updateStage(app, stage, { status: 'destroyed', route: undefined, previousRoute: undefined });
  } catch (err) {
    log.error('destroy failed', { app, stage, err });
    await updateStage(app, stage, { status: 'failed' });
    throw err;
  }
}

/** Points a stage back at an earlier successful deployment (default: the previous one). */
export async function rollback(app: string, stage: string, toDeploymentId?: string): Promise<string> {
  const current = await getStage(app, stage);
  if (!current?.currentDeployment) throw new Error(`${app}/${stage} has no live deployment`);
  const targetId = toDeploymentId ?? current.previousDeployment;
  if (!targetId) throw new Error(`${app}/${stage} has no previous deployment to roll back to`);
  if (targetId === current.currentDeployment) throw new Error(`${targetId} is already live`);
  const target = await getDeployment(targetId);
  if (!target || target.app !== app || target.stage !== stage)
    throw new Error(`deployment ${targetId} is not part of ${app}/${stage}`);
  if (!target.route) throw new Error(`deployment ${targetId} has no recorded route (it never went live)`);

  const platform = await getRuntimeConfig();
  const engine = createEngine({ region: platform.region });
  await engine.rollbackStage({
    app,
    stage,
    platform,
    route: target.route,
    ...(target.revisionId ? { revisionId: target.revisionId } : {}),
  });
  await updateStage(app, stage, {
    status: 'active',
    currentDeployment: targetId,
    previousDeployment: current.currentDeployment,
    currentRevision: target.revisionId,
    previousRevision: current.currentRevision,
    route: target.route,
    previousRoute: current.route,
    ...(target.url ? { url: target.url } : {}),
  });
  await updateDeployment(app, current.currentDeployment, { status: 'rolled_back' });
  return targetId;
}
