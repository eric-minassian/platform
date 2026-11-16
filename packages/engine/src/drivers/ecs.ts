import { GetLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import {
  type CapacityProviderStrategyItem,
  CreateClusterCommand,
  CreateServiceCommand,
  DeleteServiceCommand,
  DeleteTaskDefinitionsCommand,
  DeregisterTaskDefinitionCommand,
  DescribeClustersCommand,
  DescribeServicesCommand,
  DescribeTaskDefinitionCommand,
  DescribeTasksCommand,
  type Deployment,
  ListServicesCommand,
  ListTaskDefinitionFamiliesCommand,
  ListTaskDefinitionsCommand,
  ListTasksCommand,
  PutClusterCapacityProvidersCommand,
  type RegisterTaskDefinitionCommandInput,
  RegisterTaskDefinitionCommand,
  type Service,
  TagResourceCommand,
  type Task,
  UpdateServiceCommand,
} from '@aws-sdk/client-ecs';
import { fargateCpuUnits } from '@ericminassian/platform-core';
import {
  type EngineContext,
  errorMessage,
  errorName,
  ignoreNotFound,
  isNotFound,
  mapLimit,
  retry,
  sleep,
  tagListLower,
  waitFor,
} from '../util.ts';

/**
 * Fargate through the ECS API: task definitions, services of at most one
 * task, and what happened to their tasks. Generic: nothing here knows about
 * stages (see `services.ts` for that).
 */

const FARGATE_PROVIDERS = ['FARGATE', 'FARGATE_SPOT'];

/** A cluster that can run Fargate and Fargate Spot tasks. */
export async function ensureCluster(
  ctx: EngineContext,
  spec: { name: string; tags?: Record<string, string> },
): Promise<string> {
  const ecs = ctx.clients.ecs;
  const found = await ecs.send(new DescribeClustersCommand({ clusters: [spec.name] }));
  let cluster = found.clusters?.find((c) => c.status === 'ACTIVE');
  if (!cluster) {
    cluster = (
      await ecs.send(
        new CreateClusterCommand({
          clusterName: spec.name,
          ...(spec.tags ? { tags: tagListLower(spec.tags) } : {}),
        }),
      )
    ).cluster;
    ctx.log('info', 'created cluster', `cluster ${spec.name}`);
  }
  const providers = cluster?.capacityProviders ?? [];
  if (!FARGATE_PROVIDERS.every((p) => providers.includes(p))) {
    await ecs.send(
      new PutClusterCapacityProvidersCommand({
        cluster: spec.name,
        capacityProviders: [...new Set([...providers, ...FARGATE_PROVIDERS])],
        defaultCapacityProviderStrategy: [{ capacityProvider: 'FARGATE', weight: 1 }],
      }),
    );
  }
  return cluster!.clusterArn!;
}

// ------------------------------------------------------------------ task definitions

export interface TaskDefinitionSpec {
  family: string;
  /** vCPUs (0.25 … 4). */
  cpu: number;
  memoryMb: number;
  /** What the container's code runs as. */
  taskRoleArn: string;
  /** What ECS pulls the image and ships logs with. */
  executionRoleArn: string;
  image: string;
  environment: Record<string, string>;
  /** Overrides the image's Cmd. */
  command?: string[];
  /** awslogs group; streams are `ecs/app/<task id>`. */
  logGroup: string;
  region: string;
  /** SIGTERM → SIGKILL grace period. Default 30. */
  stopTimeoutSeconds?: number;
  tags?: Record<string, string>;
}

/** Name of the one container in every task definition the platform registers. */
export const CONTAINER_NAME = 'app';

/** Exported for tests. */
export function taskDefinitionInput(spec: TaskDefinitionSpec): RegisterTaskDefinitionCommandInput {
  return {
    family: spec.family,
    cpu: String(fargateCpuUnits(spec.cpu)),
    memory: String(spec.memoryMb),
    networkMode: 'awsvpc',
    requiresCompatibilities: ['FARGATE'],
    runtimePlatform: { cpuArchitecture: 'ARM64', operatingSystemFamily: 'LINUX' },
    taskRoleArn: spec.taskRoleArn,
    executionRoleArn: spec.executionRoleArn,
    containerDefinitions: [
      {
        name: CONTAINER_NAME,
        image: spec.image,
        essential: true,
        environment: Object.entries(spec.environment)
          .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([name, value]) => ({ name, value })),
        ...(spec.command ? { command: spec.command } : {}),
        stopTimeout: spec.stopTimeoutSeconds ?? 30,
        // A crash after the container has run 60 s restarts it in place (seconds, same task);
        // an earlier one fails the task and ECS replaces it, so a crash loop shows up as failed
        // tasks (and trips the deployment circuit breaker) instead of restarting forever.
        restartPolicy: { enabled: true, restartAttemptPeriod: 60 },
        logConfiguration: {
          logDriver: 'awslogs',
          options: {
            'awslogs-group': spec.logGroup,
            'awslogs-region': spec.region,
            'awslogs-stream-prefix': 'ecs',
            // A slow log pipe must never block the process (lines are dropped instead).
            mode: 'non-blocking',
          },
        },
      },
    ],
    ...(spec.tags ? { tags: tagListLower(spec.tags) } : {}),
  };
}

