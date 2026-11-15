import {
  CreateWebFunctionCommand,
  CreateWebFunctionEndpointCommand,
  CreateWebFunctionRevisionCommand,
  DeleteResourcePolicyCommand,
  DeleteWebFunctionCommand,
  DeleteWebFunctionEndpointCommand,
  DeleteWebFunctionRevisionCommand,
  GetResourcePolicyCommand,
  GetWebFunctionCommand,
  GetWebFunctionEndpointCommand,
  GetWebFunctionRevisionCommand,
  ListWebFunctionEndpointsCommand,
  ListWebFunctionRevisionsCommand,
  PutResourcePolicyCommand,
  UpdateWebFunctionEndpointCommand,
} from '@aws-sdk/client-lambda-web';
import type { S3Location } from '../index.ts';
import {
  type EngineContext,
  errorMessage,
  errorName,
  ignoreNotFound,
  isNotImplemented,
  retry,
  waitFor,
} from '../util.ts';

/**
 * Lambda Web Functions (launched 2026-10): a function holds immutable
 * revisions; an endpoint routes traffic to up to two revisions by weight.
 *
 * The engine gives each stage two endpoints and pins each to one revision
 * (100%). A route record names an endpoint, so the route flip switches
 * static files and server together at each edge: edges still on the old
 * route keep reaching the old revision through the other endpoint until
 * they pick up the new one. That also makes rollback to the previous
 * deployment a route write only.
 */

export interface RevisionSpec {
  functionName: string;
  code: S3Location;
  runtime: string;
  roleArn: string;
  env: Record<string, string>;
  timeoutSeconds: number;
  maxConcurrency: number;
  logGroup: string;
  description?: string;
}

function revisionConfig(spec: RevisionSpec) {
  return {
    description: spec.description,
    buildConfig: {
      codeConfig: {
        s3Object: { bucket: spec.code.bucket, key: spec.code.key, versionId: spec.code.versionId },
      },
      runtimeConfig: { runtime: spec.runtime },
    },
    serviceConfig: {
      executionRoleArn: spec.roleArn,
      timeoutSeconds: spec.timeoutSeconds,
      maxConcurrencyPerEnvironment: spec.maxConcurrency,
      environmentVariables: spec.env,
      telemetryConfig: { loggingConfig: { logGroup: spec.logGroup } },
    },
  };
}

/** A just-created execution role isn't assumable yet (IAM eventual consistency). */
const rolePropagating = (e: unknown) =>
  /role|assume/i.test(errorMessage(e)) && errorName(e).includes('Validation');

/**
 * Ensure the function exists. AWS only creates a Web Function together with
 * its first revision and endpoint, so a missing function is created from
 * `initial`; the returned `initialRevisionId` is then the revision to route
 * to (no separate CreateWebFunctionRevision needed).
 */
export async function ensureWebFunction(
  ctx: EngineContext,
  spec: {
    name: string;
    tags?: Record<string, string>;
    initial: { revision: RevisionSpec; endpointName: string };
  },
): Promise<{ arn: string; initialRevisionId?: string }> {
  const lw = ctx.clients.lambdaWeb;
  const existing = await ignoreNotFound(lw.send(new GetWebFunctionCommand({ functionName: spec.name })));
  if (existing?.functionArn) return { arn: existing.functionArn };
  const res = await retry(
    () =>
      lw.send(
        new CreateWebFunctionCommand({
          functionName: spec.name,
          tags: spec.tags,
          revisionConfig: revisionConfig(spec.initial.revision),
          endpointConfig: {
            endpointName: spec.initial.endpointName,
            endpointType: 'HomeRegion',
            authType: 'IamAuth',
            // Traffic moves only when the engine sets weights, so rollback stays explicit.
            autoDeploymentMode: 'Disabled',
          },
        }),
      ),
    { when: rolePropagating, attempts: 15, delayMs: 2_000 },
  );
  ctx.log('info', 'created web function', `web-function ${spec.name}`);
  const revisionId = res.revision?.revisionId;
  if (revisionId) await waitRevisionActive(ctx, spec.name, revisionId);
  return { arn: res.functionArn!, ...(revisionId ? { initialRevisionId: revisionId } : {}) };
}

