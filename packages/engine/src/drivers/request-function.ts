import {
  AddPermissionCommand,
  CreateAliasCommand,
  CreateFunctionCommand,
  CreateFunctionUrlConfigCommand,
  GetAliasCommand,
  GetFunctionConfigurationCommand,
  GetFunctionUrlConfigCommand,
  GetPolicyCommand,
  DeleteFunctionCommand,
  ListVersionsByFunctionCommand,
  PublishVersionCommand,
  type Runtime,
  TagResourceCommand,
  UpdateAliasCommand,
  UpdateFunctionCodeCommand,
  UpdateFunctionConfigurationCommand,
  UpdateFunctionUrlConfigCommand,
} from '@aws-sdk/client-lambda';
import { NODE_RUNTIME } from '@ericminassian/platform-core';
import type { S3Location } from '../index.ts';
import { type EngineContext, errorMessage, errorName, ignoreNotFound, retry, waitFor } from '../util.ts';
import { waitReady } from './lambda.ts';

/**
 * A stage's server in request mode: a regular Lambda function (arm64) that
 * Lambda invokes once per request, through function URLs.
 *
 * It mirrors the Web Function's two endpoints: each deploy publishes a
 * version, and of the function's two aliases (each with its own function
 * URL) points the one the live route doesn't use at it. The route names that
 * URL, so the route flip switches static files and server together at each
 * edge, and rollback to the previous deployment is a route write.
 *
 * The URLs take requests from anyone (AuthType NONE): CloudFront's OAC to a
 * function URL would make every client hash POST bodies. The router sends
 * the stage's origin secret instead, and the SDK refuses requests without it.
 */

export interface RequestFunctionSpec {
  name: string;
  roleArn: string;
  code: S3Location;
  env: Record<string, string>;
  memoryMb: number;
  timeoutSeconds: number;
  logGroup: string;
  /** The deployment this version is, recorded on it. */
  deploymentId: string;
  description: string;
  tags?: Record<string, string>;
}

const isRolePropagation = (e: unknown) =>
  errorName(e) === 'InvalidParameterValueException' && /role|assume/i.test(errorMessage(e));
const isUpdateInProgress = (e: unknown) => errorName(e) === 'ResourceConflictException';

/** Create or update the function from `spec`, then publish it as a version. */
export async function publishRequestFunction(
  ctx: EngineContext,
  spec: RequestFunctionSpec,
): Promise<{ arn: string; version: string }> {
  const lambda = ctx.clients.lambda;
  const existing = await ignoreNotFound(
    lambda.send(new GetFunctionConfigurationCommand({ FunctionName: spec.name })),
  );
  const config = {
    Role: spec.roleArn,
    Runtime: NODE_RUNTIME as Runtime,
    Handler: 'index.handler',
    MemorySize: spec.memoryMb,
    Timeout: spec.timeoutSeconds,
    Description: spec.description,
    Environment: { Variables: spec.env },
    // JSON keeps the SDK's lines parseable like the worker's. WARN drops the runtime's own start
    // and report records of every invocation: the SDK's `req` lines carry the same facts.
    LoggingConfig: { LogFormat: 'JSON' as const, SystemLogLevel: 'WARN' as const, LogGroup: spec.logGroup },
  };
  const code = { S3Bucket: spec.code.bucket, S3Key: spec.code.key, S3ObjectVersion: spec.code.versionId };

  let arn: string;
  if (!existing) {
    const res = await retry(
      () =>
        lambda.send(
          new CreateFunctionCommand({
            FunctionName: spec.name,
            ...config,
            Architectures: ['arm64'],
            Code: code,
            Tags: spec.tags,
          }),
        ),
      { when: isRolePropagation, attempts: 15, delayMs: 2_000 },
    );
    arn = res.FunctionArn!;
    ctx.log('info', 'created function', `function ${spec.name}`);
  } else {
    arn = existing.FunctionArn!;
    await waitReady(ctx, spec.name);
    await retry(
      () =>
        lambda.send(
          new UpdateFunctionCodeCommand({ FunctionName: spec.name, ...code, Architectures: ['arm64'] }),
        ),
      { when: isUpdateInProgress },
    );
    await waitReady(ctx, spec.name);
    await retry(
      () => lambda.send(new UpdateFunctionConfigurationCommand({ FunctionName: spec.name, ...config })),
      {
        when: (e) => isUpdateInProgress(e) || isRolePropagation(e),
      },
    );
    if (spec.tags) await lambda.send(new TagResourceCommand({ Resource: arn, Tags: spec.tags }));
  }
  await waitReady(ctx, spec.name);
  const published = await retry(
    () => lambda.send(new PublishVersionCommand({ FunctionName: spec.name, Description: spec.deploymentId })),
    { when: isUpdateInProgress },
  );
  const version = published.Version!;
  await waitFor(
    `function ${spec.name} version ${version}`,
    async () => (await getVersionState(ctx, spec.name, version)) === 'Active',
    { timeoutMs: 300_000 },
  );
  ctx.log('info', `published version ${version}`, `function ${spec.name}`);
  return { arn, version };
}