/** Register a new revision of the family; returns its ARN. */
export async function registerTaskDefinition(ctx: EngineContext, spec: TaskDefinitionSpec): Promise<string> {
  const res = await retry(
    () => ctx.clients.ecs.send(new RegisterTaskDefinitionCommand(taskDefinitionInput(spec))),
    {
      // A role created moments ago may not be visible to ECS yet.
      when: (e) => errorName(e) === 'ClientException' && /role/i.test(errorMessage(e)),
      attempts: 10,
    },
  );
  const arn = res.taskDefinition!.taskDefinitionArn!;
  ctx.log('info', `registered revision ${res.taskDefinition!.revision}`, `task-definition ${spec.family}`);
  return arn;
}

export interface TaskDefinitionInfo {
  arn: string;
  family: string;
  revision: number;
  image?: string;
  tags: Record<string, string>;
}

/** Revisions of one family (newest first) with their tags. */
export async function listTaskDefinitions(
  ctx: EngineContext,
  family: string,
  status: 'ACTIVE' | 'INACTIVE' = 'ACTIVE',
): Promise<TaskDefinitionInfo[]> {
  const arns = await listTaskDefinitionArns(ctx, family, status);
  const out = await mapLimit(arns, 4, (arn) => describeTaskDefinition(ctx, arn));
  return out.filter((t) => t !== undefined).toSorted((a, b) => b.revision - a.revision);
}

/** ARNs of one family's revisions in a status, newest first. */
export async function listTaskDefinitionArns(
  ctx: EngineContext,
  family: string,
  status: 'ACTIVE' | 'INACTIVE' = 'ACTIVE',
): Promise<string[]> {
  const arns: string[] = [];
  let nextToken: string | undefined;
  do {
    const res = await ctx.clients.ecs.send(
      new ListTaskDefinitionsCommand({ familyPrefix: family, status, sort: 'DESC', nextToken }),
    );
    for (const arn of res.taskDefinitionArns ?? [])
      if (parseTaskDefinitionArn(arn)?.family === family) arns.push(arn);
    nextToken = res.nextToken;
  } while (nextToken);
  return arns;
}

/** One revision with its tags, or undefined when ECS doesn't know it (deleted). */
export async function describeTaskDefinition(
  ctx: EngineContext,
  arn: string,
): Promise<TaskDefinitionInfo | undefined> {
  let res;
  try {
    res = await ctx.clients.ecs.send(
      new DescribeTaskDefinitionCommand({ taskDefinition: arn, include: ['TAGS'] }),
    );
  } catch (e) {
    if (
      errorName(e) === 'ClientException' &&
      /unable to describe|not found|does not exist/i.test(errorMessage(e))
    )
      return undefined;
    throw e;
  }
  const td = res.taskDefinition!;
  return {
    arn: td.taskDefinitionArn ?? arn,
    family: td.family!,
    revision: td.revision!,
    ...(td.containerDefinitions?.[0]?.image ? { image: td.containerDefinitions[0].image } : {}),
    tags: Object.fromEntries((res.tags ?? []).map((t) => [t.key!, t.value ?? ''])),
  };
}

/**
 * Task definition families starting with `prefix`: with an ACTIVE revision,
 * or (`ALL`) with any revision ECS still lists.
 */
