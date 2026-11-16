import { randomBytes } from 'node:crypto';
import { DescribeEventBusCommand } from '@aws-sdk/client-eventbridge';
import { GetRoleCommand } from '@aws-sdk/client-iam';
import { GetWebFunctionCommand } from '@aws-sdk/client-lambda-web';
import {
  AUTH_ROUTES,
  BINDINGS_ENV,
  type Bindings,
  cognitoIssuer,
  cognitoJwksUri,
  type EmailBindings,
  emailDailyLimit,
  emailFromAddress,
  encodeBindings,
  type HandlerKind,
  handlerFunctionName,
  handlerSettings,
  IAM_APP_PATH,
  LOCAL_STAGE,
  NODE_RUNTIME,
  names,
  ownFunctionHandlers,
  type PlatformRuntimeConfig,
  PROD_STAGE,
  platformNames,
  publicStores,
  publicUrl,
  type ResolvedManifest,
  type RouteRecord,
  realtimeEndpoints,
  stageHost,
  toSchedulerExpression,
  validateStageName,
} from '@ericminassian/platform-core';
import {
  deleteChannelNamespace,
  ensureChannelNamespace,
  ensureRealtimePlatform,
  findEventApi,
  getChannelNamespace,
} from './drivers/appsync.ts';
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
  type FunctionState,
  listEventSourceMappings,
  listFunctions,
  listPermissionIds,
  removePermission,
} from './drivers/lambda.ts';
import { deleteLogGroup, ensureLogGroup, listLogGroups } from './drivers/logs.ts';
import {
  deleteObjectsOlderThan,
  deletePrefix,
  hasObjects,
  listChildPrefixes,
  publishStaticZip,
} from './drivers/s3.ts';
import {
  deleteSchedule,
  deleteScheduleGroup,
  deleteScheduleGroupIfEmpty,
  ensureSchedule,
  ensureScheduleGroup,
  listSchedules,
} from './drivers/scheduler.ts';
import {
  deleteConfigurationSet,
  deleteTenant,
  ensureConfigurationSet,
  ensureTenant,
  ensureTenantResources,
  getConfigurationSet,
  getTenant,
} from './drivers/ses.ts';
import {
  deleteQueue,
  ensureQueue,
  getQueueVisibility,
  listQueues,
  setQueueAttributes,
} from './drivers/sqs.ts';
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
  ExpireStorageInput,
  ResourceRef,
  RollbackStageInput,
} from './index.ts';
import { configurationSetArn, stageRolePolicy, stageTrustPolicy } from './policy.ts';
import {
  applyServicesRollback,
  awaitServiceRollouts,
  destroyServices,
  listServiceResources,
  planServicesRollback,
  pruneServices,
  type ServiceRollout,
  type ServicesRollback,
  startServices,
} from './services.ts';
import { type EngineContext, ignoreNotFound, stageTags } from './util.ts';

/**
 * Deployments whose static files and server revision are kept per stage (the
 * newest ones, plus whatever the routes still use), so rollback can reach them.
 */
const DEPLOYMENTS_KEPT = 3;

/**
 * Crons and preview stop schedules share the stage's schedule group. Cron
 * keys can't contain `--`; a service's stop schedule (`<key>--stop`) does.
 */
