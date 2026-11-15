import { type PlatformRuntimeConfig, platformNames } from '@ericminassian/platform-core';
import { ensureUserPool } from './drivers/cognito.ts';
import { ensureTable } from './drivers/dynamodb.ts';
import { ensureBucket } from './drivers/s3.ts';
import { type EngineContext, platformTags } from './util.ts';

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
  };
}