export async function listTaskDefinitionFamilies(
  ctx: EngineContext,
  prefix: string,
  status: 'ACTIVE' | 'ALL' = 'ACTIVE',
): Promise<string[]> {
  const out: string[] = [];
  let nextToken: string | undefined;
  do {
    const res = await ctx.clients.ecs.send(
      new ListTaskDefinitionFamiliesCommand({ familyPrefix: prefix, status, nextToken }),
    );
    for (const f of res.families ?? []) if (f.startsWith(prefix)) out.push(f);
    nextToken = res.nextToken;
  } while (nextToken);
  return out;
}

/** Deregister and delete revisions (ECS finishes deleting one once no task uses it). */
export async function deleteTaskDefinitions(ctx: EngineContext, arns: readonly string[]): Promise<void> {
  const ecs = ctx.clients.ecs;
  for (const arn of arns) {
    try {
      await ecs.send(new DeregisterTaskDefinitionCommand({ taskDefinition: arn }));
    } catch (e) {
      // Already deregistered (an earlier cleanup stopped halfway): delete it all the same.
      if (errorName(e) !== 'ClientException' && !isNotFound(e)) throw e;
    }
  }
  for (let i = 0; i < arns.length; i += 10) {
    const batch = arns.slice(i, i + 10);
    const res = await ecs.send(new DeleteTaskDefinitionsCommand({ taskDefinitions: [...batch] }));
    const failed = new Set<string>();
    for (const f of res.failures ?? []) {
      if (f.arn) failed.add(f.arn);
      ctx.log('warn', `couldn't delete: ${f.reason ?? 'unknown reason'}`, `task-definition ${f.arn}`);
    }
    for (const arn of batch)
      if (!failed.has(arn)) ctx.log('info', 'deleted', `task-definition ${shortTaskDefinition(arn)}`);
  }
}

/** `family:revision` from a task definition ARN. */
export function shortTaskDefinition(arn: string): string {
  return arn.slice(arn.lastIndexOf('/') + 1);
}

export function parseTaskDefinitionArn(arn: string): { family: string; revision: number } | undefined {
  const m = /task-definition\/([^:/]+):(\d+)$/.exec(arn);
  return m ? { family: m[1]!, revision: Number(m[2]) } : undefined;
}

// ------------------------------------------------------------------ services

export interface ServiceSpec {
  cluster: string;
  name: string;
  taskDefinition: string;
  desiredCount: number;
  /** Fargate Spot instead of on-demand Fargate. */
  spot: boolean;
  /** Public subnets: tasks get a public IPv4 address (there is no NAT). */
  subnets: readonly string[];
  securityGroups: readonly string[];
  tags?: Record<string, string>;
}

export interface ServiceState {
  arn: string;
  created: boolean;
  /** The task definition the service ran before this update. */
  previousTaskDefinition?: string;
}

const isServiceGone = (e: unknown) => isNotFound(e) || errorName(e) === 'ServiceNotActiveException';

function capacityStrategy(spot: boolean): CapacityProviderStrategyItem[] {
  return [{ capacityProvider: spot ? 'FARGATE_SPOT' : 'FARGATE', weight: 1 }];
}

/** Exported for tests. */
export function serviceSettings(spec: ServiceSpec) {
  return {
    taskDefinition: spec.taskDefinition,
    desiredCount: spec.desiredCount,
    capacityProviderStrategy: capacityStrategy(spec.spot),
    networkConfiguration: {
      awsvpcConfiguration: {
        subnets: [...spec.subnets],
        securityGroups: [...spec.securityGroups],
        assignPublicIp: 'ENABLED' as const,
      },
    },
    // At most one task: the old one stops before the new one starts. The circuit breaker
    // fails a deployment whose tasks keep failing and goes back to the last good one.
    deploymentConfiguration: {
      minimumHealthyPercent: 0,
      maximumPercent: 100,
      deploymentCircuitBreaker: { enable: true, rollback: true },
    },
    propagateTags: 'SERVICE' as const,
    enableECSManagedTags: true,
  };
}

/**
 * Create the service, or update it to `spec`. A deleted service keeps its
 * name while it drains; creating one with the same name waits that out.
 */