export async function createRevision(ctx: EngineContext, spec: RevisionSpec): Promise<string> {
  const lw = ctx.clients.lambdaWeb;
  const res = await retry(
    () =>
      lw.send(
        new CreateWebFunctionRevisionCommand({ functionName: spec.functionName, ...revisionConfig(spec) }),
      ),
    { when: rolePropagating, attempts: 15, delayMs: 2_000 },
  );
  await waitRevisionActive(ctx, spec.functionName, res.revisionId!);
  return res.revisionId!;
}

/** A revision's state, or undefined if it (or its function) no longer exists. */
export async function getRevisionState(
  ctx: EngineContext,
  functionName: string,
  revisionId: string,
): Promise<string | undefined> {
  const r = await ignoreNotFound(
    ctx.clients.lambdaWeb.send(new GetWebFunctionRevisionCommand({ functionName, revisionId })),
  );
  return r?.state;
}

async function waitRevisionActive(
  ctx: EngineContext,
  functionName: string,
  revisionId: string,
): Promise<void> {
  const lw = ctx.clients.lambdaWeb;
  const final = await waitFor(
    `web function revision ${revisionId}`,
    async () => {
      const r = await lw.send(new GetWebFunctionRevisionCommand({ functionName, revisionId }));
      return r.state === 'Pending' ? false : r;
    },
    { timeoutMs: 300_000 },
  );
  if (final.state !== 'Active') {
    const details = (final.errors ?? []).map((e) => `${e.attribute}: ${e.errorMessage}`).join('; ');
    throw new Error(
      `web function revision ${revisionId} ${final.state}: ${final.stateReason ?? ''} ${details}`.trim(),
    );
  }
  ctx.log('info', `revision ${revisionId} active`, `web-function ${functionName}`);
}

export interface EndpointState {
  arn: string;
  domainName: string;
  revisionIds: string[];
}

/** Ensure the endpoint exists and routes 100% to `revisionId`. */
export async function ensureEndpoint(
  ctx: EngineContext,
  spec: { functionName: string; endpointName: string; revisionId: string },
): Promise<EndpointState> {
  const lw = ctx.clients.lambdaWeb;
  const weights = [{ revisionId: spec.revisionId, weight: 100 }];
  // Endpoints only accept updates while Active (a new one starts Pending).
  const existing = await waitEndpointSettled(ctx, spec.functionName, spec.endpointName);
  const routed =
    existing?.revisionWeights?.length === 1 &&
    existing.revisionWeights[0]?.revisionId === spec.revisionId &&
    existing.revisionWeights[0]?.weight === 100;
  if (!existing) {
    await lw.send(
      new CreateWebFunctionEndpointCommand({
        functionName: spec.functionName,
        endpointName: spec.endpointName,
        endpointType: 'HomeRegion',
        authType: 'IamAuth',
        autoDeploymentMode: 'Disabled',
        revisionWeights: weights,
      }),
    );
    ctx.log(
      'info',
      'created web function endpoint',
      `web-function ${spec.functionName}/${spec.endpointName}`,
    );
  } else if (!routed) {
    await lw.send(
      new UpdateWebFunctionEndpointCommand({
        functionName: spec.functionName,
        endpointName: spec.endpointName,
        revisionWeights: weights,
      }),
    );
  }
  const ready = await waitFor(
    `endpoint ${spec.functionName}/${spec.endpointName}`,
    async () => {
      const e = await getEndpoint(ctx, spec.functionName, spec.endpointName);
      if (!e) return false;
      if (e.state === 'Failed') throw new Error(`endpoint failed: ${e.stateReason}`);
      if (e.updateStatus === 'Failed') throw new Error(`endpoint update failed: ${e.updateStatusReason}`);
      return e.state === 'Active' && e.updateStatus !== 'InProgress' ? e : false;
    },
    { timeoutMs: 300_000 },
  );
  return {
    arn: ready.endpointArn!,
    domainName: ready.domainName!,
    revisionIds: (ready.revisionWeights ?? []).map((w) => w.revisionId!),
  };
}