const isCronSchedule = (name: string) => !name.includes('--');

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
 * data/messaging → role → worker → services (started) → static → web
 * revision → services (running) → route (last) → GC.
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
  const serviceKeys = Object.keys(m.services);
  const servicesOnEcs = (input.servicesMode ?? 'ecs') === 'ecs';
  const resources: ResourceRef[] = [];
  const workerName = names.workerFunction(app, stage);
  const servedStores = publicStores(m);

  if (hasWorker && !input.artifacts.worker)
    throw new Error('manifest declares a worker but no worker artifact was provided');
  if (hasWeb && !input.artifacts.server)
    throw new Error('manifest declares web.server but no server artifact was provided');
  if (m.realtime && !platform.realtime)
    throw new Error(
      "plat.config.ts declares realtime, but this platform has no realtime API yet (its foundation predates it): deploy the platform's foundation first",
    );
  if (m.email && !platform.email)
    throw new Error(
      "plat.config.ts declares email, but this platform has no mail domain yet (its foundation predates it): deploy the platform's foundation first",
    );
  if (serviceKeys.length && servicesOnEcs) {
    if (!platform.containers)
      throw new Error(
        "plat.config.ts declares services, but this platform has no container compute yet (its foundation predates it): deploy the platform's foundation first",
      );
    if (!input.artifacts.services)
      throw new Error('manifest declares services but no services artifact was provided');
  }

  ctx.log('info', `deploying ${app}/${stage} (${deploymentId})`);

  // The route the edge serves now. The new revision goes on the endpoint it doesn't use, GC keeps
  // its static files (edges keep serving it until they pick up the new route), and its public
  // stores are the ones whose files live under the public prefix.
  const liveRoute =
    webMode === 'function' && platform.kvsArn ? await getRoute(ctx, platform.kvsArn, host) : undefined;

  // 0. Checked before anything changes.
  await assertStoreVisibility(ctx, { app, stage, manifest: m, platform, liveRoute });

  // 1. Log groups (retention set before anything writes to them). These are all of them: the stage
  // role can't create log groups (see stageRolePolicy).
  const webLogGroup = names.logGroup(app, stage, 'web');
  const workerLogGroup = names.logGroup(app, stage, 'worker');
  if (hasWeb) {
    await ensureLogGroup(ctx, { name: webLogGroup, retentionDays: retention, tags });
    await ensureLogGroup(ctx, {
      name: names.logGroup(app, stage, 'web.local'),
      retentionDays: retention,
      tags,
    });
  }
  if (hasWorker) await ensureLogGroup(ctx, { name: workerLogGroup, retentionDays: retention, tags });
  for (const key of serviceKeys)
    await ensureLogGroup(ctx, {
      name: names.serviceLogGroup(app, stage, key),
      retentionDays: retention,
      tags,
    });

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

  // 3. Queues (dead-letter queue first). A queue's visibility timeout must cover the timeout of
  // each function receiving from it, and a queue whose handler moves to a function with a shorter
  // timeout keeps its old one until step 9 moves it. So a timeout is only raised here; one that
  // comes down is lowered after step 9.
  const queues: Bindings['queues'] = {};
  const lowerVisibility: Array<{ url: string; seconds: number }> = [];
  for (const [key, q] of Object.entries(m.queues)) {
    const dlq = await ensureQueue(ctx, {
      name: names.deadLetterQueue(app, stage, key),
      attributes: { MessageRetentionPeriod: String(14 * 24 * 3600) },
      tags,
    });
    const handlerTimeout = handlerSettings(m, 'queue', key).timeoutSeconds;
    let visibility = q.visibilityTimeoutSeconds;
    if (visibility < handlerTimeout) {
      ctx.log(
        'warn',
        `visibility timeout raised to the handler's timeout (${handlerTimeout}s)`,
        `queue ${key}`,
      );
      visibility = handlerTimeout;
    }
    const name = names.queue(app, stage, key);
    const current = await getQueueVisibility(ctx, name);
    const main = await ensureQueue(ctx, {
      name,
      attributes: {
        VisibilityTimeout: String(Math.max(visibility, current ?? 0)),
        MessageRetentionPeriod: String(4 * 24 * 3600),
        RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlq.arn, maxReceiveCount: q.maxReceiveCount }),
      },
      tags,
    });
    queues[key] = { url: main.url, arn: main.arn };
    if (current !== undefined && current > visibility)
      lowerVisibility.push({ url: main.url, seconds: visibility });
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

  // 7b. Realtime: the stage's channel namespace, ready before any code that
  // publishes to it (worker, web revision) and before the route advertises it.
  let realtime: Bindings['realtime'];
  if (m.realtime && platform.realtime) {
    const namespace = names.realtimeNamespace(app, stage);
    const ns = await ensureChannelNamespace(ctx, {
      apiId: platform.realtime.apiId,
      name: namespace,
      subscribe: m.realtime.subscribe,
      tags,
    });
    // The key and the router's entry normally exist (foundation deploy, nightly job); this makes
    // a first realtime deploy work regardless.
    await ensureRealtimePlatform(ctx, platform);
    realtime = {
      namespace,
      publishUrl: realtimeEndpoints(platform, platform.realtime).publishUrl,
      subscribe: m.realtime.subscribe,
      channels: m.realtime.channels,
    };
    resources.push({ type: 'channel-namespace', name: namespace, ...(ns.arn ? { arn: ns.arn } : {}) });
  }

  // 7c. Email: the stage's SES tenant, ready before any code that sends with it.
  const email = await reconcileStageEmail(ctx, { app, stage, manifest: m, platform, tags, resources });

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
            ...(servedStores.length
              ? { public: servedStores, publicPrefix: names.publicStoragePrefix(app, stage) }
              : {}),
          },
        }
      : {}),
    secrets: {
      path: names.secretsPath(app, stage),
      sharedPath: names.sharedSecretsPath(app),
      names: m.secrets,
    },
    ...(auth ? { auth } : {}),
    ...(realtime ? { realtime } : {}),
    ...(email ? { email } : {}),
    ...(hasWorker ? { worker: workerName } : {}),
    stageKey,
  };
  const env = {
    [BINDINGS_ENV]: encodeBindings(bindings),
    NODE_OPTIONS: '--enable-source-maps',
    ...m.env,
    ...input.extraEnv,
  };

  // 9. Worker + its triggers. A handler that sets its own memory or timeout runs in a function of
  // its own: same bundle, environment and log group, other settings (Lambda sets them per function).
  let workerFunction: DeployStageResult['workerFunction'];
  if (hasWorker && m.worker && input.artifacts.worker) {
    const code = input.artifacts.worker;
    const deployFunction = (
      name: string,
      settings: { memoryMb: number; timeoutSeconds: number },
      of: string,
    ) =>
      ensureFunction(ctx, {
        name,
        roleArn,
        runtime: NODE_RUNTIME,
        handler: 'index.handler',
        architecture: 'arm64',
        memoryMb: settings.memoryMb,
        timeoutSeconds: settings.timeoutSeconds,
        code,
        env,
        logGroup: workerLogGroup,
        description: `${app}/${stage} ${of} (${deploymentId})`,
        tags,
      });
    // Each takes seconds of updates and waits, and none depends on another.
    const functions = await settleAll([
      deployFunction(workerName, m.worker, 'worker'),
      ...ownFunctionHandlers(m).map((h) =>
        deployFunction(names.handlerFunction(app, stage, h.kind, h.name), h, `worker, ${h.kind} ${h.name}`),
      ),
    ]);
    const fn = functions[0]!;
    workerFunction = { name: fn.name, arn: fn.arn };
    for (const f of functions) resources.push({ type: 'function', name: f.name, arn: f.arn });
    await reconcileWorkerTriggers(ctx, {
      app,
      stage,
      manifest: m,
      functions,
      roleArn,
      busName,
      queues,
      tags,
      resources,
    });
  } else {
    await removeWorker(ctx, app, stage);
  }
  // Nothing with a longer timeout receives from these queues any more (step 3).
  for (const q of lowerVisibility)
    await setQueueAttributes(ctx, q.url, { VisibilityTimeout: String(q.seconds) });

  // 9b. Services: images, task definitions and ECS services. Their rollouts run while the static
  // files and the web revision go up, and must finish before the route flips.
  let services: DeployStageResult['services'];
  let rollouts: ServiceRollout[] = [];
  if (servicesOnEcs && serviceKeys.length && platform.containers && input.artifacts.services) {
    const started = await startServices(ctx, {
      app,
      stage,
      deploymentId,
      services: m.services,
      containers: platform.containers,
      region,
      roleArn,
      env,
      tags,
      artifact: input.artifacts.services,
      resources,
    });
    services = started.deployed;
    rollouts = started.rollouts;
  }
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

  // 11b. Every service that should run is running (a failed rollout fails the deploy here).
  if (platform.containers && rollouts.length)
    await awaitServiceRollouts(ctx, { cluster: platform.containers.cluster, rollouts });

  // 12. Route flip — the only step that changes what users see. A stage with public stores is
  // routed even without web, so its files have a host.
  let route: RouteRecord | undefined;
  if (webMode === 'function' && (webFunction || staticPrefix || servedStores.length)) {
    route = {
      v: 1,
      app,
      stage,
      d: deploymentId,
      ...(webFunction ? { o: webFunction.endpointDomain } : {}),
      ...(staticPrefix ? { s: staticPrefix } : {}),
      ...(webFunction && staticPrefix ? { r: m.web?.serverRoutes ?? ['/api/'] } : {}),
      ...(staticPrefix ? { spa: m.web?.spa === false ? (0 as const) : (1 as const) } : {}),
      ...(realtime
        ? {
            rt: {
              n: realtime.namespace,
              m: realtime.subscribe === 'signed-in' ? ('s' as const) : ('p' as const),
            },
          }
        : {}),
      ...(servedStores.length ? { p: servedStores } : {}),
    };
    if (platform.kvsArn) {
      await putRoute(ctx, platform.kvsArn, host, route);
      resources.push({ type: 'route', name: host });
    } else {
      ctx.log('warn', 'platform has no route store; skipping route flip', `route ${host}`);
    }
  } else if (liveRoute && platform.kvsArn) {
    // Nothing left to serve (no server, files or public stores): the host stops answering.
    await deleteRoute(ctx, platform.kvsArn, host);
    ctx.log('info', 'nothing to serve; removed the route', `route ${host}`);
  }

  // 13. Garbage-collect old static deployments.
  if (staticPrefix) {
    const prefixes = await listChildPrefixes(ctx, platform.sitesBucket, `${app}/${stage}/`);
    for (const p of staleStaticPrefixes(prefixes, [staticPrefix, liveRoute?.s])) {
      await deletePrefix(ctx, platform.sitesBucket, p);
    }
  }

  // 13b. Services removed from the manifest, and old builds of the rest. Kept: the newest few
  // deployments' builds, the one each service ran before this deploy and the previously live one
  // (rollback targets).
  if (servicesOnEcs && platform.containers) {
    await pruneServices(ctx, {
      app,
      stage,
      services: m.services,
      containers: platform.containers,
      keep: [deploymentId, liveRoute?.d],
      keepTaskDefinitions: rollouts.flatMap((r) => r.previousTaskDefinition ?? []),
      kept: DEPLOYMENTS_KEPT,
    });
    if (!hasWorker || !Object.keys(m.crons).length)
      await deleteScheduleGroupIfEmpty(ctx, names.scheduleGroup(app, stage));
  }

  // 14. Realtime removed from the manifest: the route no longer advertises it, so the namespace
  // can go (open connections to it are dropped by AppSync).
  if (!m.realtime && platform.realtime) {
    await deleteChannelNamespace(ctx, platform.realtime.apiId, names.realtimeNamespace(app, stage));
  }

  // 15. Queues removed from the manifest.
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
    ...(services ? { services } : {}),
    resources,
  };
}

