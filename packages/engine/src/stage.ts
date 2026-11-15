import { randomBytes } from 'node:crypto';
import { DescribeEventBusCommand } from '@aws-sdk/client-eventbridge';
import { GetRoleCommand } from '@aws-sdk/client-iam';
import { GetFunctionConfigurationCommand } from '@aws-sdk/client-lambda';
import { GetWebFunctionCommand } from '@aws-sdk/client-lambda-web';
import {
  AUTH_ROUTES,
  BINDINGS_ENV,
  type Bindings,
  cognitoIssuer,
  cognitoJwksUri,
  encodeBindings,
  IAM_APP_PATH,
  LOCAL_STAGE,
  NODE_RUNTIME,
  names,
  type PlatformRuntimeConfig,
  PROD_STAGE,
  publicUrl,
  type ResolvedManifest,
  type RouteRecord,
  stageHost,
  toSchedulerExpression,
  validateStageName,
} from '@ericminassian/platform-core';
import { deleteUserPoolClient, ensureUserPoolClient } from './drivers/cognito.ts';
import { deleteTable, describeTable, ensureTable, stageTableSpec } from './drivers/dynamodb.ts';
import { deleteEventBus, deleteRule, ensureEventBus, ensureRule, listRules } from './drivers/events.ts';
import { deleteRole, ensureRole } from './drivers/iam.ts';
import { deleteRoute, getRoute, putRoute } from './drivers/kvs.ts';
import {
  deleteEventSourceMapping,
  deleteFunction,
  ensureEventSourceMapping,
  ensureFunction,
  ensurePermission,
  listEventSourceMappings,
  removePermission,
} from './drivers/lambda.ts';
import { deleteLogGroup, ensureLogGroup, listLogGroups } from './drivers/logs.ts';
import { deletePrefix, hasObjects, listChildPrefixes, publishStaticZip } from './drivers/s3.ts';
import {
  deleteSchedule,
  deleteScheduleGroup,
  ensureSchedule,
  ensureScheduleGroup,
  listSchedules,
} from './drivers/scheduler.ts';
import { deleteQueue, ensureQueue, listQueues } from './drivers/sqs.ts';
import { deleteParameter, deleteParametersByPath, ensureParameterOnce } from './drivers/ssm.ts';
import {
  createRevision,
  deleteWebFunction,
  endpointForRevision,
  ensureWebFunction,
  getRevisionState,
  pruneRevisions,
} from './drivers/web-function.ts';
import type {
  DeployStageInput,
  DeployStageResult,
  DestroyStageInput,
  ResourceRef,
  RollbackStageInput,
} from './index.ts';
import { stageRolePolicy, stageTrustPolicy } from './policy.ts';
import { type EngineContext, ignoreNotFound, stageTags } from './util.ts';

/**
 * Deployments whose static files and server revision are kept per stage (the
 * newest ones, plus whatever the routes still use), so rollback can reach them.
 */
const DEPLOYMENTS_KEPT = 3;

/**
 * Public host of a stage. Under `plat dev` the `local` stage is simply
 * `<app>.localhost`; everything else follows `stageHost`.
 */
export function hostFor(platform: PlatformRuntimeConfig, app: string, stage: string): string {
  if (platform.target === 'emulator' && stage === LOCAL_STAGE) return `${app}.${platform.domain}`;
  return stageHost(app, stage, platform.domain);
}