export async function ensureService(ctx: EngineContext, spec: ServiceSpec): Promise<ServiceState> {
  const ecs = ctx.clients.ecs;
  const resource = `ecs-service ${spec.name}`;
  let existing = await getService(ctx, spec.cluster, spec.name);
  if (existing?.status === 'DRAINING') {
    ctx.log('info', 'waiting for the deleted service of the same name to drain', resource);
    await waitFor(
      `${spec.name} to finish draining`,
      async () => {
        const s = await getService(ctx, spec.cluster, spec.name);
        return !s || s.status === 'INACTIVE';
      },
      { timeoutMs: 600_000 },
    );
    existing = undefined;
  }
  const settings = serviceSettings(spec);
  if (existing?.status === 'ACTIVE') {
    const strategy = existing.capacityProviderStrategy?.map((s) => s.capacityProvider).join(',');
    const res = await ecs.send(
      new UpdateServiceCommand({
        cluster: spec.cluster,
        service: spec.name,
        ...settings,
        // ECS only switches capacity providers with a new deployment.
        forceNewDeployment: strategy !== settings.capacityProviderStrategy[0]!.capacityProvider,
      }),
    );
    const arn = res.service?.serviceArn ?? existing.serviceArn!;
    if (spec.tags)
      await ecs.send(new TagResourceCommand({ resourceArn: arn, tags: tagListLower(spec.tags) }));
    ctx.log(
      'info',
      `updated (${shortTaskDefinition(spec.taskDefinition)}, desired ${spec.desiredCount})`,
      resource,
    );
    return {
      arn,
      created: false,
      ...(existing.taskDefinition ? { previousTaskDefinition: existing.taskDefinition } : {}),
    };
  }
  const res = await ecs.send(
    new CreateServiceCommand({
      cluster: spec.cluster,
      serviceName: spec.name,
      ...settings,
      schedulingStrategy: 'REPLICA',
      ...(spec.tags ? { tags: tagListLower(spec.tags) } : {}),
    }),
  );
  ctx.log(
    'info',
    `created (${shortTaskDefinition(spec.taskDefinition)}, desired ${spec.desiredCount})`,
    resource,
  );
  return { arn: res.service!.serviceArn!, created: true };
}

/** The service in any status (ACTIVE, DRAINING, INACTIVE), or undefined when ECS has none by that name. */
export async function getService(
  ctx: EngineContext,
  cluster: string,
  name: string,
): Promise<Service | undefined> {
  const res = await ignoreNotFound(
    ctx.clients.ecs.send(new DescribeServicesCommand({ cluster, services: [name], include: ['TAGS'] })),
  );
  return res?.services?.[0];
}

/** ACTIVE services of the cluster whose name starts with `prefix`, with their tags. */
export async function listServices(ctx: EngineContext, cluster: string, prefix: string): Promise<Service[]> {
  const ecs = ctx.clients.ecs;
  const names: string[] = [];
  let nextToken: string | undefined;
  do {
    const res = await ignoreNotFound(
      ecs.send(new ListServicesCommand({ cluster, nextToken, maxResults: 100 })),
    );
    if (!res) return [];
    for (const arn of res.serviceArns ?? []) {
      const name = arn.slice(arn.lastIndexOf('/') + 1);
      if (name.startsWith(prefix)) names.push(name);
    }
    nextToken = res.nextToken;
  } while (nextToken);
  const out: Service[] = [];
  for (let i = 0; i < names.length; i += 10) {
    const res = await ecs.send(
      new DescribeServicesCommand({ cluster, services: names.slice(i, i + 10), include: ['TAGS'] }),
    );
    for (const s of res.services ?? []) if (s.status === 'ACTIVE') out.push(s);
  }
  return out.toSorted((a, b) => (a.serviceName! < b.serviceName! ? -1 : 1));
}

export async function setDesiredCount(
  ctx: EngineContext,
  cluster: string,
  service: string,
  desiredCount: number,
): Promise<void> {
  await ctx.clients.ecs.send(new UpdateServiceCommand({ cluster, service, desiredCount }));
  ctx.log('info', `desired count ${desiredCount}`, `ecs-service ${service}`);
}

/** Point the service at a task definition without waiting for the rollout. */
export async function setTaskDefinition(
  ctx: EngineContext,
  cluster: string,
  service: string,
  taskDefinition: string,
): Promise<void> {
  await ctx.clients.ecs.send(new UpdateServiceCommand({ cluster, service, taskDefinition }));
  ctx.log('info', `now runs ${shortTaskDefinition(taskDefinition)}`, `ecs-service ${service}`);
}

/** Replace the running task with a fresh one of the same task definition. */
export async function restartService(ctx: EngineContext, cluster: string, service: string): Promise<void> {
  await ctx.clients.ecs.send(new UpdateServiceCommand({ cluster, service, forceNewDeployment: true }));
  ctx.log('info', 'restarting', `ecs-service ${service}`);
}

