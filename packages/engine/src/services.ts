import {
  CONTAINER_BASE_IMAGE,
  type ContainersRuntimeConfig,
  isPreviewStage,
  names,
  platformNames,
  type ResolvedManifest,
  SERVICE_ENV,
  TAGS,
} from '@ericminassian/platform-core';
import { unzipSync } from 'fflate';
import { deleteImages, ensureBaseImage, listImages, pushImage } from './drivers/ecr.ts';
import {
  deleteService,
  deleteTaskDefinitions,
  describeTaskDefinition,
  ensureService,
  getService,
  listServices,
  listTaskDefinitionArns,
  listTaskDefinitionFamilies,
  listTaskDefinitions,
  listTasks,
  newestDeployment,
  RolloutError,
  type RolloutFailure,
  registerTaskDefinition,
  restartService,
  setDesiredCount,
  setTaskDefinition,
  shortTaskDefinition,
  waitForRollout,
} from './drivers/ecs.ts';
import { getObjectBytes } from './drivers/s3.ts';
import {
  deleteSchedule,
  ensureOneShotSchedule,
  ensureScheduleGroup,
  getOneShotScheduleTime,
} from './drivers/scheduler.ts';
import type {
  ControlServiceInput,
  DeployedService,
  ResourceRef,
  RollbackStageInput,
  S3Location,
  ServiceRuntimeState,
  StageServicesInput,
} from './index.ts';
import { type EngineContext, mapLimit, stageTags } from './util.ts';

/**
 * A stage's long-running services: one ECS service per declared service,
 * running the image built from the deployment's `services.zip` with the
 * stage's bindings and role. Built on the generic image, ECS and scheduler
 * drivers; `stage.ts` calls these at the right points of a deploy.
 */

type ServiceConfig = ResolvedManifest['services'][string];

/** How long a deploy waits for every service's rollout. */
export const ROLLOUT_TIMEOUT_MS = 6 * 60_000;

/** EventBridge Scheduler's universal target for ECS UpdateService (a preview's stop schedule). */
const UPDATE_SERVICE_TARGET = 'arn:aws:scheduler:::aws-sdk:ecs:updateService';

/** The stage has no service by that name (the control plane answers 404). */
export class ServiceNotFoundError extends Error {
  override readonly name = 'ServiceNotFoundError';
  readonly service: string;
  constructor(service: string, app: string, stage: string) {
    super(`${app}/${stage} has no service ${service}`);
    this.service = service;
  }
}

/** A preview runs a service for `previewMinutes` after each deploy (never when 0); other stages always. */
export function deployDesiredCount(stage: string, service: Pick<ServiceConfig, 'previewMinutes'>): number {
  return isPreviewStage(stage) && service.previewMinutes <= 0 ? 0 : 1;
}

/** When a deploy's stop schedule scales the service to zero: previews with minutes only. */
export function deployStopTime(
  stage: string,
  service: Pick<ServiceConfig, 'previewMinutes'>,
  now: Date,
): Date | undefined {
  if (!isPreviewStage(stage) || service.previewMinutes <= 0) return undefined;
  return minutesFrom(now, service.previewMinutes);
}

/** `now + minutes`, to the second (Scheduler's one-shot resolution). */
function minutesFrom(now: Date, minutes: number): Date {
  return new Date(Math.floor((now.getTime() + minutes * 60_000) / 1000) * 1000);
}

function stagePrefix(app: string, stage: string): string {
  return `${names.base(app, stage)}--`;
}

/** The manifest key of a stage's ECS service or task definition family, or undefined if it isn't one. */
function serviceKey(prefix: string, name: string | undefined): string | undefined {
  if (!name?.startsWith(prefix)) return undefined;
  const key = name.slice(prefix.length);
  // Keys can't contain `--`, so anything that does isn't a service's.
  return key && !key.includes('--') ? key : undefined;
}

function stopTarget(containers: ContainersRuntimeConfig, service: string) {
  return {
    arn: UPDATE_SERVICE_TARGET,
    roleArn: containers.schedulerRoleArn,
    input: JSON.stringify({ Cluster: containers.cluster, Service: service, DesiredCount: 0 }),
  };
}

// ------------------------------------------------------------------ deploy

export interface ServiceRollout {
  /** Manifest key. */
  name: string;
  /** ECS service name. */
  service: string;
  taskDefinition: string;
  /** What the service ran before this deploy (none for a new service). */
  previousTaskDefinition?: string;
  desired: number;
  logGroup: string;
}