function statementId(prefix: string, name: string): string {
  return `${prefix}-${name}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 100);
}

/**
 * Reconcile one stage with its manifest, then flip the route. Ordering keeps
 * the old deployment serving until everything for the new one is ready:
 * data/messaging → role → worker → static → web revision → route (last) → GC.
 */
export async function deployStage(ctx: EngineContext, input: DeployStageInput): Promise<DeployStageResult> {
  const { manifest: m, stage, platform, deploymentId } = input;
  const app = m.name;
  const stageError = validateStageName(stage);
  if (stageError) throw new Error(stageError);

  const acct = await ctx.accountId();
  const region = platform.region;
  const webMode = input.webMode ?? 'function';
  const prod = stage === PROD_STAGE;
  const tags = stageTags(app, stage);
  const host = hostFor(platform, app, stage);
  const url = publicUrl(platform, host);
  const retention = input.logRetentionDays ?? (prod ? 30 : 7);
  const base = names.base(app, stage);
  const hasWeb = Boolean(m.web?.server) && webMode === 'function';
  const hasWorker = Boolean(m.worker);
  const resources: ResourceRef[] = [];
  const workerName = names.workerFunction(app, stage);

  if (hasWorker && !input.artifacts.worker)
    throw new Error('manifest declares a worker but no worker artifact was provided');
  if (hasWeb && !input.artifacts.server)
    throw new Error('manifest declares web.server but no server artifact was provided');

  ctx.log('info', `deploying ${app}/${stage} (${deploymentId})`);

  // 1. Log groups (retention set before anything writes to them).
  const webLogGroup = names.logGroup(app, stage, 'web');
  const workerLogGroup = names.logGroup(app, stage, 'worker');
  if (hasWeb) await ensureLogGroup(ctx, { name: webLogGroup, retentionDays: retention, tags });
  if (hasWorker) await ensureLogGroup(ctx, { name: workerLogGroup, retentionDays: retention, tags });

  // 2. Data.
  let table: string | undefined;
  if (m.db) {
    const t = await ensureTable(ctx, stageTableSpec(names.table(app, stage), { prod, tags }));
    table = t.name;
    resources.push({ type: 'table', name: t.name, arn: t.arn });
  } else if (await describeTable(ctx, names.table(app, stage))) {
    ctx.log(
      'warn',
      'db is off in plat.config.ts but the table still exists; keeping it (data)',
      `table ${names.table(app, stage)}`,
    );
  }

  // 3. Queues (dead-letter queue first).
  const queues: Bindings['queues'] = {};
  const workerTimeout = m.worker?.timeoutSeconds ?? 60;
  for (const [key, q] of Object.entries(m.queues)) {
    const dlq = await ensureQueue(ctx, {
      name: names.deadLetterQueue(app, stage, key),
      attributes: { MessageRetentionPeriod: String(14 * 24 * 3600) },
      tags,
    });
    let visibility = q.visibilityTimeoutSeconds;
    if (visibility < workerTimeout) {
      ctx.log('warn', `visibility timeout raised to the worker timeout (${workerTimeout}s)`, `queue ${key}`);
      visibility = workerTimeout;
    }
    const main = await ensureQueue(ctx, {
      name: names.queue(app, stage, key),
      attributes: {
        VisibilityTimeout: String(visibility),
        MessageRetentionPeriod: String(4 * 24 * 3600),
        RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlq.arn, maxReceiveCount: q.maxReceiveCount }),
      },
      tags,
    });
    queues[key] = { url: main.url, arn: main.arn };
    resources.push(
      { type: 'queue', name: main.name, arn: main.arn },
      { type: 'queue', name: dlq.name, arn: dlq.arn },
    );
  }

  // 4. Event bus (always: anything may be published, subscriptions are optional).
  const busName = names.eventBus(app, stage);
  const busArn = await ensureEventBus(ctx, { name: busName, tags });
  resources.push({ type: 'bus', name: busName, arn: busArn });

  // 5. Runtime role.
  let roleArn = input.roleArn;
  if (!roleArn) {
    const role = await ensureRole(ctx, {
      name: names.role(app, stage),
      path: IAM_APP_PATH,
      description: `Runtime role for ${app}/${stage}`,
      trust: stageTrustPolicy(),
      inlinePolicies: {
        runtime: stageRolePolicy({ app, stage, region, accountId: acct, manifest: m, platform }),
      },
      ...(platform.boundaryPolicyArn ? { boundaryArn: platform.boundaryPolicyArn } : {}),
      tags,
    });
    roleArn = role.arn;
    resources.push({ type: 'role', name: role.name, arn: role.arn });
  }

  // 6. Auth client.
  let auth: Bindings['auth'];
  if (m.auth.enabled) {
    if (!platform.userPoolId) throw new Error('auth is enabled but the platform has no user pool');
    const clientId = await ensureUserPoolClient(ctx, {
      userPoolId: platform.userPoolId,
      name: names.userPoolClient(app, stage),
      callbackUrls: [`${url}${AUTH_ROUTES.callback}`],
      logoutUrls: [`${url}/`],
      passwordFlows: platform.target === 'emulator',
    });
    auth = {
      mode: platform.target === 'emulator' ? 'local' : 'cognito',
      userPoolId: platform.userPoolId,
      clientId,
      issuer: cognitoIssuer(region, platform.userPoolId),
      jwksUri: cognitoJwksUri(platform, platform.userPoolId),
      loginUrl: platform.loginUrl ?? url,
      required: m.auth.required,
    };
    resources.push({ type: 'user-pool-client', name: names.userPoolClient(app, stage) });
  } else if (platform.userPoolId) {
    await deleteUserPoolClient(ctx, platform.userPoolId, names.userPoolClient(app, stage));
  }

  // 7. Stage key. Created once and kept for the stage's life, so db cursors
  // survive redeploys. It goes in the bindings instead of being read from SSM
  // at runtime (no extra call or IAM grant) because it only guards SDK-issued
  // tokens: a leaked key lets someone read or forge cursors, not read data.
  const stageKey = await ensureParameterOnce(ctx, {
    name: names.stageKeyParameter(app, stage),
    secure: true,
    description: `Stage key for ${app}/${stage} (SDK-sealed tokens such as db cursors)`,
    generate: () => randomBytes(32).toString('base64url'),
  });

  // 8. Bindings.
  const bindings: Bindings = {
    v: 1,
    app,
    stage,
    host,
    url,
    revision: deploymentId,
    region,
    ...(table ? { table } : {}),
    queues,
    bus: { name: busName, arn: busArn },
    ...(m.storage.length
      ? {
          storage: {
            bucket: platform.storageBucket,
            prefix: names.storagePrefix(app, stage),
            stores: m.storage,
          },
        }
      : {}),
    secrets: {
      path: names.secretsPath(app, stage),
      sharedPath: names.sharedSecretsPath(app),
      names: m.secrets,
    },
    ...(auth ? { auth } : {}),
    ...(hasWorker ? { worker: workerName } : {}),
    stageKey,
  };
  const env = {
    [BINDINGS_ENV]: encodeBindings(bindings),
    NODE_OPTIONS: '--enable-source-maps',
    ...m.env,
    ...input.extraEnv,
  };

  // 9. Worker + its triggers.
  let workerFunction: DeployStageResult['workerFunction'];
  if (hasWorker && m.worker && input.artifacts.worker) {
    const fn = await ensureFunction(ctx, {
      name: workerName,
      roleArn,
      runtime: NODE_RUNTIME,
      handler: 'index.handler',
      architecture: 'arm64',
      memoryMb: m.worker.memoryMb,
      timeoutSeconds: m.worker.timeoutSeconds,
      code: input.artifacts.worker,
      env,
      logGroup: workerLogGroup,
      description: `${app}/${stage} worker (${deploymentId})`,
      tags,
    });
    workerFunction = { name: fn.name, arn: fn.arn };
    resources.push({ type: 'function', name: fn.name, arn: fn.arn });
    await reconcileWorkerTriggers(ctx, {
      app,
      stage,
      manifest: m,
      workerName,
      workerArn: fn.arn,
      roleArn,
      busName,
      queues,
      tags,
      resources,
    });
  } else {
    await removeWorker(ctx, app, stage);
  }

  // The route the edge serves now. The new revision goes on the endpoint it doesn't use, and GC keeps
  // its static files: edges keep serving it until they pick up the new route.
  const liveRoute =
    webMode === 'function' && platform.kvsArn ? await getRoute(ctx, platform.kvsArn, host) : undefined;

  // 10. Static files (new prefix per deployment; the old one keeps serving until the route flips).
  let staticPrefix: string | undefined;
  if (input.artifacts.static) {
    staticPrefix = names.sitePrefix(app, stage, deploymentId);
    await publishStaticZip(ctx, {
      source: input.artifacts.static,
      bucket: platform.sitesBucket,
      prefix: staticPrefix,
    });
    resources.push({ type: 'static', name: staticPrefix });
  }

  // 11. Web Function revision → an endpoint the live route doesn't use.
  let webFunction: DeployStageResult['webFunction'];
  if (hasWeb && m.web && input.artifacts.server) {
    const fnName = names.webFunction(app, stage);
    const revision = {
      functionName: fnName,
      code: input.artifacts.server,
      runtime: NODE_RUNTIME,
      roleArn,
      env: { ...env, AWS_LAMBDA_NODEJS_ENTRYPOINT: 'index.mjs' },
      timeoutSeconds: m.web.timeoutSeconds,
      maxConcurrency: m.web.concurrency,
      logGroup: webLogGroup,
      description: deploymentId,
    };
    const fn = await ensureWebFunction(ctx, {
      name: fnName,
      tags,
      initial: { revision, endpointName: names.webEndpoints()[0] },
    });
    const fnArn = fn.arn;
    const revisionId = fn.initialRevisionId ?? (await createRevision(ctx, revision));
    const endpoint = await endpointForRevision(ctx, {
      functionName: fnName,
      functionArn: fnArn,
      endpointNames: names.webEndpoints(),
      revisionId,
      ...(liveRoute?.o ? { liveDomain: liveRoute.o } : {}),
      ...(platform.distributionArn ? { distributionArn: platform.distributionArn } : {}),
    });
    await pruneRevisions(ctx, fnName, { keepNewest: DEPLOYMENTS_KEPT, keep: endpoint.pinned });
    webFunction = { name: fnName, endpointDomain: endpoint.domainName, revisionId };
    resources.push({ type: 'web-function', name: fnName, arn: fnArn });
  } else if (webMode === 'function') {
    await deleteWebFunction(ctx, names.webFunction(app, stage));
  }

  // 12. Route flip — the only step that changes what users see.
  let route: RouteRecord | undefined;
  if (webMode === 'function' && (webFunction || staticPrefix)) {
    route = {
      v: 1,
      app,
      stage,
      d: deploymentId,
      ...(webFunction ? { o: webFunction.endpointDomain } : {}),
      ...(staticPrefix ? { s: staticPrefix } : {}),
      ...(webFunction && staticPrefix ? { r: m.web?.serverRoutes ?? ['/api/'] } : {}),
      ...(staticPrefix ? { spa: m.web?.spa === false ? (0 as const) : (1 as const) } : {}),
    };
    if (platform.kvsArn) {
      await putRoute(ctx, platform.kvsArn, host, route);
      resources.push({ type: 'route', name: host });
    } else {
      ctx.log('warn', 'platform has no route store; skipping route flip', `route ${host}`);
    }
  }

  // 13. Garbage-collect old static deployments.
  if (staticPrefix) {
    const prefixes = await listChildPrefixes(ctx, platform.sitesBucket, `${app}/${stage}/`);
    for (const p of staleStaticPrefixes(prefixes, [staticPrefix, liveRoute?.s])) {
      await deletePrefix(ctx, platform.sitesBucket, p);
    }
  }

  // 14. Queues removed from the manifest.
  const wantedQueues = new Set(
    Object.keys(m.queues).flatMap((k) => [names.queue(app, stage, k), names.deadLetterQueue(app, stage, k)]),
  );
  for (const q of await listQueues(ctx, `${base}--`)) {
    if (!wantedQueues.has(q.name)) await deleteQueue(ctx, q.name);
  }

  ctx.log('info', `deployed ${app}/${stage} → ${url}`);
  return {
    bindings,
    host,
    url,
    ...(route ? { route } : {}),
    ...(webFunction ? { webFunction } : {}),
    ...(workerFunction ? { workerFunction } : {}),
    resources,
  };
}

async function reconcileWorkerTriggers(
  ctx: EngineContext,
  p: {
    app: string;
    stage: string;
    manifest: ResolvedManifest;
    workerName: string;
    workerArn: string;
    roleArn: string;
    busName: string;
    queues: Bindings['queues'];
    tags: Record<string, string>;
    resources: ResourceRef[];
  },
): Promise<void> {
  const { app, stage, manifest: m } = p;
  const base = names.base(app, stage);

  // Queue → worker mappings.
  const wantedSources = new Set<string>();
  for (const [key, q] of Object.entries(m.queues)) {
    const source = p.queues[key]!.arn;
    wantedSources.add(source);
    await ensureEventSourceMapping(ctx, {
      functionName: p.workerName,
      sourceArn: source,
      batchSize: q.batchSize,
      ...(q.concurrency ? { maxConcurrency: q.concurrency } : {}),
    });
    p.resources.push({ type: 'esm', name: `${key} → worker` });
  }
  for (const esm of await listEventSourceMappings(ctx, p.workerName)) {
    if (!wantedSources.has(esm.sourceArn)) await deleteEventSourceMapping(ctx, esm.uuid);
  }

  // Event subscriptions → rules on the stage bus.
  const wantedRules = new Set<string>();
  for (const type of m.events) {
    const ruleName = names.eventRule(app, stage, type);
    wantedRules.add(ruleName);
    const ruleArn = await ensureRule(ctx, {
      bus: p.busName,
      name: ruleName,
      pattern: { 'detail-type': [type] },
      targets: [{ id: 'worker', arn: p.workerArn }],
      tags: p.tags,
    });
    await ensurePermission(ctx, {
      functionName: p.workerName,
      statementId: statementId('events', ruleName),
      principal: 'events.amazonaws.com',
      action: 'lambda:InvokeFunction',
      sourceArn: ruleArn,
    });
    p.resources.push({ type: 'rule', name: ruleName, arn: ruleArn });
  }
  for (const rule of await listRules(ctx, p.busName, `${base}--`)) {
    if (wantedRules.has(rule)) continue;
    await deleteRule(ctx, p.busName, rule);
    await removePermission(ctx, p.workerName, statementId('events', rule));
  }

  // Crons → schedules (EventBridge Scheduler invokes the worker with the stage role).
  const group = names.scheduleGroup(app, stage);
  const cronKeys = Object.keys(m.crons);
  if (cronKeys.length) await ensureScheduleGroup(ctx, { name: group, tags: p.tags });
  for (const [key, cron] of Object.entries(m.crons)) {
    await ensureSchedule(ctx, {
      group,
      name: names.schedule(key),
      expression: toSchedulerExpression(cron.schedule),
      ...(cron.timezone ? { timezone: cron.timezone } : {}),
      target: {
        arn: p.workerArn,
        roleArn: p.roleArn,
        input: JSON.stringify({ __platform: 'cron', name: key }),
      },
    });
    p.resources.push({ type: 'schedule', name: `${group}/${key}` });
  }
  const existing = await listSchedules(ctx, group);
  for (const s of existing) if (!cronKeys.includes(s)) await deleteSchedule(ctx, group, s);
  if (!cronKeys.length && existing.length) await deleteScheduleGroup(ctx, group);
}

/** The manifest no longer has a worker: remove it and everything that targets it. */
async function removeWorker(ctx: EngineContext, app: string, stage: string): Promise<void> {
  const workerName = names.workerFunction(app, stage);
  await deleteScheduleGroup(ctx, names.scheduleGroup(app, stage));
  const bus = names.eventBus(app, stage);
  for (const rule of await listRules(ctx, bus, `${names.base(app, stage)}--`))
    await deleteRule(ctx, bus, rule);
  for (const esm of await listEventSourceMappings(ctx, workerName))
    await deleteEventSourceMapping(ctx, esm.uuid);
  await deleteFunction(ctx, workerName);
}

/**
 * Static prefixes (`<app>/<stage>/<deployment>/`) to delete after a deploy:
 * all but the newest few, never one in `keep`. That includes the prefix the
 * previous route pointed at: edges that haven't picked up the new route
 * still serve it, and it is what a rollback returns to. After a rollback to
 * an earlier deployment it can be older than the newest few.
 */
export function staleStaticPrefixes(prefixes: string[], keep: Array<string | undefined>): string[] {
  const kept = new Set(keep.filter(Boolean).map((k) => `${k}/`));
  // Deployment ids sort by creation time.
  return [...prefixes]
    .sort()
    .reverse()
    .slice(DEPLOYMENTS_KEPT)
    .filter((p) => !kept.has(p));
}

/**
 * Rollback targets lose their files to garbage collection after enough
 * deploys. Check before changing anything, so a stage is never pointed at a
 * deployment that can no longer serve.
 */
async function assertCanRollBack(ctx: EngineContext, input: RollbackStageInput): Promise<void> {
  const { app, stage, platform, route } = input;
  const gone = (what: string) => new Error(`deployment ${route.d} can't be rolled back to: ${what}`);
  if (route.s && !(await hasObjects(ctx, platform.sitesBucket, `${route.s}/`))) {
    throw gone('its static files have been cleaned up');
  }
  if (input.revisionId) {
    const state = await getRevisionState(ctx, names.webFunction(app, stage), input.revisionId);
    if (!state) throw gone('its server revision has been cleaned up');
    if (state !== 'Active') throw gone(`its server revision is ${state}`);
  }
}