/** Stop the service's tasks and delete it (it drains in the background). */
export async function deleteService(ctx: EngineContext, cluster: string, name: string): Promise<void> {
  const ecs = ctx.clients.ecs;
  const svc = await getService(ctx, cluster, name);
  if (svc?.status !== 'ACTIVE') return;
  try {
    if (svc.desiredCount)
      await ecs.send(new UpdateServiceCommand({ cluster, service: name, desiredCount: 0 }));
    await ecs.send(new DeleteServiceCommand({ cluster, service: name, force: true }));
  } catch (e) {
    if (!isServiceGone(e)) throw e;
  }
  ctx.log('info', 'deleted', `ecs-service ${name}`);
}

/** The service's tasks in one desired status, newest first. ECS keeps stopped tasks for about an hour. */
export async function listTasks(
  ctx: EngineContext,
  cluster: string,
  service: string,
  desiredStatus: 'RUNNING' | 'STOPPED',
): Promise<Task[]> {
  const ecs = ctx.clients.ecs;
  const arns: string[] = [];
  let nextToken: string | undefined;
  do {
    const res = await ignoreNotFound(
      ecs.send(new ListTasksCommand({ cluster, serviceName: service, desiredStatus, nextToken })),
    );
    if (!res) return [];
    arns.push(...(res.taskArns ?? []));
    nextToken = res.nextToken;
  } while (nextToken);
  const tasks: Task[] = [];
  for (let i = 0; i < arns.length; i += 100) {
    const res = await ecs.send(new DescribeTasksCommand({ cluster, tasks: arns.slice(i, i + 100) }));
    tasks.push(...(res.tasks ?? []));
  }
  const at = (t: Task) => (t.stoppedAt ?? t.startedAt ?? t.createdAt)?.getTime() ?? 0;
  return tasks.toSorted((a, b) => at(b) - at(a));
}

/** Every task `deployment` asks for runs on its task definition, has for `stableMs`, and none failed. */
async function settled(ctx: EngineContext, spec: RolloutSpec, deployment: Deployment): Promise<boolean> {
  const desired = deployment.desiredCount ?? 0;
  if (desired === 0 || (deployment.runningCount ?? 0) < desired || (deployment.failedTasks ?? 0) > 0)
    return false;
  const since = Date.now() - (spec.stableMs ?? ROLLOUT_STABLE_MS);
  const stable = (await listTasks(ctx, spec.cluster, spec.service, 'RUNNING')).filter(
    (t) =>
      t.taskDefinitionArn === spec.taskDefinition &&
      t.lastStatus === 'RUNNING' &&
      (t.startedAt?.getTime() ?? Number.POSITIVE_INFINITY) <= since,
  );
  return stable.length >= desired;
}

export function taskId(taskArn: string): string {
  return taskArn.slice(taskArn.lastIndexOf('/') + 1);
}

/** The newest ECS deployment of a service (a service has one per rollout in progress). */
export function newestDeployment(deployments: readonly Deployment[] | undefined): Deployment | undefined {
  return (deployments ?? []).toSorted(
    (a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0),
  )[0];
}

// ------------------------------------------------------------------ rollouts

export type RolloutFailure =
  /** ECS gave up on the deployment (its circuit breaker rolls the service back). */
  | 'failed'
  /** Tasks keep stopping; the wait gave up before ECS did. */
  | 'failing'
  /** It didn't finish in time. */
  | 'timeout'
  /** The deployment is gone: rolled back or replaced by a newer one. */
  | 'replaced';

export class RolloutError extends Error {
  override readonly name = 'RolloutError';
  readonly service: string;
  readonly failure: RolloutFailure;
  constructor(service: string, failure: RolloutFailure, message: string) {
    super(message);
    this.service = service;
    this.failure = failure;
  }
}

export interface RolloutSpec {
  cluster: string;
  service: string;
  taskDefinition: string;
  /** Where the container logs, to quote the failed tasks' last lines. */
  logGroup?: string;
  /** Give up at this time (ms since the epoch). */
  deadline: number;
  /** Poll interval. Default 5 s. */
  intervalMs?: number;
  /** How long the new tasks must have run, none failing, to count as started. Default {@link ROLLOUT_STABLE_MS}. */
  stableMs?: number;
}

/**
 * A rollout counts as done once every task it asks for has run this long
 * and none has failed. ECS marks it COMPLETED only at its next steady-state
 * check, about two minutes after the task started; a container that can't
 * start fails well within this.
 */