/** The endpoint once it is no longer Pending or mid-update (undefined if it doesn't exist). */
async function waitEndpointSettled(ctx: EngineContext, functionName: string, endpointName: string) {
  const first = await getEndpoint(ctx, functionName, endpointName);
  if (!first) return undefined;
  const settled = (e: NonNullable<typeof first>) => e.state !== 'Pending' && e.updateStatus !== 'InProgress';
  if (settled(first)) return first;
  ctx.log('info', 'waiting for the web function endpoint to become active', `web-function ${functionName}`);
  return waitFor(
    `endpoint ${functionName}/${endpointName}`,
    async () => {
      const e = await getEndpoint(ctx, functionName, endpointName);
      if (!e) return false;
      if (e.state === 'Failed') throw new Error(`endpoint failed: ${e.stateReason}`);
      return settled(e) ? e : false;
    },
    { timeoutMs: 600_000 },
  );
}

export async function getEndpoint(ctx: EngineContext, functionName: string, endpointName: string) {
  return ignoreNotFound(
    ctx.clients.lambdaWeb.send(new GetWebFunctionEndpointCommand({ functionName, endpointName })),
  );
}

const pinnedTo = (
  e: { revisionWeights?: Array<{ revisionId?: string; weight?: number }> },
  revisionId: string,
) =>
  e.revisionWeights?.length === 1 &&
  e.revisionWeights[0]?.revisionId === revisionId &&
  e.revisionWeights[0]?.weight === 100;

export interface RevisionEndpoint {
  domainName: string;
  /** Every revision an endpoint routes to afterwards (keep these when pruning). */
  pinned: string[];
}

/**
 * An endpoint that routes 100% to `revisionId`, never changing the one the
 * live route uses (`liveDomain`): edges that haven't picked up a new route
 * keep reaching the revision they had. Reuses an endpoint already pinned to
 * the revision (a function's first revision, or a rollback to the previous
 * deployment), else repoints the other endpoint. Then lets the router invoke
 * every endpoint.
 */
export async function endpointForRevision(
  ctx: EngineContext,
  spec: {
    functionName: string;
    functionArn: string;
    endpointNames: readonly [string, string];
    revisionId: string;
    liveDomain?: string;
    distributionArn?: string;
  },
): Promise<RevisionEndpoint> {
  const { functionName, revisionId } = spec;
  const read = () =>
    Promise.all(
      spec.endpointNames.map(async (name) => ({ name, e: await getEndpoint(ctx, functionName, name) })),
    );
  const before = await read();
  const reuse = before.find((c) => c.e && pinnedTo(c.e, revisionId))?.name;
  const live = before.find((c) => c.e?.domainName && c.e.domainName === spec.liveDomain)?.name;
  const endpointName = reuse ?? spec.endpointNames.find((n) => n !== live)!;
  const endpoint = await ensureEndpoint(ctx, { functionName, endpointName, revisionId });
  if (!reuse) {
    ctx.log('info', `endpoint ${endpointName} → revision ${revisionId}`, `web-function ${functionName}`);
  }

  const after = (await read()).flatMap((c) => (c.e ? [c.e] : []));
  if (spec.distributionArn) {
    await ensureRouterAccess(ctx, {
      functionArn: spec.functionArn,
      endpointArns: after.map((e) => e.endpointArn!),
      distributionArn: spec.distributionArn,
    });
  }
  return {
    domainName: endpoint.domainName,
    pinned: after.flatMap((e) => (e.revisionWeights ?? []).map((w) => w.revisionId!)),
  };
}

/**
 * Allow only the platform's CloudFront distribution to invoke the endpoints
 * (OAC signs origin requests). A function has one resource policy, so this
 * is read-modify-write guarded by the policy revision id.
 */