/**
 * Point the stage back at an earlier deployment. Its revision usually still
 * has an endpoint pinned to it (always for the previous deployment), so the
 * route write is the whole switch; otherwise the endpoint the live route
 * doesn't use is pointed at it first. Returns the route written: its
 * endpoint can differ from the one recorded at deploy time.
 */
export async function rollbackStage(ctx: EngineContext, input: RollbackStageInput): Promise<RouteRecord> {
  const { app, stage, platform } = input;
  await assertCanRollBack(ctx, input);
  const host = hostFor(platform, app, stage);
  let route = input.route;
  if (input.revisionId && route.o) {
    const functionName = names.webFunction(app, stage);
    const fn = await ctx.clients.lambdaWeb.send(new GetWebFunctionCommand({ functionName }));
    const live = platform.kvsArn ? await getRoute(ctx, platform.kvsArn, host) : undefined;
    const endpoint = await endpointForRevision(ctx, {
      functionName,
      functionArn: fn.functionArn!,
      endpointNames: names.webEndpoints(),
      revisionId: input.revisionId,
      ...(live?.o ? { liveDomain: live.o } : {}),
      ...(platform.distributionArn ? { distributionArn: platform.distributionArn } : {}),
    });
    route = { ...route, o: endpoint.domainName };
  }
  if (platform.kvsArn) await putRoute(ctx, platform.kvsArn, host, route);
  ctx.log('info', `rolled back ${app}/${stage} to ${route.d}`);
  return route;
}