export const ROLLOUT_STABLE_MS = 30_000;

/**
 * Wait until the service's deployment of `taskDefinition` has COMPLETED, or
 * its tasks have all run for `stableMs` with none failed. Fails as soon as
 * ECS marks it FAILED or two of its tasks have failed, with the stopped
 * tasks' reasons and last log lines in the error.
 */
export async function waitForRollout(ctx: EngineContext, spec: RolloutSpec): Promise<void> {
  const interval = spec.intervalMs ?? 5_000;
  for (;;) {
    const svc = await getService(ctx, spec.cluster, spec.service);
    const deployment = newestDeployment(
      svc?.deployments?.filter((d) => d.taskDefinition === spec.taskDefinition),
    );
    let failure: RolloutFailure | undefined;
    if (!svc || svc.status !== 'ACTIVE' || !deployment) failure = 'replaced';
    else if (deployment.rolloutState === 'COMPLETED') return;
    else if (deployment.rolloutState === 'FAILED') failure = 'failed';
    else if ((deployment.failedTasks ?? 0) >= 2) failure = 'failing';
    else if (await settled(ctx, spec, deployment)) return;
    else if (Date.now() >= spec.deadline) failure = 'timeout';
    if (failure) throw await rolloutError(ctx, spec, failure, svc, deployment);
    await sleep(Math.max(0, Math.min(interval, spec.deadline - Date.now())));
  }
}

const SUMMARY: Record<RolloutFailure, string> = {
  failed: 'ECS stopped the rollout because its tasks failed',
  failing: 'its tasks keep stopping',
  timeout: "it didn't finish rolling out in time",
  replaced: 'its deployment was rolled back or replaced',
};

async function rolloutError(
  ctx: EngineContext,
  spec: RolloutSpec,
  failure: RolloutFailure,
  svc: Service | undefined,
  deployment: Deployment | undefined,
): Promise<RolloutError> {
  const lines = [
    `${spec.service} (${shortTaskDefinition(spec.taskDefinition)}) didn't start: ${SUMMARY[failure]}.`,
  ];
  const stopped = (await listTasks(ctx, spec.cluster, spec.service, 'STOPPED')).filter(
    (t) => t.taskDefinitionArn === spec.taskDefinition,
  );
  for (const [i, task] of stopped.slice(0, 3).entries()) {
    const container = task.containers?.find((c) => c.name === CONTAINER_NAME);
    const exit = container?.exitCode !== undefined ? ` (exit code ${container.exitCode})` : '';
    const reason = [task.stoppedReason, container?.reason].filter(Boolean).join(': ') || 'no reason given';
    lines.push(`  task ${taskId(task.taskArn!)} stopped${exit}: ${reason}`);
    if (i === 0 && spec.logGroup) {
      const tail = await logTail(ctx, spec.logGroup, `ecs/${CONTAINER_NAME}/${taskId(task.taskArn!)}`, 20);
      if (tail.length) lines.push('  its last log lines:', ...tail.map((l) => `    | ${l}`));
    }
  }
  if (!stopped.length) {
    if (deployment?.rolloutStateReason) lines.push(`  ${deployment.rolloutStateReason}`);
    for (const e of (svc?.events ?? []).slice(0, 3)) lines.push(`  ${e.message}`);
  }
  return new RolloutError(spec.service, failure, lines.join('\n'));
}

/**
 * Longest log line a rollout error quotes. Node prints the source line of an
 * uncaught error, which in a minified bundle is the whole bundle (150 KB on
 * the first real failure), and the error lands in the deployment's record.
 */
const QUOTED_LINE_MAX = 300;

/** The stream's last lines, each cut to a readable length. Best effort: the rollout error matters more than its logs. */
async function logTail(ctx: EngineContext, group: string, stream: string, limit: number): Promise<string[]> {
  try {
    const res = await ctx.clients.logs.send(
      new GetLogEventsCommand({ logGroupName: group, logStreamName: stream, limit, startFromHead: false }),
    );
    return (res.events ?? []).map((e) => {
      const line = (e.message ?? '').trimEnd();
      return line.length > QUOTED_LINE_MAX
        ? `${line.slice(0, QUOTED_LINE_MAX)}… (${line.length} chars)`
        : line;
    });
  } catch (e) {
    return isNotFound(e) ? [] : [`(its logs couldn't be read: ${errorMessage(e)})`];
  }
}