export interface StartServicesInput {
  app: string;
  stage: string;
  deploymentId: string;
  services: ResolvedManifest['services'];
  containers: ContainersRuntimeConfig;
  region: string;
  /** The stage role, which the code runs as. */
  roleArn: string;
  /** What the worker gets (bindings, NODE_OPTIONS, manifest env, extra env). */
  env: Record<string, string>;
  tags: Record<string, string>;
  artifact: S3Location;
  resources: ResourceRef[];
}

/**
 * Build and roll out every declared service without waiting: push its
 * image, register a task definition, point the ECS service at it and set a
 * preview's stop schedule. {@link awaitServiceRollouts} waits afterwards.
 */
export async function startServices(
  ctx: EngineContext,
  input: StartServicesInput,
): Promise<{ deployed: DeployedService[]; rollouts: ServiceRollout[] }> {
  const { app, stage, deploymentId, containers: c } = input;
  const keys = Object.keys(input.services).toSorted();
  const zip = unzipSync(await getObjectBytes(ctx, input.artifact));
  for (const key of keys)
    if (!zip[`${key}/index.mjs`]) throw new Error(`services.zip has no ${key}/index.mjs`);

  const base = await ensureBaseImage(ctx, { repository: c.repository, base: CONTAINER_BASE_IMAGE });
  const group = names.scheduleGroup(app, stage);
  const now = new Date();
  const deployed: DeployedService[] = [];
  const rollouts: ServiceRollout[] = [];
  for (const key of keys) {
    const svc = input.services[key]!;
    const map = zip[`${key}/index.mjs.map`];
    const tag = names.serviceImageTag(app, stage, key, deploymentId);
    const { image } = await pushImage(ctx, {
      repository: c.repository,
      repositoryUri: c.repositoryUri,
      base,
      files: [
        { path: '/app/index.mjs', content: zip[`${key}/index.mjs`]! },
        ...(map ? [{ path: '/app/index.mjs.map', content: map }] : []),
      ],
      entrypoint: ['node', '/app/index.mjs'],
      workingDir: '/app',
      user: 'node',
      tag,
    });
    const name = names.service(app, stage, key);
    const logGroup = names.serviceLogGroup(app, stage, key);
    const taskDefinition = await registerTaskDefinition(ctx, {
      family: name,
      cpu: svc.cpu,
      memoryMb: svc.memoryMb,
      taskRoleArn: input.roleArn,
      executionRoleArn: c.executionRoleArn,
      image,
      environment: { ...input.env, [SERVICE_ENV]: key },
      logGroup,
      region: input.region,
      tags: { ...input.tags, [TAGS.deployment]: deploymentId },
    });
    const desired = deployDesiredCount(stage, svc);
    const state = await ensureService(ctx, {
      cluster: c.cluster,
      name,
      taskDefinition,
      desiredCount: desired,
      spot: svc.spot,
      subnets: c.subnets,
      securityGroups: c.securityGroups,
      tags: input.tags,
    });
    const stopsAt = deployStopTime(stage, svc, now);
    const schedule = names.serviceStopSchedule(key);
    if (stopsAt) {
      await ensureScheduleGroup(ctx, { name: group, tags: input.tags });
      await ensureOneShotSchedule(ctx, { group, name: schedule, at: stopsAt, target: stopTarget(c, name) });
      input.resources.push({ type: 'schedule', name: `${group}/${schedule}` });
    } else {
      await deleteSchedule(ctx, group, schedule);
    }
    if (desired === 0)
      ctx.log(
        'info',
        'not running it: previewMinutes is 0 (start it from the console or CLI)',
        `ecs-service ${name}`,
      );
    deployed.push({
      name: key,
      image,
      taskDefinitionArn: taskDefinition,
      desired,
      ...(stopsAt ? { stopsAt: stopsAt.toISOString() } : {}),
    });
    rollouts.push({
      name: key,
      service: name,
      taskDefinition,
      ...(state.previousTaskDefinition ? { previousTaskDefinition: state.previousTaskDefinition } : {}),
      desired,
      logGroup,
    });
    input.resources.push(
      { type: 'image', name: `${c.repository}:${tag}` },
      { type: 'task-definition', name: shortTaskDefinition(taskDefinition), arn: taskDefinition },
      { type: 'ecs-service', name, arn: state.arn },
    );
  }
  return { deployed, rollouts };
}