/** Remove a stage. Order: stop traffic, stop triggers, compute, messaging, identity, then (optionally) data. */
export async function destroyStage(ctx: EngineContext, input: DestroyStageInput): Promise<void> {
  const { app, stage, platform } = input;
  const host = hostFor(platform, app, stage);
  ctx.log('info', `destroying ${app}/${stage}${input.keepData ? ' (keeping data)' : ''}`);

  if (platform.kvsArn) await ignoreNotFound(deleteRoute(ctx, platform.kvsArn, host));
  await removeWorker(ctx, app, stage);
  await deleteWebFunction(ctx, names.webFunction(app, stage));
  for (const q of await listQueues(ctx, `${names.base(app, stage)}--`)) await deleteQueue(ctx, q.name);
  await deleteEventBus(ctx, names.eventBus(app, stage));
  if (platform.userPoolId)
    await deleteUserPoolClient(ctx, platform.userPoolId, names.userPoolClient(app, stage));
  await deleteRole(ctx, names.role(app, stage));
  await deleteParameter(ctx, names.stageKeyParameter(app, stage));
  for (const g of await listLogGroups(ctx, names.logGroupPrefix(app, stage))) await deleteLogGroup(ctx, g);
  await deletePrefix(ctx, platform.sitesBucket, `${app}/${stage}/`);
  await deletePrefix(ctx, platform.artifactsBucket, `${app}/${stage}/`);
  if (!input.keepData) {
    await deleteTable(ctx, names.table(app, stage));
    await deletePrefix(ctx, platform.storageBucket, names.storagePrefix(app, stage));
    await deleteParametersByPath(ctx, names.secretsPath(app, stage));
  }
  ctx.log('info', `destroyed ${app}/${stage}`);
}

