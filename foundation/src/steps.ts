import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import {
  appItem,
  deploymentItem,
  type StageItem,
  stageItem,
  stageKey,
} from '@ericminassian/platform-control-plane/records';
import {
  type ArtifactFile,
  names,
  newDeploymentId,
  type PlatformRuntimeConfig,
  PROD_STAGE,
  platformNames,
  type ResolvedManifest,
  TELEMETRY_FILTER_PATTERN,
} from '@ericminassian/platform-core';
import { buildRouterFunctionCode } from '@ericminassian/platform-core/cloudfront-function';
import {
  ALL_VIEWER_EXCEPT_HOST_HEADER,
  cloudFrontAlias,
  cnameRecord,
  delegateZone,
  ensureAccountSubscriptionFilter,
  ensureBucket,
  ensureCachePolicy,
  ensureCertificate,
  ensureDistribution,
  ensureEmailSubscription,
  ensureGithubOidcProvider,
  ensureHostedZone,
  ensureKeyValueStore,
  ensureManagedPolicy,
  ensureOriginAccessControl,
  ensureParameterOnce,
  ensurePermission,
  ensureRole,
  ensureRouterFunction,
  ensureTable,
  ensureTopic,
  ensureUserPool,
  ensureUserPoolDomain,
  platformTags,
  policies,
  putParameter,
  routerCachePolicy,
  upsertRecords,
  waitCertificateIssued,
} from '@ericminassian/platform-engine';
import { BlockedError, type FoundationContext, type Step } from './context.ts';

const DISTRIBUTION_COMMENT = 'platform-edge';
const SITES_ORIGIN_ID = 'sites';
const ADMINISTRATOR_ACCESS = 'arn:aws:iam::aws:policy/AdministratorAccess';
const CONTROL_PLANE_APP = 'platform';
const CONTROL_PLANE_DIR = 'services/control-plane';

function need<T>(value: T | undefined, what: string): T {
  if (value === undefined)
    throw new Error(`foundation: ${what} is not available (an earlier step was skipped or failed)`);
  return value;
}

const buckets = (f: FoundationContext) => {
  const acct = need(f.state.accountId, 'account id');
  return {
    artifacts: platformNames.artifactsBucket(acct, f.config.region),
    sites: platformNames.sitesBucket(acct, f.config.region),
    storage: platformNames.storageBucket(acct, f.config.region),
  };
};