/**
 * A stage's SES tenant and configuration set (both `names.emailTenant`),
 * associated with the platform's domain, and the bindings the SDK sends
 * with. Under `plat dev` and `plat test` the same resources exist in the
 * emulator, but the SDK hands mail to the CLI instead of sending (`local`).
 *
 * When `email` leaves the manifest the role loses its grant
 * (stageRolePolicy), but the tenant and its configuration set stay, like a
 * table when `db` goes: the tenant holds the stage's suppression list and any
 * pause SES put on it, and recreating it later would start both over.
 */
export async function reconcileStageEmail(
  ctx: EngineContext,
  p: {
    app: string;
    stage: string;
    manifest: Pick<ResolvedManifest, 'email'>;
    platform: Pick<PlatformRuntimeConfig, 'target' | 'telemetryTable' | 'email'>;
    tags: Record<string, string>;
    resources: ResourceRef[];
  },
): Promise<EmailBindings | undefined> {
  const { app, stage, platform } = p;
  const declared = p.manifest.email;
  const name = names.emailTenant(app, stage);
  // A platform without a mail domain can't have created a tenant (deployStage refuses `email`
  // there), and its control plane may not call SES at all.
  if (!platform.email) return undefined;
  if (!declared) {
    if (await getTenant(ctx, name))
      ctx.log(
        'warn',
        'email is off in plat.config.ts but the SES tenant still exists; keeping it (suppression list, sending status)',
        `email-tenant ${name}`,
      );
    return undefined;
  }
  const configurationSet = await ensureConfigurationSet(ctx, { name, tags: p.tags });
  const tenant = await ensureTenant(ctx, { name, tags: p.tags });
  await ensureTenantResources(ctx, name, [platform.email.identityArn, configurationSet.arn]);
  p.resources.push(
    { type: 'email-tenant', name, arn: tenant.arn },
    { type: 'configuration-set', name, arn: configurationSet.arn },
  );
  return {
    mode: platform.target === 'emulator' ? 'local' : 'ses',
    from: emailFromAddress(app, stage, platform.email.domain),
    ...(declared.name ? { name: declared.name } : {}),
    tenant: name,
    dailyLimit: emailDailyLimit(stage, declared.dailyLimit),
    usageTable: platform.telemetryTable,
  };
}

