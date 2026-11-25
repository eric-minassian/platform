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
  DEFAULT_ATTEMPTS,
  type DeadLetter,
  type EmailBindings,
  emailDailyLimit,
  emailFromAddress,
  encodeBindings,
  type HandlerKind,
  handlerFunctionName,
  handlerKey,
  handlerSettings,
  IAM_APP_PATH,
  isJobSchedule,
  JOB_MARKER,
  LOCAL_STAGE,
  NODE_RUNTIME,
  names,
  newId,
  originSecret,
  ownFunctionHandlers,
  type PlatformRuntimeConfig,
  PROD_STAGE,
  platformNames,
  publicStores,
  publicUrl,
  RESOURCE_KEY_PATTERN,
  type ResolvedManifest,
  type RouteRecord,
  realtimeEndpoints,
  stageHost,
  toSchedulerExpression,
  validateStageName,
  workerHandlers,
  webMaxEnvironments,
} from '@ericminassian/platform-core';
import {
  deleteChannelNamespace,
  ensureChannelNamespace,
  ensureRealtimePlatform,
  findEventApi,
  getChannelNamespace,
} from './drivers/appsync.ts';
import { deleteUserPoolClient, ensureLoginBranding, ensureUserPoolClient } from './drivers/cognito.ts';
import { deleteTable, describeTable, ensureTable, stageTableSpec } from './drivers/dynamodb.ts';
import { deleteEventBus, deleteRule, ensureEventBus, ensureRule, listRules } from './drivers/events.ts';
import { deleteRole, ensureRole } from './drivers/iam.ts';
import { deleteRoute, getRoute, putRoute } from './drivers/kvs.ts';
import {
  deleteEventSourceMapping,
  deleteFunction,
  ensureAsyncConfig,
  ensureEventSourceMapping,
  ensureFunction,
  ensurePermission,
  type FunctionState,
  listEventSourceMappings,
  listFunctions,
  ensureReservedConcurrency,
  listPermissionIds,
  removePermission,
} from './drivers/lambda.ts';
import { deleteLogGroup, ensureLogGroup, listLogGroups } from './drivers/logs.ts';
import {
  aliasForVersion,
  getVersionState,
  publishRequestFunction,
  pruneVersions,
} from './drivers/request-function.ts';
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
  listQueues,
  moveMessages,
  queueDepth,
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
import { loginBranding } from './login-branding.ts';
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
 * Crons, jobs' retries and delayed sends, and preview stop schedules share the
 * stage's schedule group. Cron keys start with a letter and can't contain
 * `--`; a job's schedule starts with `_` and a service's stop schedule is
 * `<key>--stop`.
 */
