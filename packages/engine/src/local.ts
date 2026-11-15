import { CreateApiCommand } from '@aws-sdk/client-appsync';
import { CreateFunctionCommand, GetFunctionConfigurationCommand } from '@aws-sdk/client-lambda';
import {
  NODE_RUNTIME,
  type PlatformRuntimeConfig,
  platformNames,
  type RealtimeRuntimeConfig,
} from '@ericminassian/platform-core';
import { strToU8, zipSync } from 'fflate';
import { findEventApi } from './drivers/appsync.ts';
import { ensureUserPool } from './drivers/cognito.ts';
import { ensureTable } from './drivers/dynamodb.ts';
import { ensureRole } from './drivers/iam.ts';
import { ensureBucket } from './drivers/s3.ts';
import { serviceTrustPolicy } from './policy.ts';
import { type EngineContext, ignoreNotFound, platformTags, waitFor } from './util.ts';

/**
 * Inside a fresh AWS Emulator, create the shared resources a stage deploy
 * expects (the ones the foundation stack holds in AWS, minus CloudFront, DNS,
 * certificates and IAM) and describe them as a runtime config.
 */
export async function ensureLocal(
  ctx: EngineContext,
  opts: { domain?: string; port: number; jwksBaseUrl: string },
): Promise<PlatformRuntimeConfig> {
  if (ctx.target !== 'emulator') throw new Error('ensureLocalPlatform only runs against the AWS Emulator');
  const accountId = await ctx.accountId();
  const region = ctx.region;
  const tags = platformTags('local');
  const artifactsBucket = platformNames.artifactsBucket(accountId, region);
  const sitesBucket = platformNames.sitesBucket(accountId, region);
  const storageBucket = platformNames.storageBucket(accountId, region);

  await ensureBucket(ctx, { name: artifactsBucket, versioned: true, tags });
  await ensureBucket(ctx, { name: sitesBucket, tags });
  await ensureBucket(ctx, {
    name: storageBucket,
    tags,
    cors: [
      {
        AllowedOrigins: [
          `http://*.${opts.domain ?? 'localhost'}:${opts.port}`,
          `http://localhost:${opts.port}`,
        ],
        AllowedMethods: ['GET', 'PUT', 'POST', 'HEAD'],
        AllowedHeaders: ['*'],
        ExposeHeaders: ['ETag'],
        MaxAgeSeconds: 3600,
      },
    ],
  });
  await ensureTable(ctx, {
    name: platformNames.stateTable,
    pk: 'pk',
    sk: 'sk',
    gsis: [['gsi1', 'gsi1pk', 'gsi1sk']],
    tags,
  });
  await ensureTable(ctx, {
    name: platformNames.telemetryTable,
    pk: 'pk',
    sk: 'sk',
    ttlAttribute: 'ttl',
    tags,
  });
  const userPoolId = await ensureUserPool(ctx, { name: platformNames.userPool, tags });
  const realtime = await ensureLocalRealtime(ctx, tags);

  return {
    v: 1,
    target: 'emulator',
    accountId,
    region,
    domain: opts.domain ?? 'localhost',
    publicScheme: 'http',
    publicPort: opts.port,
    artifactsBucket,
    sitesBucket,
    storageBucket,
    stateTable: platformNames.stateTable,
    telemetryTable: platformNames.telemetryTable,
    userPoolId,
    loginUrl: `http://localhost:${opts.port}`,
    jwksBaseUrl: opts.jwksBaseUrl,
    realtime,
  };
}

/**
 * The emulator never invokes an Event API's Lambda authorizer (it accepts any
 * token), but the API still needs one to accept the AWS_LAMBDA mode signed-in
 * namespaces use. So this one only satisfies the API's configuration.
 */
const STUB_AUTHORIZER = `// plat dev: the AWS Emulator doesn't invoke Event API authorizers, so subscribe tokens
// aren't checked locally. The platform's real authorizer runs in AWS.
export const handler = async () => ({ isAuthorized: true });
`;

/**
 * The platform's Event API inside the emulator, configured like the
 * foundation's (same auth providers and defaults). The emulator serves its
 * HTTP and realtime endpoints on local ports (`dns` is `127.0.0.1:<port>`).
 */
async function ensureLocalRealtime(
  ctx: EngineContext,
  tags: Record<string, string>,
): Promise<RealtimeRuntimeConfig> {
  let api = await findEventApi(ctx, platformNames.realtimeApi);
  if (!api) {
    const authorizerArn = await ensureStubAuthorizer(ctx, tags);
    const res = await ctx.clients.appsync.send(
      new CreateApiCommand({
        name: platformNames.realtimeApi,
        tags,
        eventConfig: {
          authProviders: [
            { authType: 'API_KEY' },
            { authType: 'AWS_IAM' },
            { authType: 'AWS_LAMBDA', lambdaAuthorizerConfig: { authorizerUri: authorizerArn } },
          ],
          connectionAuthModes: [{ authType: 'API_KEY' }, { authType: 'AWS_LAMBDA' }],
          defaultPublishAuthModes: [{ authType: 'AWS_IAM' }],
          defaultSubscribeAuthModes: [{ authType: 'AWS_LAMBDA' }],
        },
      }),
    );
    api = res.api;
  }
  const httpDomain = api?.dns?.HTTP;
  const realtimeDomain = api?.dns?.REALTIME;
  if (!api?.apiId || !httpDomain || !realtimeDomain)
    throw new Error('the AWS Emulator returned an Event API without endpoints');
  return { apiId: api.apiId, httpDomain, realtimeDomain };
}

async function ensureStubAuthorizer(ctx: EngineContext, tags: Record<string, string>): Promise<string> {
  const name = platformNames.realtimeAuthorizer;
  const existing = await ignoreNotFound(
    ctx.clients.lambda.send(new GetFunctionConfigurationCommand({ FunctionName: name })),
  );
  if (existing?.FunctionArn) return existing.FunctionArn;
  const role = await ensureRole(ctx, {
    name,
    trust: serviceTrustPolicy('lambda.amazonaws.com'),
    description: 'plat dev stub realtime authorizer',
    tags,
  });
  const res = await ctx.clients.lambda.send(
    new CreateFunctionCommand({
      FunctionName: name,
      Role: role.arn,
      Runtime: NODE_RUNTIME,
      Handler: 'index.handler',
      Code: { ZipFile: zipSync({ 'index.mjs': strToU8(STUB_AUTHORIZER) }) },
      Tags: tags,
    }),
  );
  await waitFor(`${name} to become active`, async () => {
    const c = await ctx.clients.lambda.send(new GetFunctionConfigurationCommand({ FunctionName: name }));
    return c.State === 'Active';
  });
  return res.FunctionArn!;
}