/** Destroy: the tenant (associations first), then its configuration set. */
async function deleteStageEmail(ctx: EngineContext, name: string): Promise<void> {
  await deleteTenant(ctx, name);
  await deleteConfigurationSet(ctx, name);
}

/**
 * A public store's files live under the public prefix and a private one's
 * don't (see core `storage.ts`), so a store can't switch once it has files:
 * the files would stay where the other kind is read, and moving them while
 * the live deployment still writes there could lose some. Whether a store is
 * public now is what the live route serves; without one, nothing is.
 */
async function assertStoreVisibility(
  ctx: EngineContext,
  p: {
    app: string;
    stage: string;
    manifest: ResolvedManifest;
    platform: PlatformRuntimeConfig;
    liveRoute: RouteRecord | undefined;
  },
): Promise<void> {
  const served = new Set(p.liveRoute?.p ?? []);
  const wanted = new Set(publicStores(p.manifest));
  for (const store of p.manifest.storage) {
    const wasPublic = served.has(store);
    if (wasPublic === wanted.has(store)) continue;
    const prefix = wasPublic
      ? names.publicStoragePrefix(p.app, p.stage, store)
      : names.storagePrefix(p.app, p.stage, store);
    if (!(await hasObjects(ctx, p.platform.storageBucket, prefix))) continue;
    const was = wasPublic ? 'public' : 'private';
    const now = wasPublic ? 'private' : 'public';
    throw new Error(
      `store "${store}" has files from when it was ${was}, and a store with files can't become ${now}: ` +
        `declare a new store in plat.config.ts for the ${now} files`,
    );
  }
}