/** Everything the engine owns for a stage, found by deterministic names. */
export async function listStageResources(
  ctx: EngineContext,
  app: string,
  stage: string,
): Promise<ResourceRef[]> {
  const out: ResourceRef[] = [];
  const role = await ignoreNotFound(
    ctx.clients.iam.send(new GetRoleCommand({ RoleName: names.role(app, stage) })),
  );
  if (role?.Role) out.push({ type: 'role', name: role.Role.RoleName!, arn: role.Role.Arn! });
  const table = await describeTable(ctx, names.table(app, stage));
  if (table) out.push({ type: 'table', name: table.TableName!, arn: table.TableArn! });
  const worker = await ignoreNotFound(
    ctx.clients.lambda.send(
      new GetFunctionConfigurationCommand({ FunctionName: names.workerFunction(app, stage) }),
    ),
  );
  if (worker?.FunctionArn)
    out.push({ type: 'function', name: worker.FunctionName!, arn: worker.FunctionArn });
  const web = await ignoreNotFound(
    ctx.clients.lambdaWeb.send(new GetWebFunctionCommand({ functionName: names.webFunction(app, stage) })),
  );
  if (web?.functionArn) out.push({ type: 'web-function', name: web.functionName!, arn: web.functionArn });
  const bus = await ignoreNotFound(
    ctx.clients.events.send(new DescribeEventBusCommand({ Name: names.eventBus(app, stage) })),
  );
  if (bus?.Arn) {
    out.push({ type: 'bus', name: bus.Name!, arn: bus.Arn });
    for (const r of await listRules(ctx, bus.Name!, `${names.base(app, stage)}--`))
      out.push({ type: 'rule', name: r });
  }
  for (const q of await listQueues(ctx, `${names.base(app, stage)}--`))
    out.push({ type: 'queue', name: q.name });
  const group = names.scheduleGroup(app, stage);
  for (const s of await listSchedules(ctx, group)) out.push({ type: 'schedule', name: `${group}/${s}` });
  for (const g of await listLogGroups(ctx, names.logGroupPrefix(app, stage)))
    out.push({ type: 'log-group', name: g });
  return out;
}