/**
 * Wait for every rollout that starts a task, together, within one deadline.
 * A failed rollout fails the deploy with what ECS and the container said.
 * ECS's circuit breaker takes a service it gave up on back to its previous
 * build; when the wait gives up first, this does the same (or stops a
 * service that has no previous build).
 */
export async function awaitServiceRollouts(
  ctx: EngineContext,
  input: { cluster: string; rollouts: readonly ServiceRollout[]; timeoutMs?: number; intervalMs?: number },
): Promise<void> {
  const deadline = Date.now() + (input.timeoutMs ?? ROLLOUT_TIMEOUT_MS);
  const waiting = input.rollouts.filter((r) => r.desired > 0);
  if (!waiting.length) return;
  ctx.log('info', `waiting for ${waiting.map((r) => r.name).join(', ')} to start`);
  const results = await Promise.allSettled(
    waiting.map(async (r) => {
      await waitForRollout(ctx, {
        cluster: input.cluster,
        service: r.service,
        taskDefinition: r.taskDefinition,
        logGroup: r.logGroup,
        deadline,
        ...(input.intervalMs !== undefined ? { intervalMs: input.intervalMs } : {}),
      });
      ctx.log('info', 'running', `ecs-service ${r.service}`);
    }),
  );
  const errors: string[] = [];
  for (const [i, result] of results.entries()) {
    if (result.status === 'fulfilled') continue;
    const e = result.reason as unknown;
    if (!(e instanceof RolloutError)) throw e;
    await recoverFailedRollout(ctx, input.cluster, waiting[i]!, e.failure);
    errors.push(e.message);
  }
  if (errors.length) throw new Error(errors.join('\n'));
}

/** What a failed rollout leaves behind. Exported for tests. */
export function recoveryFor(
  failure: RolloutFailure,
  rollout: Pick<ServiceRollout, 'previousTaskDefinition'>,
): { taskDefinition: string } | 'stop' | 'none' {
  if (failure === 'replaced') return 'none';
  if (!rollout.previousTaskDefinition) return 'stop';
  // ECS's circuit breaker already rolls back a deployment it marked FAILED.
  return failure === 'failed' ? 'none' : { taskDefinition: rollout.previousTaskDefinition };
}

async function recoverFailedRollout(
  ctx: EngineContext,
  cluster: string,
  rollout: ServiceRollout,
  failure: RolloutFailure,
): Promise<void> {
  const action = recoveryFor(failure, rollout);
  const resource = `ecs-service ${rollout.service}`;
  if (action === 'stop') {
    ctx.log('warn', 'stopping it: it has no earlier build to go back to', resource);
    await setDesiredCount(ctx, cluster, rollout.service, 0);
  } else if (action !== 'none') {
    ctx.log('warn', `going back to ${shortTaskDefinition(action.taskDefinition)}`, resource);
    await setTaskDefinition(ctx, cluster, rollout.service, action.taskDefinition);
  }
}

/**
 * Builds to delete for one service: everything but the newest `kept`
 * deployments, the ones in `keep` (the previous and the new deployment) and
 * whatever an ECS deployment of the service still runs. Exported for tests.
 */
export function staleServiceBuilds(input: {
  taskDefinitions: ReadonlyArray<{ arn: string; revision: number; deploymentId?: string }>;
  images: ReadonlyArray<{ tag: string; deploymentId: string }>;
  inUse: readonly string[];
  keep: ReadonlyArray<string | undefined>;
  kept: number;
}): { taskDefinitions: string[]; imageTags: string[] } {
  const inUse = new Set(input.inUse);
  const ids = [
    ...new Set([
      ...input.taskDefinitions.flatMap((t) => (t.deploymentId ? [t.deploymentId] : [])),
      ...input.images.map((i) => i.deploymentId),
    ]),
  ]
    .toSorted()
    .toReversed();
  const keepIds = new Set([
    ...ids.slice(0, input.kept),
    ...input.keep.filter((k): k is string => Boolean(k)),
    ...input.taskDefinitions.filter((t) => inUse.has(t.arn) && t.deploymentId).map((t) => t.deploymentId!),
  ]);
  // A retried deploy registers its deployment twice: keep that deployment's newest revision.
  const newestPerDeployment = new Map<string, string>();
  for (const t of input.taskDefinitions.toSorted((a, b) => b.revision - a.revision))
    if (t.deploymentId && !newestPerDeployment.has(t.deploymentId))
      newestPerDeployment.set(t.deploymentId, t.arn);
  return {
    taskDefinitions: input.taskDefinitions
      .filter(
        (t) =>
          !inUse.has(t.arn) &&
          !(
            t.deploymentId &&
            keepIds.has(t.deploymentId) &&
            newestPerDeployment.get(t.deploymentId) === t.arn
          ),
      )
      .map((t) => t.arn),
    imageTags: input.images.filter((i) => !keepIds.has(i.deploymentId)).map((i) => i.tag),
  };
}