export const STEPS: Step[] = [
  {
    id: 'preflight',
    describe: (c) =>
      `check credentials (STS), region ${c.region}, DNS_DELEGATION_ROLE_ARN (ALERT_EMAIL optional)`,
    async run(f) {
      f.state.accountId = await f.ctx.accountId();
      if (f.engine.region !== f.config.region)
        throw new Error(`engine region ${f.engine.region} ≠ ${f.config.region}`);
      if (!f.emulator) {
        if (!f.env.dnsDelegationRoleArn)
          throw new Error('missing environment: DNS_DELEGATION_ROLE_ARN (see docs/SETUP.md)');
        if (!f.env.alertEmail)
          f.log('ALERT_EMAIL is not set: the alerts topic is created without an email subscription');
      }
      f.log(`account ${f.state.accountId}, region ${f.config.region}${f.emulator ? ' (AWS Emulator)' : ''}`);
    },
  },
  {
    id: 'dns-zone',
    awsOnly: true,
    describe: (c) =>
      `hosted zone ${c.zone}, NS delegated from ${c.domain} via the aws repo's delegation role`,
    async run(f) {
      const zone = await ensureHostedZone(f.ctx, f.config.zone);
      f.state.zoneId = zone.id;
      await delegateZone(f.ctx, {
        roleArn: need(f.env.dnsDelegationRoleArn, 'DNS_DELEGATION_ROLE_ARN'),
        parentZoneName: f.config.domain,
        zoneName: f.config.zone,
        nameServers: zone.nameServers,
      });
    },
  },
  {
    id: 'certificates',
    awsOnly: true,
    describe: (c) =>
      `ACM (us-east-1): *.${c.domain} (validated by a CNAME in the aws repo) and ${c.zone} + *.${c.zone} (validated here)`,
    async run(f) {
      const zoneId = need(f.state.zoneId, 'platform zone');
      const tags = platformTags('edge');
      const zoneCert = await ensureCertificate(f.ctx, {
        domainName: f.config.zone,
        alternativeNames: [`*.${f.config.zone}`],
        tags,
      });
      if (zoneCert.status !== 'ISSUED') {
        const unique = new Map(zoneCert.validation.map((v) => [v.name, v.value]));
        await upsertRecords(
          f.ctx,
          zoneId,
          [...unique].map(([name, value]) => cnameRecord(name, value)),
        );
        f.log(`waiting for ${f.config.zone} certificate validation (a few minutes)…`);
        await waitCertificateIssued(f.ctx, zoneCert.arn);
      }
      f.state.zoneCertArn = zoneCert.arn;

      const wildcard = await ensureCertificate(f.ctx, { domainName: `*.${f.config.domain}`, tags });
      f.state.wildcardCertArn = wildcard.arn;
      if (wildcard.status !== 'ISSUED') {
        const rec = wildcard.validation[0];
        if (!rec)
          throw new Error(`certificate ${wildcard.arn} has no validation record yet; re-run in a minute`);
        const suffix = `.${f.config.domain}.`;
        const relative = rec.name.endsWith(suffix) ? rec.name.slice(0, -suffix.length) : rec.name;
        throw new BlockedError(
          [
            `The *.${f.config.domain} certificate is waiting for DNS validation in the root zone, which the`,
            `platform account can't write. Add this record to DNS_ZONES in github.com/eric-minassian/aws`,
            '(cdk/config.ts, the ericminassian.com zone), deploy it, then re-run this script:',
            '',
            '  {',
            '    id: "PlatformCertificateValidation",',
            '    type: "CNAME",',
            `    name: "${relative}",`,
            `    value: "${rec.value}",`,
            '  },',
            '',
            `Certificate: ${wildcard.arn}`,
          ].join('\n'),
        );
      }
    },
  },
  {
    id: 'buckets',
    describe: () =>
      'S3: artifacts (versioned), sites (edge origin), storage (app files); public access blocked',
    async run(f) {
      const b = buckets(f);
      const acct = need(f.state.accountId, 'account id');
      await ensureBucket(f.ctx, {
        name: b.artifacts,
        versioned: true,
        tags: platformTags('artifacts'),
        // Lambda Web Functions fetch revision code with the Lambda service
        // principal (not the caller's credentials), so it needs read access to
        // build artifacts. Scoped to this account's functions.
        policy: {
          Version: '2012-10-17',
          Statement: [
            {
              Sid: 'LambdaWebFunctionCode',
              Effect: 'Allow',
              Principal: { Service: 'lambda.amazonaws.com' },
              Action: ['s3:GetObject', 's3:GetObjectVersion'],
              Resource: `arn:aws:s3:::${b.artifacts}/*`,
              Condition: { StringEquals: { 'aws:SourceAccount': acct } },
            },
          ],
        },
        lifecycle: [
          {
            ID: 'expire-old-artifacts',
            Status: 'Enabled',
            Filter: { Prefix: '' },
            Expiration: { Days: 90 },
            NoncurrentVersionExpiration: { NoncurrentDays: 30 },
            AbortIncompleteMultipartUpload: { DaysAfterInitiation: 2 },
          },
        ],
      });
      await ensureBucket(f.ctx, { name: b.sites, tags: platformTags('sites') });
      await ensureBucket(f.ctx, {
        name: b.storage,
        tags: platformTags('storage'),
        cors: [
          {
            AllowedOrigins: [`https://*.${f.config.domain}`],
            AllowedMethods: ['GET', 'PUT', 'POST', 'HEAD'],
            AllowedHeaders: ['*'],
            ExposeHeaders: ['ETag'],
            MaxAgeSeconds: 3600,
          },
        ],
        lifecycle: [
          {
            ID: 'abort-multipart',
            Status: 'Enabled',
            Filter: { Prefix: '' },
            AbortIncompleteMultipartUpload: { DaysAfterInitiation: 2 },
          },
        ],
      });
    },
  },
  {
    id: 'tables',
    describe: () =>
      `DynamoDB: ${platformNames.stateTable} (apps, stages, deployments) and ${platformNames.telemetryTable} (rollups, TTL)`,
    async run(f) {
      await ensureTable(f.ctx, {
        name: platformNames.stateTable,
        pk: 'pk',
        sk: 'sk',
        gsis: [['gsi1', 'gsi1pk', 'gsi1sk']],
        pointInTimeRecovery: !f.emulator,
        deletionProtection: !f.emulator,
        tags: platformTags('state'),
      });
      await ensureTable(f.ctx, {
        name: platformNames.telemetryTable,
        pk: 'pk',
        sk: 'sk',
        ttlAttribute: 'ttl',
        tags: platformTags('telemetry'),
      });
    },
  },
  {
    id: 'routes',
    describe: () =>
      `CloudFront KeyValueStore ${platformNames.keyValueStore} + router function ${platformNames.routerFunction}`,
    async run(f) {
      const kvs = await ensureKeyValueStore(f.ctx, {
        name: platformNames.keyValueStore,
        comment: 'host → route records',
      });
      f.state.kvs = kvs;
      f.state.routerFunctionArn = await ensureRouterFunction(f.ctx, {
        name: platformNames.routerFunction,
        code: buildRouterFunctionCode({ kvsId: kvs.id }),
        kvsArn: kvs.arn,
      });
    },
  },
  {
    id: 'edge-policies',
    describe: () => 'S3 origin access control + cache policy platform-default',
    async run(f) {
      f.state.sitesOacId = await ensureOriginAccessControl(f.ctx, {
        name: 'platform-sites',
        originType: 's3',
      });
      f.state.cachePolicyId = await ensureCachePolicy(f.ctx, routerCachePolicy('platform-default'));
    },
  },
  {
    id: 'distribution',
    awsOnly: true,
    describe: (c) =>
      `CloudFront distribution for *.${c.domain} (router function, sites origin, PriceClass_100, HTTP/3)`,
    async run(f) {
      const b = buckets(f);
      const dist = await ensureDistribution(f.ctx, {
        comment: DISTRIBUTION_COMMENT,
        tags: platformTags('edge'),
        config: {
          Aliases: { Quantity: 1, Items: [`*.${f.config.domain}`] },
          DefaultRootObject: '',
          Origins: {
            Quantity: 1,
            Items: [
              {
                Id: SITES_ORIGIN_ID,
                DomainName: `${b.sites}.s3.${f.config.region}.amazonaws.com`,
                OriginPath: '',
                CustomHeaders: { Quantity: 0 },
                S3OriginConfig: { OriginAccessIdentity: '' },
                OriginAccessControlId: need(f.state.sitesOacId, 'origin access control'),
                ConnectionAttempts: 3,
                ConnectionTimeout: 10,
              },
            ],
          },
          DefaultCacheBehavior: {
            TargetOriginId: SITES_ORIGIN_ID,
            ViewerProtocolPolicy: 'redirect-to-https',
            AllowedMethods: {
              Quantity: 7,
              Items: ['GET', 'HEAD', 'OPTIONS', 'PUT', 'POST', 'PATCH', 'DELETE'],
              CachedMethods: { Quantity: 2, Items: ['GET', 'HEAD'] },
            },
            Compress: true,
            CachePolicyId: need(f.state.cachePolicyId, 'cache policy'),
            OriginRequestPolicyId: ALL_VIEWER_EXCEPT_HOST_HEADER,
            FunctionAssociations: {
              Quantity: 1,
              Items: [
                {
                  FunctionARN: need(f.state.routerFunctionArn, 'router function'),
                  EventType: 'viewer-request',
                },
              ],
            },
            LambdaFunctionAssociations: { Quantity: 0 },
          },
          Enabled: true,
          PriceClass: 'PriceClass_100',
          HttpVersion: 'http2and3',
          IsIPV6Enabled: true,
          ViewerCertificate: {
            ACMCertificateArn: need(f.state.wildcardCertArn, 'wildcard certificate'),
            SSLSupportMethod: 'sni-only',
            MinimumProtocolVersion: 'TLSv1.2_2021',
            CloudFrontDefaultCertificate: false,
          },
          Restrictions: { GeoRestriction: { RestrictionType: 'none', Quantity: 0 } },
        },
      });
      f.state.distribution = dist;
      // Only this distribution may read the sites bucket (OAC).
      await ensureBucket(f.ctx, {
        name: b.sites,
        policy: {
          Version: '2012-10-17',
          Statement: [
            {
              Sid: 'AllowPlatformRouter',
              Effect: 'Allow',
              Principal: { Service: 'cloudfront.amazonaws.com' },
              Action: 's3:GetObject',
              Resource: `arn:aws:s3:::${b.sites}/*`,
              Condition: { StringEquals: { 'AWS:SourceArn': dist.arn } },
            },
          ],
        },
      });
    },
  },
  {
    id: 'dns-records',
    awsOnly: true,
    describe: (c) => `Route 53 aliases ${c.edgeHost} and ${c.consoleHost} → distribution`,
    async run(f) {
      const dist = need(f.state.distribution, 'distribution');
      await upsertRecords(f.ctx, need(f.state.zoneId, 'platform zone'), [
        ...cloudFrontAlias(f.config.edgeHost, dist.domainName),
        ...cloudFrontAlias(f.config.consoleHost, dist.domainName),
      ]);
    },
  },
  {
    id: 'user-pool',
    describe: (c) => `Cognito ${platformNames.userPool} (app end users) with managed login at ${c.loginHost}`,
    async run(f) {
      f.state.userPoolId = await ensureUserPool(f.ctx, {
        name: platformNames.userPool,
        tags: platformTags('identity'),
      });
      if (f.emulator) return; // no hosted login (or custom domains) on the emulator
      const cloudfrontDomain = await ensureUserPoolDomain(f.ctx, {
        userPoolId: f.state.userPoolId,
        domain: f.config.loginHost,
        certificateArn: need(f.state.zoneCertArn, 'platform zone certificate'),
      });
      if (cloudfrontDomain) {
        await upsertRecords(
          f.ctx,
          need(f.state.zoneId, 'platform zone'),
          cloudFrontAlias(f.config.loginHost, cloudfrontDomain),
        );
      }
    },
  },
  {
    id: 'iam',
    describe: (c) =>
      `IAM: ${platformNames.boundaryPolicy}, ${platformNames.controlPlaneRole}, GitHub OIDC + ${platformNames.ciRole} (repo:${c.github.owner}/${c.github.repo}, main only)`,
    async run(f) {
      const acct = need(f.state.accountId, 'account id');
      const b = buckets(f);
      f.state.boundaryPolicyArn = await ensureManagedPolicy(f.ctx, {
        name: platformNames.boundaryPolicy,
        path: '/platform/',
        description: 'Maximum permissions of any per-stage app role',
        document: policies.boundaryPolicy({
          region: f.config.region,
          accountId: acct,
          storageBucket: b.storage,
        }),
      });
      const controlPlane = await ensureRole(f.ctx, {
        name: platformNames.controlPlaneRole,
        path: '/platform/',
        description: 'Platform control plane (API, deployer, telemetry)',
        trust: policies.serviceTrustPolicy('lambda.amazonaws.com', 'scheduler.amazonaws.com'),
        inlinePolicies: {
          control: policies.controlPlanePolicy({
            region: f.config.region,
            accountId: acct,
            runtime: {
              artifactsBucket: b.artifacts,
              sitesBucket: b.sites,
              storageBucket: b.storage,
              ...(f.state.kvs ? { kvsArn: f.state.kvs.arn } : {}),
              ...(f.state.userPoolId ? { userPoolId: f.state.userPoolId } : {}),
              boundaryPolicyArn: f.state.boundaryPolicyArn,
            },
          }),
        },
        tags: platformTags('control-plane'),
      });
      f.state.controlPlaneRoleArn = controlPlane.arn;
      if (f.emulator) return; // the CI role only matters for GitHub Actions against real AWS
      await ensureGithubOidcProvider(f.ctx);
      const ci = await ensureRole(f.ctx, {
        name: platformNames.ciRole,
        path: '/platform/',
        description: `GitHub Actions for ${f.config.github.owner}/${f.config.github.repo} (main)`,
        trust: policies.githubCiTrustPolicy({ accountId: acct, ...f.config.github }),
        managedPolicyArns: [ADMINISTRATOR_ACCESS],
        maxSessionDurationSeconds: 3600,
        tags: platformTags('ci'),
      });
      f.state.ciRoleArn = ci.arn;
    },
  },
  {
    id: 'alerts',
    describe: () => `SNS ${platformNames.alertsTopic} + email subscription (ALERT_EMAIL)`,
    async run(f) {
      f.state.alertsTopicArn = await ensureTopic(f.ctx, {
        name: platformNames.alertsTopic,
        tags: platformTags('alerts'),
      });
      if (f.env.alertEmail && !f.emulator)
        await ensureEmailSubscription(f.ctx, f.state.alertsTopicArn, f.env.alertEmail);
    },
  },
  {
    id: 'parameters',
    describe: () =>
      `SSM: ${platformNames.sessionKeyParameter} (generated once) and ${platformNames.runtimeConfigParameter}`,
    async run(f) {
      await ensureParameterOnce(f.ctx, {
        name: platformNames.sessionKeyParameter,
        secure: true,
        description: 'HMAC key for platform sessions and CLI tokens',
        generate: () => randomBytes(32).toString('base64url'),
      });
      f.state.runtime = runtimeConfig(f);
      await writeRuntimeConfig(f);
    },
  },
  {
    id: 'control-plane',
    describe: (c) =>
      `build ${CONTROL_PLANE_DIR} and deploy it as app "${CONTROL_PLANE_APP}" (stage prod) → https://${c.consoleHost}`,
    async run(f) {
      const runtime = need(f.state.runtime, 'runtime config');
      const spec = '@ericminassian/plat';
      const cli = (await import(spec)) as {
        buildApp(opts: {
          cwd: string;
        }): Promise<{ manifest: ResolvedManifest; files: Partial<Record<ArtifactFile, string>> }>;
      };
      const build = await cli.buildApp({ cwd: join(f.repoRoot, CONTROL_PLANE_DIR) });
      const deploymentId = newDeploymentId();
      const upload = async (file: ArtifactFile) => {
        const path = build.files[file];
        if (!path) return undefined;
        return f.engine.putArtifact(
          runtime,
          names.artifactKey(build.manifest.name, PROD_STAGE, deploymentId, file),
          readFileSync(path),
        );
      };
      const [server, worker, stat] = await Promise.all([
        upload('server.zip'),
        upload('worker.zip'),
        upload('static.zip'),
      ]);
      await upload('manifest.json');
      const result = await f.engine.deployStage({
        manifest: build.manifest,
        stage: PROD_STAGE,
        deploymentId,
        platform: runtime,
        artifacts: {
          ...(server ? { server } : {}),
          ...(worker ? { worker } : {}),
          ...(stat ? { static: stat } : {}),
        },
        roleArn: need(f.state.controlPlaneRoleArn, 'control plane role'),
        webMode: f.emulator ? 'external' : 'function',
        logRetentionDays: 30,
      });
      f.state.controlPlaneWorkerArn = result.workerFunction?.arn;
      await registerControlPlane(f, runtime, build.manifest, deploymentId, result);
      f.log(`control plane ${deploymentId} → ${result.url}`);
    },
  },
  {
    id: 'telemetry',
    describe: () => 'account-level log subscription filter → control plane worker (telemetry processor)',
    async run(f) {
      const workerArn = need(f.state.controlPlaneWorkerArn, 'control plane worker');
      const acct = need(f.state.accountId, 'account id');
      f.state.runtime = { ...need(f.state.runtime, 'runtime config'), telemetryFunctionArn: workerArn };
      await writeRuntimeConfig(f);
      await ensurePermission(f.ctx, {
        functionName: workerArn,
        statementId: 'cloudwatch-logs-account-subscription',
        principal: 'logs.amazonaws.com',
        action: 'lambda:InvokeFunction',
        sourceArn: `arn:aws:logs:${f.config.region}:${acct}:log-group:*`,
      });
      await ensureAccountSubscriptionFilter(f.ctx, {
        name: 'platform-telemetry',
        destinationArn: workerArn,
        filterPattern: TELEMETRY_FILTER_PATTERN,
        excludeLogGroups: [names.logGroup(CONTROL_PLANE_APP, PROD_STAGE, 'worker')],
      });
    },
  },
];