/** Delete files not written for their store's `expireAfterDays`; answers how many, by store. */
export async function expireStorage(
  ctx: EngineContext,
  input: ExpireStorageInput,
): Promise<Record<string, number>> {
  const { app, stage, platform, manifest: m } = input;
  const now = input.now ?? new Date();
  const deleted: Record<string, number> = {};
  for (const store of m.storage) {
    const options = m.storageOptions[store];
    if (!options?.expireAfterDays) continue;
    const prefix = options.public
      ? names.publicStoragePrefix(app, stage, store)
      : names.storagePrefix(app, stage, store);
    const cutoff = new Date(now.getTime() - options.expireAfterDays * 86_400_000);
    deleted[store] = await deleteObjectsOlderThan(ctx, platform.storageBucket, prefix, cutoff);
    if (deleted[store]) ctx.log('info', `deleted ${deleted[store]} expired files`, `store ${prefix}`);
  }
  return deleted;
}

/** Waits for every promise, then fails with the first failure, so nothing runs on after a deploy fails. */
async function settleAll<T>(promises: Array<Promise<T>>): Promise<T[]> {
  const results = await Promise.allSettled(promises);
  const failed = results.find((r) => r.status === 'rejected');
  if (failed) throw failed.reason;
  return results.map((r) => (r as PromiseFulfilledResult<T>).value);
}