/**
 * After the route flip: delete services the manifest no longer declares
 * (ECS service, stop schedule, task definitions, images) and old builds of
 * the ones it does.
 */
export async function pruneServices(
  ctx: EngineContext,
  input: {
    app: string;
    stage: string;
    services: ResolvedManifest['services'];
    containers: ContainersRuntimeConfig;
    /** Deployments whose builds stay whatever their age. */
    keep: ReadonlyArray<string | undefined>;
    /** Task definitions that stay whatever their age (what each service ran before the deploy). */
    keepTaskDefinitions?: readonly string[];
    kept: number;
  },
): Promise<void> {
  const { app, stage, containers: c } = input;
  const prefix = stagePrefix(app, stage);
  const group = names.scheduleGroup(app, stage);
  const declared = new Set(Object.keys(input.services));

  const live = await listServices(ctx, c.cluster, prefix);
  for (const svc of live) {
    const key = serviceKey(prefix, svc.serviceName);
    if (!key || declared.has(key)) continue;
    await deleteService(ctx, c.cluster, svc.serviceName!);
    await deleteSchedule(ctx, group, names.serviceStopSchedule(key));
  }

  const images = new Map<string, Array<{ tag: string; deploymentId: string }>>();
  for (const image of await listImages(ctx, c.repository, prefix)) {
    const [key, deploymentId, ...rest] = image.tag.slice(prefix.length).split('--');
    if (!key || !deploymentId || rest.length) continue;
    images.set(key, [...(images.get(key) ?? []), { tag: image.tag, deploymentId }]);
  }
  const families = new Map<string, string>();
  for (const family of await listTaskDefinitionFamilies(ctx, prefix, 'ALL')) {
    const key = serviceKey(prefix, family);
    if (key) families.set(key, family);
  }

  for (const key of new Set([...images.keys(), ...families.keys()])) {
    const family = names.service(app, stage, key);
    const tags = images.get(key) ?? [];
    if (!declared.has(key)) {
      await deleteTaskDefinitions(ctx, await allRevisions(ctx, family));
      await deleteImages(
        ctx,
        c.repository,
        tags.map((t) => ({ tag: t.tag })),
      );
      continue;
    }
    const revisions = await listTaskDefinitions(ctx, family);
    const svc = live.find((s) => s.serviceName === family);
    const stale = staleServiceBuilds({
      taskDefinitions: revisions.map((t) => ({
        arn: t.arn,
        revision: t.revision,
        ...(t.tags[TAGS.deployment] ? { deploymentId: t.tags[TAGS.deployment] } : {}),
      })),
      images: tags,
      inUse: [
        ...(svc?.deployments ?? []).flatMap((d) => (d.taskDefinition ? [d.taskDefinition] : [])),
        ...(input.keepTaskDefinitions ?? []),
      ],
      keep: input.keep,
      kept: input.kept,
    });
    // Deregistered revisions can't be run or rolled back to: those an earlier cleanup left go too.
    const inactive = await listTaskDefinitionArns(ctx, family, 'INACTIVE');
    await deleteTaskDefinitions(ctx, [...stale.taskDefinitions, ...inactive]);
    await deleteImages(
      ctx,
      c.repository,
      stale.imageTags.map((tag) => ({ tag })),
    );
  }
}

async function allRevisions(ctx: EngineContext, family: string): Promise<string[]> {
  const [active, inactive] = await Promise.all([
    listTaskDefinitionArns(ctx, family, 'ACTIVE'),
    listTaskDefinitionArns(ctx, family, 'INACTIVE'),
  ]);
  return [...active, ...inactive];
}

/** The deployment a service's ECS deployment (or task definition) belongs to. */
export async function deploymentOf(
  ctx: EngineContext,
  taskDefinition: string | undefined,
): Promise<string | undefined> {
  if (!taskDefinition) return undefined;
  return (await describeTaskDefinition(ctx, taskDefinition))?.tags[TAGS.deployment];
}