function runtimeConfig(f: FoundationContext): PlatformRuntimeConfig {
  const b = buckets(f);
  return {
    v: 1,
    target: f.emulator ? 'emulator' : 'aws',
    accountId: need(f.state.accountId, 'account id'),
    region: f.config.region,
    domain: f.emulator ? 'localhost' : f.config.domain,
    publicScheme: f.emulator ? 'http' : 'https',
    ...(f.emulator ? { publicPort: 3000 } : {}),
    artifactsBucket: b.artifacts,
    sitesBucket: b.sites,
    storageBucket: b.storage,
    stateTable: platformNames.stateTable,
    telemetryTable: platformNames.telemetryTable,
    ...(f.state.boundaryPolicyArn ? { boundaryPolicyArn: f.state.boundaryPolicyArn } : {}),
    ...(f.state.kvs ? { kvsArn: f.state.kvs.arn } : {}),
    ...(f.state.distribution ? { distributionArn: f.state.distribution.arn } : {}),
    ...(f.state.userPoolId ? { userPoolId: f.state.userPoolId } : {}),
    loginUrl: f.emulator ? 'http://localhost:3000' : `https://${f.config.loginHost}`,
    ...(f.state.alertsTopicArn ? { alertsTopicArn: f.state.alertsTopicArn } : {}),
    ...(f.state.controlPlaneWorkerArn ? { telemetryFunctionArn: f.state.controlPlaneWorkerArn } : {}),
  };
}