const isCronSchedule = (name: string) => !name.includes('--') && !isJobSchedule(name);

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
 * data/messaging → role → worker → services (started) → static → server
 * build → services (running) → route (last) → GC.
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

  // 3. Jobs: the stage's dead-letter queue. Queues have no SQS queue of their own (they're async
  // invokes, core jobs.ts); queues from before that drain first (step 9).
  let deadLetters: { url: string; arn: string } | undefined;
  if (hasWorker) {
    const dead = await ensureDeadLetterQueue(ctx, { app, stage, region, accountId: acct, tags });
    deadLetters = { url: dead.url, arn: dead.arn };
    resources.push({ type: 'queue', name: dead.name, arn: dead.arn });
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
    });
    if (ctx.target === 'aws')
      await ensureLoginBranding(ctx, {
        userPoolId: platform.userPoolId,
        clientId,
        name: names.userPoolClient(app, stage),
        branding: loginBranding({ app, domain: platform.domain }),
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
  const jobs: Bindings['jobs'] = deadLetters
    ? {
        queues: Object.keys(m.queues),
        fns: Object.fromEntries(
          ownFunctionHandlers(m).map((h) => [
            handlerKey(h.kind, h.name),
            names.handlerFunction(app, stage, h.kind, h.name),
          ]),
        ),
        attempts: Object.fromEntries(
          workerHandlers(m)
            .filter((h) => h.maxAttempts !== DEFAULT_ATTEMPTS[h.kind])
            .map((h) => [handlerKey(h.kind, h.name), h.maxAttempts]),
        ),
        dead: deadLetters.url,
        group: names.scheduleGroup(app, stage),
        role: roleArn,
      }
    : undefined;
  const bindings: Bindings = {
    v: 2,
    app,
    stage,
    host,
    url,
    revision: deploymentId,
    region,
    account: acct,
    ...(table ? { table } : {}),
    ...(jobs ? { jobs } : {}),
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

  // 9. Worker + its triggers. A handler that sets its own memory, timeout or concurrency runs in a
  // function of its own: same bundle, environment and log group, other settings (Lambda sets them
  // per function).
  let workerFunction: DeployStageResult['workerFunction'];
  // Queues from before jobs were pushed: the ones that still hold messages drain through their
  // event source mappings (the SDK still reads SQS batches); the rest go after the triggers move.
  const legacy = await listLegacyQueues(ctx, { app, stage, manifest: m, region, accountId: acct });
  if (hasWorker && m.worker && input.artifacts.worker && deadLetters) {
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
    // Crashes and timeouts (Lambda's retries) end in the dead-letter queue too; a queue's
    // concurrency is its own function's reserved concurrency, and a cap no longer declared goes.
    const concurrency = new Map(
      ownFunctionHandlers(m).map((h) => [names.handlerFunction(app, stage, h.kind, h.name), h.concurrency]),
    );
    await settleAll(
      functions.map(async (f) => {
        await ensureAsyncConfig(ctx, { functionName: f.name, deadLetterArn: deadLetters.arn });
        await ensureReservedConcurrency(ctx, f.name, concurrency.get(f.name));
      }),
    );
    await reconcileWorkerTriggers(ctx, {
      app,
      stage,
      manifest: m,
      functions,
      roleArn,
      busName,
      deadLetterArn: deadLetters.arn,
      draining: legacy.draining,
      tags,
      resources,
    });
  } else {
    await removeWorker(ctx, app, stage);
  }
  await retireLegacyQueues(ctx, { app, stage, legacy, deadLetters });

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

  // 11. The server, in its compute mode, on the endpoint or function URL the live route doesn't
  // use. The other mode's server stays as it is (both cost nothing idle), so switching back or
  // rolling back to a deployment in the other mode finds it.
  const compute = input.webCompute ?? 'instance';
  let webFunction: DeployStageResult['webFunction'];
  let requestFunction: DeployStageResult['requestFunction'];
  if (hasWeb && m.web && input.artifacts.server && compute === 'request') {
    const fnName = names.requestFunction(app, stage);
    const fn = await publishRequestFunction(ctx, {
      name: fnName,
      roleArn,
      code: input.artifacts.server,
      env,
      memoryMb: m.web.memoryMb,
      timeoutSeconds: m.web.timeoutSeconds,
      logGroup: webLogGroup,
      deploymentId,
      description: `${app}/${stage} server (${deploymentId})`,
      tags,
    });
    const alias = await aliasForVersion(ctx, {
      functionName: fnName,
      aliasNames: names.webEndpoints(),
      version: fn.version,
      ...(liveRoute?.c === 'r' && liveRoute.o ? { liveDomain: liveRoute.o } : {}),
    });
    await pruneVersions(ctx, fnName, { keepNewest: DEPLOYMENTS_KEPT, keep: alias.pinned });
    requestFunction = { name: fnName, urlDomain: alias.domainName, version: fn.version };
    resources.push({ type: 'function', name: fnName, arn: fn.arn });
  } else if (hasWeb && m.web && input.artifacts.server) {
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
    const maxEnvironments = webMaxEnvironments(m.web, stage);
    const fn = await ensureWebFunction(ctx, {
      name: fnName,
      tags,
      initial: { revision, endpointName: names.webEndpoints()[0], maxEnvironments },
    });
    const fnArn = fn.arn;
    const revisionId = fn.initialRevisionId ?? (await createRevision(ctx, revision));
    const endpoint = await endpointForRevision(ctx, {
      functionName: fnName,
      functionArn: fnArn,
      endpointNames: names.webEndpoints(),
      revisionId,
      maxEnvironments,
      ...(liveRoute?.o && liveRoute.c !== 'r' ? { liveDomain: liveRoute.o } : {}),
      ...(platform.distributionArn ? { distributionArn: platform.distributionArn } : {}),
    });
    await pruneRevisions(ctx, fnName, { keepNewest: DEPLOYMENTS_KEPT, keep: endpoint.pinned });
    webFunction = { name: fnName, endpointDomain: endpoint.domainName, revisionId };
    resources.push({ type: 'web-function', name: fnName, arn: fnArn });
  } else if (webMode === 'function') {
    await deleteWebFunction(ctx, names.webFunction(app, stage));
    await deleteFunction(ctx, names.requestFunction(app, stage));
  }
  const server = webFunction
    ? { o: webFunction.endpointDomain }
    : requestFunction
      ? { o: requestFunction.urlDomain, c: 'r' as const, k: await originSecret(stageKey) }
      : undefined;

  // 11b. Every service that should run is running (a failed rollout fails the deploy here).
  if (platform.containers && rollouts.length)
    await awaitServiceRollouts(ctx, { cluster: platform.containers.cluster, rollouts });

  // 12. Route flip — the only step that changes what users see. A stage with public stores is
  // routed even without web, so its files have a host.
  let route: RouteRecord | undefined;
  if (webMode === 'function' && (server || staticPrefix || servedStores.length)) {
    route = {
      v: 1,
      app,
      stage,
      d: deploymentId,
      ...server,
      ...(staticPrefix ? { s: staticPrefix } : {}),
      ...(server && staticPrefix ? { r: m.web?.serverRoutes ?? ['/api/'] } : {}),
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
    // The group holds crons and jobs' retries and delayed sends while there's a worker.
    if (!hasWorker) await deleteScheduleGroupIfEmpty(ctx, names.scheduleGroup(app, stage));
  }

  // 14. Realtime removed from the manifest: the route no longer advertises it, so the namespace
  // can go (open connections to it are dropped by AppSync).
  if (!m.realtime && platform.realtime) {
    await deleteChannelNamespace(ctx, platform.realtime.apiId, names.realtimeNamespace(app, stage));
  }

  ctx.log('info', `deployed ${app}/${stage} → ${url}`);
  return {
    bindings,
    host,
    url,
    ...(route ? { route } : {}),
    ...(server ? { compute } : {}),
    ...(webFunction ? { webFunction } : {}),
    ...(requestFunction ? { requestFunction } : {}),
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
 * Points each event subscription and cron at the function its handler runs
 * in, keeps draining pre-0.4.0 queues that still hold messages, then removes
 * handler functions no longer declared. A trigger reaches its new function
 * before it leaves the old one. Queue messages need no trigger: the SDK
 * invokes the function directly.
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
    /** The stage's dead-letter queue: where triggers send what they couldn't deliver. */
    deadLetterArn: string;
    /** Pre-0.4.0 queues still holding messages, by key. */
    draining: ReadonlyArray<{ key: string; url: string; arn: string }>;
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
  const stale = (await listWorkerFunctions(ctx, app, stage)).filter((f) => !arns.has(f.name));

  // Pre-0.4.0 queue → function mappings, while their queues drain.
  const wantedMappings = new Set<string>();
  for (const q of p.draining) {
    const fn = target('queue', q.key);
    wantedMappings.add(`${fn.name} ${q.arn}`);
    // Lambda refuses a mapping whose queue hides a message for less than the function may run; the
    // handler's timeout can have grown since the queue was made. 6× is AWS's advice.
    const timeout = handlerSettings(m, 'queue', q.key).timeoutSeconds;
    await setQueueAttributes(ctx, q.url, { VisibilityTimeout: String(Math.min(timeout * 6, 43_200)) });
    await ensureEventSourceMapping(ctx, { functionName: fn.name, sourceArn: q.arn, batchSize: 10 });
    p.resources.push({ type: 'esm', name: `${q.key} → ${fn.name} (draining)` });
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
      targets: [{ id: 'worker', arn: fn.arn, deadLetterArn: p.deadLetterArn }],
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
  // The group also holds jobs' retries and delayed sends, so it exists whenever there's a worker.
  const group = names.scheduleGroup(app, stage);
  const cronKeys = Object.keys(m.crons);
  await ensureScheduleGroup(ctx, { name: group, tags: p.tags });
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
      deadLetterArn: p.deadLetterArn,
    });
    p.resources.push({ type: 'schedule', name: `${group}/${key}` });
  }
  for (const s of await listSchedules(ctx, group))
    if (isCronSchedule(s) && !cronKeys.includes(s)) await deleteSchedule(ctx, group, s);

  // Nothing triggers these any more.
  for (const fn of stale) await deleteWorkerFunction(ctx, fn.name);
}

/**
 * The manifest no longer has a worker: remove its functions, everything that
 * targets them, and jobs waiting for them. Services' stop schedules stay (and
 * with them the group).
 */
async function removeWorker(ctx: EngineContext, app: string, stage: string): Promise<void> {
  const group = names.scheduleGroup(app, stage);
  const schedules = await listSchedules(ctx, group);
  for (const s of schedules) if (isCronSchedule(s) || isJobSchedule(s)) await deleteSchedule(ctx, group, s);
  await deleteScheduleGroupIfEmpty(ctx, group);
  const bus = names.eventBus(app, stage);
  for (const rule of await listRules(ctx, bus, `${names.base(app, stage)}--`))
    await deleteRule(ctx, bus, rule);
  for (const fn of await listWorkerFunctions(ctx, app, stage)) await deleteWorkerFunction(ctx, fn.name);
}

/**
 * The worker's function and its handlers' own: every function under the
 * stage's base but the request-mode server (`names.requestFunction`).
 */
async function listWorkerFunctions(ctx: EngineContext, app: string, stage: string) {
  const server = names.requestFunction(app, stage);
  return (await listFunctions(ctx, `${names.base(app, stage)}--`)).filter((f) => f.name !== server);
}

/**
 * The stage's dead-letter queue: kept 14 days, never polled. Lambda's
 * on-failure destination and Scheduler send to it as the stage role;
 * EventBridge, which has no role here, needs the queue's policy, scoped to
 * this stage's rules.
 */
async function ensureDeadLetterQueue(
  ctx: EngineContext,
  p: { app: string; stage: string; region: string; accountId: string; tags: Record<string, string> },
) {
  const name = names.deadLetters(p.app, p.stage);
  const arn = `arn:aws:sqs:${p.region}:${p.accountId}:${name}`;
  return ensureQueue(ctx, {
    name,
    attributes: {
      MessageRetentionPeriod: String(14 * 24 * 3600),
      Policy: JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          {
            Sid: 'StageRules',
            Effect: 'Allow',
            Principal: { Service: 'events.amazonaws.com' },
            Action: 'sqs:SendMessage',
            Resource: arn,
            Condition: {
              ArnLike: {
                'aws:SourceArn': `arn:aws:events:${p.region}:${p.accountId}:rule/${names.eventBus(p.app, p.stage)}/${names.base(p.app, p.stage)}--*`,
              },
            },
          },
        ],
      }),
    },
    tags: p.tags,
  });
}