// ------------------------------------------------------------------ rollback

/** Which services a rollback repoints, keeps or can't bring back. Exported for tests. */
export function rollbackSelection(
  target: readonly string[],
  live: readonly string[],
): { repoint: string[]; keep: string[]; missing: string[] } {
  const t = new Set(target);
  const l = new Set(live);
  return {
    repoint: live.filter((k) => t.has(k)).toSorted(),
    keep: live.filter((k) => !t.has(k)).toSorted(),
    missing: target.filter((k) => !l.has(k)).toSorted(),
  };
}

/** The newest revision built by `deploymentId`. Exported for tests. */
export function buildOf<T extends { revision: number; tags: Record<string, string> }>(
  revisions: readonly T[],
  deploymentId: string,
): T | undefined {
  return revisions
    .filter((t) => t.tags[TAGS.deployment] === deploymentId)
    .toSorted((a, b) => b.revision - a.revision)[0];
}

export interface ServicesRollback {
  cluster: string;
  updates: Array<{ service: string; taskDefinition: string }>;
}

/**
 * Before a rollback changes anything: find the build of `route.d` for every
 * service that deployment declared and the stage still runs. Refuses
 * (through `gone`) when one has been cleaned up.
 */
export async function planServicesRollback(
  ctx: EngineContext,
  input: RollbackStageInput,
  gone: (what: string) => Error,
): Promise<ServicesRollback | undefined> {
  const c = input.platform.containers;
  if (!c || !input.services) return undefined;
  const { app, stage, route } = input;
  const prefix = stagePrefix(app, stage);
  const live = await listServices(ctx, c.cluster, prefix);
  const liveKeys = live.flatMap((s) => serviceKey(prefix, s.serviceName) ?? []);
  const selection = rollbackSelection(input.services, liveKeys);
  for (const key of selection.keep)
    ctx.log(
      'warn',
      `deployment ${route.d} has no service ${key}; it keeps running its current build`,
      `ecs-service ${names.service(app, stage, key)}`,
    );
  for (const key of selection.missing)
    ctx.log(
      'warn',
      `deployment ${route.d} had service ${key}, which the stage no longer runs: redeploy that commit to bring it back`,
    );
  const updates: ServicesRollback['updates'] = [];
  for (const key of selection.repoint) {
    const service = names.service(app, stage, key);
    const build = buildOf(await listTaskDefinitions(ctx, service), route.d);
    if (!build) throw gone(`the build of service ${key} has been cleaned up`);
    if (live.find((s) => s.serviceName === service)?.taskDefinition !== build.arn)
      updates.push({ service, taskDefinition: build.arn });
  }
  return { cluster: c.cluster, updates };
}

/** Point each service at its build from the rollback's deployment (ECS rolls it out; no wait). */
export async function applyServicesRollback(
  ctx: EngineContext,
  plan: ServicesRollback | undefined,
): Promise<void> {
  for (const u of plan?.updates ?? [])
    await setTaskDefinition(ctx, plan!.cluster, u.service, u.taskDefinition);
}

// ------------------------------------------------------------------ destroy / list

/** Delete the stage's services, task definitions and images (stop schedules go with the schedule group). */
export async function destroyServices(
  ctx: EngineContext,
  input: { app: string; stage: string; containers: ContainersRuntimeConfig },
): Promise<void> {
  const { app, stage, containers: c } = input;
  const prefix = stagePrefix(app, stage);
  for (const svc of await listServices(ctx, c.cluster, prefix))
    await deleteService(ctx, c.cluster, svc.serviceName!);
  for (const family of await listTaskDefinitionFamilies(ctx, prefix, 'ALL')) {
    if (serviceKey(prefix, family)) await deleteTaskDefinitions(ctx, await allRevisions(ctx, family));
  }
  const images = await listImages(ctx, c.repository, prefix);
  await deleteImages(
    ctx,
    c.repository,
    images.map((i) => ({ tag: i.tag })),
  );
}

/** The stage's ECS services and task definition families, found by name (no runtime config needed). */
export async function listServiceResources(
  ctx: EngineContext,
  app: string,
  stage: string,
): Promise<ResourceRef[]> {
  const prefix = stagePrefix(app, stage);
  const out: ResourceRef[] = [];
  for (const svc of await listServices(ctx, platformNames.containerCluster, prefix))
    out.push({ type: 'ecs-service', name: svc.serviceName!, arn: svc.serviceArn! });
  for (const family of await listTaskDefinitionFamilies(ctx, prefix, 'ACTIVE'))
    if (serviceKey(prefix, family)) out.push({ type: 'task-definition', name: family });
  return out;
}