async function writeRuntimeConfig(f: FoundationContext): Promise<void> {
  await putParameter(f.ctx, {
    name: platformNames.runtimeConfigParameter,
    value: JSON.stringify(need(f.state.runtime, 'runtime config')),
    description: 'Shared platform resources (written by foundation/)',
  });
}

/**
 * The foundation deploys the control plane directly (the API can't deploy
 * itself), so it also writes the records the API would have written. That
 * way the console lists the `platform` app, the pinger checks it, and
 * rollback has a previous deployment to return to.
 */
async function registerControlPlane(
  f: FoundationContext,
  runtime: PlatformRuntimeConfig,
  manifest: ResolvedManifest,
  deploymentId: string,
  result: Awaited<ReturnType<FoundationContext['engine']['deployStage']>>,
): Promise<void> {
  const ddb = DynamoDBDocumentClient.from(f.ctx.clients.dynamodb, {
    marshallOptions: { removeUndefinedValues: true },
  });
  const TableName = runtime.stateTable;
  const now = new Date().toISOString();
  const admins = f.config.members.filter((m) => m.role === 'admin').map((m) => m.github);
  const app = manifest.name;

  await ddb
    .send(
      new PutCommand({
        TableName,
        Item: appItem({
          name: app,
          repo: `${f.config.github.owner}/${f.config.github.repo}`,
          description: 'The platform control plane: console, API, deployer and telemetry.',
          owners: admins,
          createdBy: 'foundation',
          createdAt: now,
        }),
        ConditionExpression: 'attribute_not_exists(pk)',
      }),
    )
    .catch((err: { name?: string }) => {
      if (err.name !== 'ConditionalCheckFailedException') throw err;
    });

  const prev = (await ddb.send(new GetCommand({ TableName, Key: stageKey(app, PROD_STAGE) }))).Item as
    | StageItem
    | undefined;
  const revisionId = result.webFunction?.revisionId;
  await ddb.send(
    new PutCommand({
      TableName,
      Item: deploymentItem({
        id: deploymentId,
        app,
        stage: PROD_STAGE,
        status: 'succeeded',
        actor: 'foundation',
        manifest,
        url: result.url,
        events: [{ ts: Date.now(), level: 'info', msg: 'deployed by the foundation' }],
        createdAt: now,
        startedAt: now,
        finishedAt: now,
        ...(result.route ? { route: result.route } : {}),
        ...(revisionId ? { revisionId } : {}),
      }),
    }),
  );
  await ddb.send(
    new PutCommand({
      TableName,
      Item: stageItem({
        app,
        stage: PROD_STAGE,
        host: result.host,
        url: result.url,
        status: 'active',
        preview: false,
        currentDeployment: deploymentId,
        ...(prev?.currentDeployment ? { previousDeployment: prev.currentDeployment } : {}),
        ...(revisionId ? { currentRevision: revisionId } : {}),
        ...(prev?.currentRevision ? { previousRevision: prev.currentRevision } : {}),
        ...(result.route ? { route: result.route } : {}),
        ...(prev?.route ? { previousRoute: prev.route } : {}),
        createdAt: prev?.createdAt ?? now,
        updatedAt: now,
      }),
    }),
  );
}
