import { CreateApiCommand } from '@aws-sdk/client-appsync';
import { CreateFunctionCommand, GetFunctionConfigurationCommand } from '@aws-sdk/client-lambda';
import {
  emailDomain,
  type ContainersRuntimeConfig,
  NODE_RUNTIME,
  type PlatformRuntimeConfig,
  platformNames,
  type RealtimeRuntimeConfig,
} from '@ericminassian/platform-core';
import { Hash } from '@smithy/hash-node';
import { SignatureV4 } from '@smithy/signature-v4';
import { strToU8, zipSync } from 'fflate';
import { findEventApi } from './drivers/appsync.ts';
import { ensureUserPool } from './drivers/cognito.ts';
import { ensureTable } from './drivers/dynamodb.ts';
import { ensureRepository } from './drivers/ecr.ts';
import { ensureCluster } from './drivers/ecs.ts';
import { ensureRole } from './drivers/iam.ts';
import { ensureBucket } from './drivers/s3.ts';
import { ensureEmailIdentity } from './drivers/ses.ts';
import { containerExecutionPolicy, containerSchedulerPolicy, serviceTrustPolicy } from './policy.ts';
import { type EngineContext, ignoreNotFound, platformTags, sendRaw, waitFor } from './util.ts';

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
  const domain = opts.domain ?? 'localhost';

  await ensureBucket(ctx, { name: artifactsBucket, versioned: true, tags });
  await ensureBucket(ctx, { name: sitesBucket, tags });
  await ensureBucket(ctx, {
    name: storageBucket,
    tags,
    cors: [
      {
        AllowedOrigins: [`http://*.${domain}:${opts.port}`, `http://localhost:${opts.port}`],
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
  // Stages get real tenants and configuration sets in the emulator, so the domain they're
  // associated with must exist. It never verifies and nothing is sent: local stages hand
  // their mail to the CLI (`email.mode: 'local'`).
  const mail = await ensureEmailIdentity(ctx, { domain: emailDomain(domain), tags });
  const containers = await ensureLocalContainers(ctx, tags);

  return {
    v: 1,
    target: 'emulator',
    accountId,
    region,
    domain,
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
    email: { domain: mail.domain, identityArn: mail.arn },
    containers,
  };
}

/**
 * Container compute inside the emulator, like the foundation's: a Fargate
 * cluster, the image repository, public subnets with a security group, and
 * the execution and scheduler roles. The emulator's ECS runs tasks
 * (simulated: it pulls nothing and runs no code) only when their subnet
 * routes to an internet gateway, which its default VPC lacks; this adds one.
 */
async function ensureLocalContainers(
  ctx: EngineContext,
  tags: Record<string, string>,
): Promise<ContainersRuntimeConfig> {
  const accountId = await ctx.accountId();
  const cluster = platformNames.containerCluster;
  await ensureCluster(ctx, { name: cluster, tags });
  const repository = await ensureRepository(ctx, { name: platformNames.containerRepository, tags });
  const execution = await ensureRole(ctx, {
    name: platformNames.containerExecutionRole,
    trust: serviceTrustPolicy('ecs-tasks.amazonaws.com'),
    description: 'plat dev: pulls platform container images and writes their logs',
    inlinePolicies: {
      execution: containerExecutionPolicy({ region: ctx.region, accountId, repository: repository.name }),
    },
    tags,
  });
  const scheduler = await ensureRole(ctx, {
    name: platformNames.containerSchedulerRole,
    trust: serviceTrustPolicy('scheduler.amazonaws.com'),
    description: "plat dev: scales stages' containers (preview stop schedules)",
    inlinePolicies: { scale: containerSchedulerPolicy({ region: ctx.region, accountId, cluster }) },
    tags,
  });
  const network = await ensureLocalNetwork(ctx);
  return {
    cluster,
    subnets: network.subnets,
    securityGroups: [network.securityGroup],
    repository: repository.name,
    // The emulator's CreateRepository answers with its own host and port, but its ECS only
    // resolves images named the way AWS names them.
    repositoryUri: `${repository.registryId}.dkr.ecr.${ctx.region}.amazonaws.com/${repository.name}`,
    executionRoleArn: execution.arn,
    schedulerRoleArn: scheduler.arn,
  };
}

/**
 * The default VPC's subnets, made public (an internet gateway and a default
 * route, which AWS's default VPCs come with), and the containers' security
 * group in it.
 */
async function ensureLocalNetwork(ctx: EngineContext): Promise<{ subnets: string[]; securityGroup: string }> {
  const vpcs = await ec2(ctx, 'DescribeVpcs', { 'Filter.1.Name': 'is-default', 'Filter.1.Value.1': 'true' });
  const vpcId = xmlValues(vpcs, 'vpcId')[0];
  if (!vpcId) throw new Error('the AWS Emulator has no default VPC');
  const inVpc = { 'Filter.1.Name': 'vpc-id', 'Filter.1.Value.1': vpcId };
  const subnets = [...new Set(xmlValues(await ec2(ctx, 'DescribeSubnets', inVpc), 'subnetId'))].toSorted();
  if (!subnets.length) throw new Error(`the AWS Emulator's default VPC ${vpcId} has no subnets`);

  const gateways = await ec2(ctx, 'DescribeInternetGateways', {
    'Filter.1.Name': 'attachment.vpc-id',
    'Filter.1.Value.1': vpcId,
  });
  let gateway = xmlValues(gateways, 'internetGatewayId')[0];
  if (!gateway) {
    gateway = xmlValues(await ec2(ctx, 'CreateInternetGateway', {}), 'internetGatewayId')[0]!;
    await ec2(ctx, 'AttachInternetGateway', { InternetGatewayId: gateway, VpcId: vpcId });
  }
  const tables = await ec2(ctx, 'DescribeRouteTables', {
    ...inVpc,
    'Filter.2.Name': 'association.main',
    'Filter.2.Value.1': 'true',
  });
  const table = xmlValues(tables, 'routeTableId')[0];
  if (table && !xmlValues(tables, 'destinationCidrBlock').includes('0.0.0.0/0')) {
    await ec2(ctx, 'CreateRoute', {
      RouteTableId: table,
      DestinationCidrBlock: '0.0.0.0/0',
      GatewayId: gateway,
    });
  }

  const groups = await ec2(ctx, 'DescribeSecurityGroups', {
    ...inVpc,
    'Filter.2.Name': 'group-name',
    'Filter.2.Value.1': platformNames.containerNetwork,
  });
  const securityGroup =
    xmlValues(groups, 'groupId')[0] ??
    xmlValues(
      await ec2(ctx, 'CreateSecurityGroup', {
        GroupName: platformNames.containerNetwork,
        GroupDescription: 'Platform containers: no inbound traffic, all outbound',
        VpcId: vpcId,
      }),
      'groupId',
    )[0]!;
  return { subnets, securityGroup };
}

/**
 * One EC2 Query API call against the emulator, signed with the SDK's SigV4
 * signer and sent through an SDK client's endpoint, credentials and HTTP
 * handler. These few VPC calls are the engine's only EC2 calls, which
 * doesn't warrant the SDK's EC2 client, one of its largest.
 */
async function ec2(ctx: EngineContext, action: string, params: Record<string, string>): Promise<string> {
  const client = ctx.clients.sts;
  const endpoint = await client.config.endpoint!();
  const body = new URLSearchParams({ Action: action, Version: '2016-11-15', ...params }).toString();
  const signer = new SignatureV4({
    service: 'ec2',
    region: ctx.region,
    credentials: client.config.credentials,
    sha256: Hash.bind(null, 'sha256'),
  });
  const request = await signer.sign({
    method: 'POST',
    protocol: endpoint.protocol,
    hostname: endpoint.hostname,
    ...(endpoint.port ? { port: endpoint.port } : {}),
    path: '/',
    query: {},
    headers: {
      'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
      host: endpoint.port ? `${endpoint.hostname}:${endpoint.port}` : endpoint.hostname,
      'content-length': String(Buffer.byteLength(body)),
    },
    body,
  });
  const res = await sendRaw(client, request as Parameters<typeof sendRaw>[1]);
  const xml = new TextDecoder().decode(res.body);
  if (res.statusCode !== 200) {
    const [code] = xmlValues(xml, 'Code');
    const [message] = xmlValues(xml, 'Message');
    throw new Error(`EC2 ${action} failed in the AWS Emulator: ${code ?? res.statusCode} ${message ?? xml}`);
  }
  return xml;
}

function xmlValues(xml: string, element: string): string[] {
  return [...xml.matchAll(new RegExp(`<${element}>([^<]*)</${element}>`, 'g'))].map((m) => m[1]!);
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