interface LegacyQueues {
  /** Queues whose handler is still declared and that still hold messages: they keep their mapping. */
  draining: Array<{ key: string; name: string; url: string; arn: string }>;
  /** Every other pre-0.4.0 queue and dead-letter queue of the stage. */
  rest: Array<{ name: string; url: string; deadLetters: boolean }>;
}

/**
 * The stage's queues from before jobs were pushed (0.4.0): `<base>--<key>`
 * and `<base>--<key>--dlq`. Everything else under the base is the stage's
 * dead-letter queue or `plat dev`'s event tap.
 */
async function listLegacyQueues(
  ctx: EngineContext,
  p: { app: string; stage: string; manifest: ResolvedManifest; region: string; accountId: string },
): Promise<LegacyQueues> {
  const { app, stage, manifest: m } = p;
  const base = names.base(app, stage);
  const out: LegacyQueues = { draining: [], rest: [] };
  for (const q of await listQueues(ctx, `${base}--`)) {
    if (q.name === names.deadLetters(app, stage) || q.name === names.devEventTap(app, stage)) continue;
    const suffix = q.name.slice(base.length + 2);
    const deadLetters = suffix.endsWith('--dlq');
    const key = deadLetters ? suffix.slice(0, -5) : suffix;
    if (!RESOURCE_KEY_PATTERN.test(key)) continue;
    if (!deadLetters && m.worker && m.queues[key] && ((await queueDepth(ctx, q.url)) ?? 0) > 0) {
      const arn = `arn:aws:sqs:${p.region}:${p.accountId}:${q.name}`;
      out.draining.push({ key, name: q.name, url: q.url, arn });
      continue;
    }
    out.rest.push({ name: q.name, url: q.url, deadLetters });
  }
  return out;
}