// ------------------------------------------------------------------ runtime state and control

export async function describeServices(
  ctx: EngineContext,
  input: StageServicesInput,
): Promise<ServiceRuntimeState[]> {
  const c = input.platform.containers;
  if (!c) return [];
  const { app, stage } = input;
  const prefix = stagePrefix(app, stage);
  const group = names.scheduleGroup(app, stage);
  const services = (await listServices(ctx, c.cluster, prefix)).filter((s) =>
    serviceKey(prefix, s.serviceName),
  );
  return mapLimit(services, 4, async (svc) => {
    const name = serviceKey(prefix, svc.serviceName)!;
    const newest = newestDeployment(svc.deployments);
    const [deploymentId, running, stopped, stopsAt] = await Promise.all([
      deploymentOf(ctx, newest?.taskDefinition),
      listTasks(ctx, c.cluster, svc.serviceName!, 'RUNNING'),
      listTasks(ctx, c.cluster, svc.serviceName!, 'STOPPED'),
      getOneShotScheduleTime(ctx, group, names.serviceStopSchedule(name)),
    ]);
    const current = running.find((t) => t.lastStatus === 'RUNNING' && t.startedAt);
    const last = stopped.find((t) => t.stoppedAt);
    const container = last?.containers?.find((x) => x.name === 'app');
    const rollout = newest?.rolloutState?.toLowerCase() as ServiceRuntimeState['rollout'];
    return {
      name,
      desired: svc.desiredCount ?? 0,
      running: svc.runningCount ?? 0,
      pending: svc.pendingCount ?? 0,
      ...(rollout ? { rollout } : {}),
      ...(deploymentId ? { deploymentId } : {}),
      ...(current?.startedAt ? { startedAt: current.startedAt.toISOString() } : {}),
      ...(stopsAt ? { stopsAt: stopsAt.toISOString() } : {}),
      ...(last?.stoppedAt
        ? {
            lastStop: {
              at: last.stoppedAt.toISOString(),
              reason: [last.stoppedReason, container?.reason].filter(Boolean).join(': ') || 'unknown',
              ...(container?.exitCode !== undefined ? { exitCode: container.exitCode } : {}),
            },
          }
        : {}),
      events: (svc.events ?? []).slice(0, 10).map((e) => ({
        at: e.createdAt?.toISOString() ?? '',
        message: e.message ?? '',
      })),
    };
  });
}

export async function controlService(
  ctx: EngineContext,
  input: ControlServiceInput,
): Promise<{ desired: number; stopsAt?: string }> {
  const { app, stage, platform } = input;
  const c = platform.containers;
  const service = names.service(app, stage, input.name);
  const svc = c ? await getService(ctx, c.cluster, service) : undefined;
  if (!c || svc?.status !== 'ACTIVE') throw new ServiceNotFoundError(input.name, app, stage);
  const group = names.scheduleGroup(app, stage);
  const schedule = names.serviceStopSchedule(input.name);
  if (input.action === 'restart') {
    await restartService(ctx, c.cluster, service);
    const stopsAt = await getOneShotScheduleTime(ctx, group, schedule);
    return { desired: svc.desiredCount ?? 0, ...(stopsAt ? { stopsAt: stopsAt.toISOString() } : {}) };
  }
  if (input.action === 'stop') {
    await setDesiredCount(ctx, c.cluster, service, 0);
    await deleteSchedule(ctx, group, schedule);
    return { desired: 0 };
  }
  if (input.minutes !== undefined && !(Number.isInteger(input.minutes) && input.minutes > 0))
    throw new Error('minutes must be a positive whole number');
  await setDesiredCount(ctx, c.cluster, service, 1);
  if (input.minutes === undefined) {
    await deleteSchedule(ctx, group, schedule);
    return { desired: 1 };
  }
  const at = minutesFrom(new Date(), input.minutes);
  await ensureScheduleGroup(ctx, { name: group, tags: stageTags(app, stage) });
  await ensureOneShotSchedule(ctx, { group, name: schedule, at, target: stopTarget(c, service) });
  return { desired: 1, stopsAt: at.toISOString() };
}