/**
 * Points each queue, event subscription and cron at the function its handler
 * runs in, then removes handler functions no longer declared. A trigger
 * reaches its new function before it leaves the old one.
 */
async function reconcileWorkerTriggers(
  ctx: EngineContext,
  p: {
    app: string;
    stage: string;
    manifest: ResolvedManifest;
    /** The worker's function, then each handler's own. */
    functions: FunctionState[];
    roleArn: string;
    busName: string;
    queues: Bindings['queues'];
    tags: Record<string, string>;
    resources: ResourceRef[];
  },
): Promise<void> {
  const { app, stage, manifest: m } = p;
  const base = names.base(app, stage);
  const arns = new Map(p.functions.map((f) => [f.name, f.arn]));
  const target = (kind: HandlerKind, name: string) => {
    const fn = handlerFunctionName(app, stage, m, kind, name);
    return { name: fn, arn: arns.get(fn)! };
  };
  // Every function under the stage's base is the worker's or a handler's.
  const stale = (await listFunctions(ctx, `${base}--`)).filter((f) => !arns.has(f.name));

  // Queue → function mappings.
  const wantedMappings = new Set<string>();
  for (const [key, q] of Object.entries(m.queues)) {
    const fn = target('queue', key);
    const source = p.queues[key]!.arn;
    wantedMappings.add(`${fn.name} ${source}`);
    await ensureEventSourceMapping(ctx, {
      functionName: fn.name,
      sourceArn: source,
      batchSize: q.batchSize,
      ...(q.concurrency ? { maxConcurrency: q.concurrency } : {}),
    });
    p.resources.push({ type: 'esm', name: `${key} → ${fn.name}` });
  }
  for (const fn of [...p.functions, ...stale]) {
    for (const esm of await listEventSourceMappings(ctx, fn.name)) {
      if (!wantedMappings.has(`${fn.name} ${esm.sourceArn}`)) await deleteEventSourceMapping(ctx, esm.uuid);
    }
  }

  // Event subscriptions → rules on the stage bus.
  const wantedRules = new Set<string>();
  const wantedGrants = new Set<string>();
  for (const type of m.events) {
    const fn = target('event', type);
    const ruleName = names.eventRule(app, stage, type);
    wantedRules.add(ruleName);
    const sid = statementId('events', ruleName);
    wantedGrants.add(`${fn.name} ${sid}`);
    const ruleArn = await ensureRule(ctx, {
      bus: p.busName,
      name: ruleName,
      pattern: { 'detail-type': [type] },
      targets: [{ id: 'worker', arn: fn.arn }],
      tags: p.tags,
      beforeTargets: (arn) =>
        ensurePermission(ctx, {
          functionName: fn.name,
          statementId: sid,
          principal: 'events.amazonaws.com',
          action: 'lambda:InvokeFunction',
          sourceArn: arn,
        }),
    });
    p.resources.push({ type: 'rule', name: ruleName, arn: ruleArn });
  }
  for (const rule of await listRules(ctx, p.busName, `${base}--`)) {
    if (!wantedRules.has(rule)) await deleteRule(ctx, p.busName, rule);
  }
  // Grants for rules that are gone or now target another function.
  for (const fn of p.functions) {
    for (const sid of await listPermissionIds(ctx, fn.name)) {
      if (sid.startsWith('events-') && !wantedGrants.has(`${fn.name} ${sid}`))
        await removePermission(ctx, fn.name, sid);
    }
  }

  // Crons → schedules (EventBridge Scheduler invokes the function with the stage role).
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
        arn: target('cron', key).arn,
        roleArn: p.roleArn,
        input: JSON.stringify({ __platform: 'cron', name: key }),
      },
    });
    p.resources.push({ type: 'schedule', name: `${group}/${key}` });
  }
  const existing = await listSchedules(ctx, group);
  for (const s of existing)
    if (isCronSchedule(s) && !cronKeys.includes(s)) await deleteSchedule(ctx, group, s);
  if (!cronKeys.length && existing.length) await deleteScheduleGroupIfEmpty(ctx, group);

  // Nothing triggers these any more.
  for (const fn of stale) await deleteWorkerFunction(ctx, fn.name);
}