/**
 * After the triggers moved: pre-0.4.0 dead-letter queues' messages move into
 * the stage's dead-letter queue (where the console redrives them), and every
 * old queue no longer draining is deleted. Without a worker there's nothing to
 * redrive to, so the stage's dead-letter queue goes too.
 */
async function retireLegacyQueues(
  ctx: EngineContext,
  p: {
    app: string;
    stage: string;
    legacy: LegacyQueues;
    deadLetters: { url: string; arn: string } | undefined;
  },
): Promise<void> {
  for (const q of p.legacy.rest) {
    if (q.deadLetters && p.deadLetters) {
      const key = q.name.slice(names.base(p.app, p.stage).length + 2, -5);
      const moved = await moveMessages(ctx, q.url, p.deadLetters.url, (body, receives) =>
        legacyDeadLetter(key, body, receives),
      );
      if (moved)
        ctx.log(
          'info',
          `moved ${moved} dead letters to ${names.deadLetters(p.app, p.stage)}`,
          `queue ${q.name}`,
        );
      // Messages in flight (someone reading the queue) keep it for the next deploy.
      if (((await queueDepth(ctx, q.url)) ?? 0) > 0) continue;
    }
    await deleteQueue(ctx, q.name);
  }
  if (!p.deadLetters) await deleteQueue(ctx, names.deadLetters(p.app, p.stage));
}