export async function ensureRouterAccess(
  ctx: EngineContext,
  spec: { functionArn: string; endpointArns: string[]; distributionArn: string },
): Promise<void> {
  const lw = ctx.clients.lambdaWeb;
  const sid = 'AllowPlatformRouter';
  const arns = [...spec.endpointArns].sort();
  const statement = {
    Sid: sid,
    Effect: 'Allow',
    Principal: { Service: 'cloudfront.amazonaws.com' },
    Action: 'lambda:InvokeWebFunctionEndpoint',
    Resource: arns.length === 1 ? arns[0] : arns,
    Condition: { StringEquals: { 'aws:SourceArn': spec.distributionArn } },
  };
  await retry(
    async () => {
      const current = await ignoreNotFound(
        lw.send(new GetResourcePolicyCommand({ resourceArn: spec.functionArn })),
      );
      const doc = current?.policy
        ? (JSON.parse(current.policy) as { Version: string; Statement: Array<{ Sid?: string }> })
        : { Version: '2012-10-17', Statement: [] };
      const others = doc.Statement.filter((s) => s.Sid !== sid);
      const next = { Version: '2012-10-17', Statement: [...others, statement] };
      if (
        current?.policy &&
        JSON.stringify(doc.Statement.find((s) => s.Sid === sid)) === JSON.stringify(statement)
      ) {
        return;
      }
      await lw.send(
        new PutResourcePolicyCommand({
          resourceArn: spec.functionArn,
          policy: JSON.stringify(next),
          revisionId: current?.revisionId,
        }),
      );
    },
    { when: (e) => /PreconditionFailed|Conflict/.test(errorName(e)), attempts: 5 },
  );
}

/** Delete revisions beyond the `keepNewest` most recent, never touching `keep`. */
export async function pruneRevisions(
  ctx: EngineContext,
  functionName: string,
  opts: { keepNewest: number; keep: string[] },
): Promise<void> {
  const lw = ctx.clients.lambdaWeb;
  const all: Array<{ id: string; createdAt: number }> = [];
  let nextToken: string | undefined;
  do {
    const res = await lw.send(new ListWebFunctionRevisionsCommand({ functionName, nextToken }));
    for (const r of res.revisions ?? []) {
      if (r.revisionId) all.push({ id: r.revisionId, createdAt: r.createdAt?.getTime() ?? 0 });
    }
    nextToken = res.nextToken;
  } while (nextToken);
  all.sort((a, b) => b.createdAt - a.createdAt);
  for (const r of all.slice(opts.keepNewest)) {
    if (opts.keep.includes(r.id)) continue;
    try {
      await ignoreNotFound(lw.send(new DeleteWebFunctionRevisionCommand({ functionName, revisionId: r.id })));
    } catch (e) {
      // AWS Emulator v1.0.385 doesn't implement revision deletion; old revisions are harmless there.
      if (isNotImplemented(e)) return;
      throw e;
    }
    ctx.log('info', `deleted old revision ${r.id}`, `web-function ${functionName}`);
  }
}

export async function deleteWebFunction(ctx: EngineContext, name: string): Promise<boolean> {
  const lw = ctx.clients.lambdaWeb;
  const fn = await ignoreNotFound(lw.send(new GetWebFunctionCommand({ functionName: name })));
  if (!fn) return false;
  const endpoints = await ignoreNotFound(
    lw.send(new ListWebFunctionEndpointsCommand({ functionName: name })),
  );
  for (const e of endpoints?.endpoints ?? []) {
    if (e.endpointName) {
      await ignoreNotFound(
        lw.send(new DeleteWebFunctionEndpointCommand({ functionName: name, endpointName: e.endpointName })),
      );
    }
  }
  if (fn.functionArn)
    await ignoreNotFound(lw.send(new DeleteResourcePolicyCommand({ resourceArn: fn.functionArn })));
  const revisions = await ignoreNotFound(
    lw.send(new ListWebFunctionRevisionsCommand({ functionName: name })),
  );
  for (const r of revisions?.revisions ?? []) {
    if (r.revisionId) {
      await ignoreNotFound(
        lw.send(new DeleteWebFunctionRevisionCommand({ functionName: name, revisionId: r.revisionId })),
      );
    }
  }
  await retry(() => ignoreNotFound(lw.send(new DeleteWebFunctionCommand({ functionName: name }))), {
    when: (e) => errorName(e).includes('Conflict'),
    attempts: 10,
  });
  ctx.log('info', 'deleted web function', `web-function ${name}`);
  return true;
}