/**
 * The manifest no longer has a worker: remove its functions and everything
 * that targets them. Services' stop schedules stay (and with them the group).
 */
async function removeWorker(ctx: EngineContext, app: string, stage: string): Promise<void> {
  const group = names.scheduleGroup(app, stage);
  const schedules = await listSchedules(ctx, group);
  for (const s of schedules) if (isCronSchedule(s)) await deleteSchedule(ctx, group, s);
  await deleteScheduleGroupIfEmpty(ctx, group);
  const bus = names.eventBus(app, stage);
  for (const rule of await listRules(ctx, bus, `${names.base(app, stage)}--`))
    await deleteRule(ctx, bus, rule);
  for (const fn of await listFunctions(ctx, `${names.base(app, stage)}--`))
    await deleteWorkerFunction(ctx, fn.name);
}

/** Lambda keeps a function's event source mappings when it deletes the function, so they go first. */
async function deleteWorkerFunction(ctx: EngineContext, name: string): Promise<void> {
  for (const esm of await listEventSourceMappings(ctx, name)) await deleteEventSourceMapping(ctx, esm.uuid);
  await deleteFunction(ctx, name);
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
  return prefixes
    .toSorted()
    .toReversed()
    .slice(DEPLOYMENTS_KEPT)
    .filter((p) => !kept.has(p));
}

/**
 * Rollback targets lose their files and builds to garbage collection after
 * enough deploys. Check before changing anything, so a stage is never
 * pointed at a deployment that can no longer serve. Returns what the
 * services go back to.
 */
async function assertCanRollBack(
  ctx: EngineContext,
  input: RollbackStageInput,
): Promise<ServicesRollback | undefined> {
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
  return planServicesRollback(ctx, input, gone);
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
  const services = await assertCanRollBack(ctx, input);
  await applyServicesRollback(ctx, services);
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
  if (platform.containers) await destroyServices(ctx, { app, stage, containers: platform.containers });
  await deleteScheduleGroup(ctx, names.scheduleGroup(app, stage));
  for (const q of await listQueues(ctx, `${names.base(app, stage)}--`)) await deleteQueue(ctx, q.name);
  await deleteEventBus(ctx, names.eventBus(app, stage));
  if (platform.realtime)
    await deleteChannelNamespace(ctx, platform.realtime.apiId, names.realtimeNamespace(app, stage));
  if (platform.email) await deleteStageEmail(ctx, names.emailTenant(app, stage));
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
    await deletePrefix(ctx, platform.storageBucket, names.publicStoragePrefix(app, stage));
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
  // The worker's function and its handlers' own.
  for (const fn of await listFunctions(ctx, `${names.base(app, stage)}--`))
    out.push({ type: 'function', name: fn.name, arn: fn.arn });
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
  // Found by name like everything else, so this needs no runtime config.
  const api = await findEventApi(ctx, platformNames.realtimeApi);
  const ns = api?.apiId
    ? await getChannelNamespace(ctx, api.apiId, names.realtimeNamespace(app, stage))
    : undefined;
  if (ns?.name)
    out.push({
      type: 'channel-namespace',
      name: ns.name,
      ...(ns.channelNamespaceArn ? { arn: ns.channelNamespaceArn } : {}),
    });
  const tenantName = names.emailTenant(app, stage);
  const tenant = await getTenant(ctx, tenantName);
  if (tenant) out.push({ type: 'email-tenant', name: tenant.name, arn: tenant.arn });
  if (await getConfigurationSet(ctx, tenantName))
    out.push({
      type: 'configuration-set',
      name: tenantName,
      arn: configurationSetArn(ctx.region, await ctx.accountId(), tenantName),
    });
  out.push(...(await listServiceResources(ctx, app, stage)));
  return out;
}