/** A pre-0.4.0 dead-lettered message, as the SDK would have dead-lettered it. */
export function legacyDeadLetter(queue: string, body: string, receives: number): string {
  let parsed: unknown = body;
  try {
    parsed = JSON.parse(body);
  } catch {
    // A body the SDK didn't encode stays a string.
  }
  const letter: DeadLetter = {
    v: 1,
    job: {
      __platform: JOB_MARKER,
      kind: 'queue',
      name: queue,
      id: newId('m'),
      attempt: receives,
      sentAt: Date.now(),
      body: parsed,
    },
    failedAt: Date.now(),
    error: { name: 'Unknown', message: 'dead-lettered by the queue this stage had before 0.4.0' },
  };
  return JSON.stringify(letter);
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
  if (route.o && route.c === 'r') {
    if (!input.version) throw gone('its server version was not recorded');
    const state = await getVersionState(ctx, names.requestFunction(app, stage), input.version);
    if (!state) throw gone('its server version has been cleaned up');
    if (state !== 'Active') throw gone(`its server version is ${state}`);
  } else if (input.revisionId) {
    const state = await getRevisionState(ctx, names.webFunction(app, stage), input.revisionId);
    if (!state) throw gone('its server revision has been cleaned up');
    if (state !== 'Active') throw gone(`its server revision is ${state}`);
  }
  return planServicesRollback(ctx, input, gone);
}

/**
 * Point the stage back at an earlier deployment, in the compute mode it ran
 * in. Its server build usually still has an endpoint or alias pinned to it
 * (always for the previous deployment in the same mode), so the route write
 * is the whole switch; otherwise the one the live route doesn't use is
 * pointed at it first. Returns the route written: its endpoint or function
 * URL can differ from the one recorded at deploy time.
 */
export async function rollbackStage(ctx: EngineContext, input: RollbackStageInput): Promise<RouteRecord> {
  const { app, stage, platform } = input;
  const services = await assertCanRollBack(ctx, input);
  await applyServicesRollback(ctx, services);
  const host = hostFor(platform, app, stage);
  let route = input.route;
  const live = route.o && platform.kvsArn ? await getRoute(ctx, platform.kvsArn, host) : undefined;
  if (route.o && route.c === 'r' && input.version) {
    const url = await aliasForVersion(ctx, {
      functionName: names.requestFunction(app, stage),
      aliasNames: names.webEndpoints(),
      version: input.version,
      ...(live?.c === 'r' && live.o ? { liveDomain: live.o } : {}),
    });
    route = { ...route, o: url.domainName };
  } else if (route.o && input.revisionId) {
    const functionName = names.webFunction(app, stage);
    const fn = await ctx.clients.lambdaWeb.send(new GetWebFunctionCommand({ functionName }));
    const endpoint = await endpointForRevision(ctx, {
      functionName,
      functionArn: fn.functionArn!,
      endpointNames: names.webEndpoints(),
      revisionId: input.revisionId,
      ...(live?.o && live.c !== 'r' ? { liveDomain: live.o } : {}),
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
  // Its versions, aliases and function URLs go with it.
  await deleteFunction(ctx, names.requestFunction(app, stage));
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
  // The worker's function, its handlers' own and the request-mode server.
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