/** A version's state, or undefined when it (or the function) no longer exists. */
export async function getVersionState(
  ctx: EngineContext,
  functionName: string,
  version: string,
): Promise<string | undefined> {
  const c = await ignoreNotFound(
    ctx.clients.lambda.send(
      new GetFunctionConfigurationCommand({ FunctionName: functionName, Qualifier: version }),
    ),
  );
  if (c?.State === 'Failed')
    throw new Error(`function ${functionName} version ${version} failed: ${c.StateReason}`);
  return c?.State;
}

/** `abc.lambda-url.us-east-1.on.aws`: what the route's `o` holds (the emulator serves URLs under a path). */
export const functionUrlDomain = (url: string) => url.replace(/^https?:\/\//, '').replace(/\/+$/, '');

export interface AliasUrl {
  domainName: string;
  /** Every version an alias points at afterwards (keep these when pruning). */
  pinned: string[];
}

/**
 * A function URL that serves `version`, never changing the alias the live
 * route uses (`liveDomain`): edges that haven't picked up a new route keep
 * reaching the version they had. Reuses an alias already on the version (a
 * rollback to the previous deployment), else repoints the other one.
 */
export async function aliasForVersion(
  ctx: EngineContext,
  spec: {
    functionName: string;
    aliasNames: readonly [string, string];
    version: string;
    liveDomain?: string;
  },
): Promise<AliasUrl> {
  const { functionName, version } = spec;
  const before = await Promise.all(
    spec.aliasNames.map(async (name) => ({
      name,
      version: (await getAlias(ctx, functionName, name))?.FunctionVersion,
      url: (await getFunctionUrl(ctx, functionName, name))?.FunctionUrl,
    })),
  );
  const reuse = before.find((a) => a.version === version)?.name;
  const live = before.find((a) => a.url && functionUrlDomain(a.url) === spec.liveDomain)?.name;
  const aliasName = reuse ?? spec.aliasNames.find((n) => n !== live)!;
  const current = before.find((a) => a.name === aliasName);
  if (!current?.version) {
    await ctx.clients.lambda.send(
      new CreateAliasCommand({ FunctionName: functionName, Name: aliasName, FunctionVersion: version }),
    );
  } else if (current.version !== version) {
    await ctx.clients.lambda.send(
      new UpdateAliasCommand({ FunctionName: functionName, Name: aliasName, FunctionVersion: version }),
    );
  }
  if (!reuse) ctx.log('info', `alias ${aliasName} → version ${version}`, `function ${functionName}`);
  const url = await ensureFunctionUrl(ctx, functionName, aliasName);
  await ensurePublicInvoke(ctx, functionName, aliasName);
  return {
    domainName: functionUrlDomain(url),
    pinned: before.flatMap((a) => (a.name === aliasName ? [version] : a.version ? [a.version] : [])),
  };
}

async function getAlias(ctx: EngineContext, functionName: string, name: string) {
  return ignoreNotFound(
    ctx.clients.lambda.send(new GetAliasCommand({ FunctionName: functionName, Name: name })),
  );
}

async function getFunctionUrl(ctx: EngineContext, functionName: string, alias: string) {
  return ignoreNotFound(
    ctx.clients.lambda.send(
      new GetFunctionUrlConfigCommand({ FunctionName: functionName, Qualifier: alias }),
    ),
  );
}

/** The alias's URL: no IAM auth, responses streamed (a body larger than 6 MB, server-sent events). */
async function ensureFunctionUrl(ctx: EngineContext, functionName: string, alias: string): Promise<string> {
  const lambda = ctx.clients.lambda;
  const wanted = { AuthType: 'NONE' as const, InvokeMode: 'RESPONSE_STREAM' as const };
  const existing = await getFunctionUrl(ctx, functionName, alias);
  if (!existing) {
    const created = await lambda.send(
      new CreateFunctionUrlConfigCommand({ FunctionName: functionName, Qualifier: alias, ...wanted }),
    );
    ctx.log('info', `created function URL for ${alias}`, `function ${functionName}`);
    return created.FunctionUrl!;
  }
  if (existing.AuthType !== wanted.AuthType || existing.InvokeMode !== wanted.InvokeMode) {
    await lambda.send(
      new UpdateFunctionUrlConfigCommand({ FunctionName: functionName, Qualifier: alias, ...wanted }),
    );
  }
  return existing.FunctionUrl!;
}

/**
 * Function URLs without IAM auth need two grants on the alias (since October
 * 2025): invoking the URL, and invoking the function, the latter only
 * through a URL.
 */
const PUBLIC_INVOKE = [
  {
    StatementId: 'FunctionUrlPublic',
    Action: 'lambda:InvokeFunctionUrl',
    FunctionUrlAuthType: 'NONE' as const,
  },
  { StatementId: 'FunctionUrlInvoke', Action: 'lambda:InvokeFunction', InvokedViaFunctionUrl: true },
];

async function ensurePublicInvoke(ctx: EngineContext, functionName: string, alias: string): Promise<void> {
  const lambda = ctx.clients.lambda;
  const current = await ignoreNotFound(
    lambda.send(new GetPolicyCommand({ FunctionName: functionName, Qualifier: alias })),
  );
  const sids = new Set(
    current?.Policy
      ? (JSON.parse(current.Policy) as { Statement: Array<{ Sid?: string }> }).Statement.map((s) => s.Sid)
      : [],
  );
  for (const grant of PUBLIC_INVOKE) {
    if (sids.has(grant.StatementId)) continue;
    try {
      await lambda.send(
        new AddPermissionCommand({ FunctionName: functionName, Qualifier: alias, Principal: '*', ...grant }),
      );
    } catch (e) {
      // Already there (GetPolicy can lag an earlier add).
      if (errorName(e) !== 'ResourceConflictException') throw e;
    }
  }
}

/** Delete published versions beyond the `keepNewest` most recent, never touching `keep`. */
export async function pruneVersions(
  ctx: EngineContext,
  functionName: string,
  opts: { keepNewest: number; keep: string[] },
): Promise<void> {
  const lambda = ctx.clients.lambda;
  const versions: number[] = [];
  let Marker: string | undefined;
  do {
    const res = await lambda.send(new ListVersionsByFunctionCommand({ FunctionName: functionName, Marker }));
    for (const v of res.Versions ?? [])
      if (v.Version && v.Version !== '$LATEST') versions.push(Number(v.Version));
    Marker = res.NextMarker;
  } while (Marker);
  for (const v of versions.toSorted((a, b) => b - a).slice(opts.keepNewest)) {
    if (opts.keep.includes(String(v))) continue;
    await ignoreNotFound(
      lambda.send(new DeleteFunctionCommand({ FunctionName: functionName, Qualifier: String(v) })),
    );
    ctx.log('info', `deleted old version ${v}`, `function ${functionName}`);
  }
}
