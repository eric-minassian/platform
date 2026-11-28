import {
  type EmailRuntimeConfig,
  emailFromAddress,
  IAM_APP_PATH,
  names,
  ownFunctionHandlers,
  type PlatformRuntimeConfig,
  platformNames,
  publicStores,
  type ResolvedManifest,
  telemetryKeys,
} from '@ericminassian/platform-core';
import { type PolicyDocument, type PolicyStatement, policy } from './util.ts';

export interface StagePolicyInput {
  app: string;
  stage: string;
  region: string;
  accountId: string;
  manifest: ResolvedManifest;
  platform: Pick<PlatformRuntimeConfig, 'storageBucket' | 'telemetryTable' | 'realtime' | 'email'>;
}

/** A channel namespace's ARN in the platform's Event API. */
export function channelNamespaceArn(
  region: string,
  accountId: string,
  apiId: string,
  namespace: string,
): string {
  return `arn:aws:appsync:${region}:${accountId}:apis/${apiId}/channelNamespace/${namespace}`;
}

/** An SES configuration set's ARN (each stage's is `names.emailTenant`). */
export function configurationSetArn(region: string, accountId: string, name: string): string {
  return `arn:aws:ses:${region}:${accountId}:configuration-set/${name}`;
}

/** An SES identity's ARN (the platform's is its mail domain). */
export function emailIdentityArn(region: string, accountId: string, identity: string): string {
  return `arn:aws:ses:${region}:${accountId}:identity/${identity}`;
}

/** Trust for per-stage roles: the worker and Web Function (Lambda) and schedules (Scheduler). */
export function stageTrustPolicy(): PolicyDocument {
  return policy({
    Effect: 'Allow',
    Principal: { Service: ['lambda.amazonaws.com', 'scheduler.amazonaws.com'] },
    Action: 'sts:AssumeRole',
  });
}

/**
 * Exactly what the runtime SDK needs for one stage, nothing more. Every
 * resource is addressed by its deterministic name, and app/stage names can
 * never contain `--`, so `<app>--<stage>--*` cannot match another stage.
 */
export function stageRolePolicy(input: StagePolicyInput): PolicyDocument {
  const { app, stage, region, accountId: acct, manifest } = input;
  const base = names.base(app, stage);
  const statements: PolicyStatement[] = [];

  // No logs:CreateLogGroup: the engine creates the stage's groups. With it, logs still in flight
  // when a stage is destroyed recreate the groups right after destroy deletes them.
  statements.push({
    Sid: 'Logs',
    Effect: 'Allow',
    Action: ['logs:CreateLogStream', 'logs:PutLogEvents'],
    Resource: [
      `arn:aws:logs:${region}:${acct}:log-group:${names.logGroupPrefix(app, stage)}*`,
      `arn:aws:logs:${region}:${acct}:log-group:${names.logGroupPrefix(app, stage)}*:log-stream:*`,
    ],
  });

  if (manifest.db) {
    const table = `arn:aws:dynamodb:${region}:${acct}:table/${names.table(app, stage)}`;
    statements.push({
      Sid: 'Db',
      Effect: 'Allow',
      Action: [
        'dynamodb:GetItem',
        'dynamodb:BatchGetItem',
        'dynamodb:PutItem',
        'dynamodb:UpdateItem',
        'dynamodb:DeleteItem',
        'dynamodb:BatchWriteItem',
        'dynamodb:Query',
        'dynamodb:Scan',
        'dynamodb:ConditionCheckItem',
        'dynamodb:DescribeTable',
      ],
      Resource: [table, `${table}/index/*`],
    });
  }

  if (manifest.worker) {
    // Jobs (core jobs.ts): the dead-letter queue takes failed jobs from the SDK, Lambda's on-failure
    // destination and Scheduler, all as this role. Receiving is for queues from before 0.4.0,
    // which drain through their event source mappings (also this role) before they go.
    statements.push(
      {
        Sid: 'Jobs',
        Effect: 'Allow',
        Action: [
          'sqs:SendMessage',
          'sqs:ReceiveMessage',
          'sqs:DeleteMessage',
          'sqs:GetQueueAttributes',
          'sqs:ChangeMessageVisibility',
        ],
        Resource: `arn:aws:sqs:${region}:${acct}:${base}--*`,
      },
      {
        // Retries and delayed sends are one-shot schedules in the stage's group, invoking the
        // stage's functions as this role.
        Sid: 'JobSchedules',
        Effect: 'Allow',
        Action: 'scheduler:CreateSchedule',
        Resource: `arn:aws:scheduler:${region}:${acct}:schedule/${names.scheduleGroup(app, stage)}/_*`,
      },
      {
        Sid: 'JobSchedulesRole',
        Effect: 'Allow',
        Action: 'iam:PassRole',
        Resource: `arn:aws:iam::${acct}:role${IAM_APP_PATH}${names.role(app, stage)}`,
        Condition: { StringEquals: { 'iam:PassedToService': 'scheduler.amazonaws.com' } },
      },
    );
  }

  statements.push({
    Sid: 'Events',
    Effect: 'Allow',
    Action: 'events:PutEvents',
    Resource: `arn:aws:events:${region}:${acct}:event-bus/${names.eventBus(app, stage)}`,
  });

  if (manifest.storage.length > 0) {
    const prefixes = [names.storagePrefix(app, stage)];
    if (publicStores(manifest).length > 0) prefixes.push(names.publicStoragePrefix(app, stage));
    statements.push(
      {
        Sid: 'StorageObjects',
        Effect: 'Allow',
        Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
        Resource: prefixes.map((prefix) => `arn:aws:s3:::${input.platform.storageBucket}/${prefix}*`),
      },
      {
        Sid: 'StorageList',
        Effect: 'Allow',
        Action: 's3:ListBucket',
        Resource: `arn:aws:s3:::${input.platform.storageBucket}`,
        Condition: { StringLike: { 's3:prefix': prefixes.map((prefix) => `${prefix}*`) } },
      },
    );
  }

  const secrets = names.secretsPath(app, stage).replace(/\/$/, '');
  const shared = names.sharedSecretsPath(app).replace(/\/$/, '');
  statements.push(
    {
      Sid: 'Secrets',
      Effect: 'Allow',
      Action: ['ssm:GetParameter', 'ssm:GetParameters', 'ssm:GetParametersByPath'],
      Resource: [secrets, `${secrets}/*`, shared, `${shared}/*`].map(
        (p) => `arn:aws:ssm:${region}:${acct}:parameter${p}`,
      ),
    },
    {
      Sid: 'SecretsDecrypt',
      Effect: 'Allow',
      Action: 'kms:Decrypt',
      Resource: `arn:aws:kms:${region}:${acct}:key/*`,
      Condition: { StringEquals: { 'kms:ViaService': `ssm.${region}.amazonaws.com` } },
    },
  );

  // Publishing only (HTTP, IAM-signed), and only to this stage's namespace:
  // namespaces are per stage so IAM, not handler code, keeps stages apart.
  const realtimeApi = input.platform.realtime?.apiId;
  if (manifest.realtime && realtimeApi) {
    statements.push({
      Sid: 'Realtime',
      Effect: 'Allow',
      Action: 'appsync:EventPublish',
      Resource: channelNamespaceArn(region, acct, realtimeApi, names.realtimeNamespace(app, stage)),
    });
  }

  // Sending only as this stage: its address, its tenant (whose reputation policy can pause it, a
  // backstop app code can't get around) and its configuration set. SES v1 shares the action
  // name, so `ses:ApiVersion` keeps the grant to SESv2, the API the SDK sends with. The SDK names
  // the tenant and the configuration set on every send; IAM checks the identity and the
  // configuration set as resources.
  const email = input.platform.email;
  if (manifest.email && email) {
    const tenant = names.emailTenant(app, stage);
    statements.push(
      {
        Sid: 'Email',
        Effect: 'Allow',
        Action: 'ses:SendEmail',
        Resource: [email.identityArn, configurationSetArn(region, acct, tenant)],
        Condition: {
          StringEquals: {
            'ses:FromAddress': emailFromAddress(app, stage, email.domain),
            'ses:TenantName': tenant,
            'ses:ApiVersion': '2',
          },
        },
      },
      {
        // The daily limit's counter: one row per UTC day in the platform's telemetry table,
        // under this stage's own partition key only.
        Sid: 'EmailUsage',
        Effect: 'Allow',
        Action: 'dynamodb:UpdateItem',
        Resource: `arn:aws:dynamodb:${region}:${acct}:table/${input.platform.telemetryTable}`,
        Condition: {
          'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': [telemetryKeys.email(app, stage)] },
        },
      },
    );
  }

  // The SDK sends queue messages and `invokeJob` to the worker's function and handlers' own, and
  // Scheduler (crons, retries, delayed sends) calls them as this role.
  if (manifest.worker) {
    const functions = [
      names.workerFunction(app, stage),
      ...ownFunctionHandlers(manifest).map((h) => names.handlerFunction(app, stage, h.kind, h.name)),
    ].map((fn) => `arn:aws:lambda:${region}:${acct}:function:${fn}`);
    statements.push({
      Sid: 'InvokeWorker',
      Effect: 'Allow',
      Action: 'lambda:InvokeFunction',
      Resource: functions.length === 1 ? functions[0]! : functions,
    });
  }

  return policy(...statements);
}

/**
 * Permission boundary on every per-stage role: the union of what any stage
 * role may ever do, scoped to platform naming patterns. Even if a stage
 * policy were wrong, a stage role can't touch platform state, IAM or other
 * accounts' resources.
 */
export function boundaryPolicy(input: {
  region: string;
  accountId: string;
  storageBucket: string;
  /** The platform's Event API; stage roles may publish to its stage namespaces. */
  realtimeApiId?: string;
  /**
   * The platform's mail domain and the table holding usage counters; stage roles may send as
   * a stage tenant and count what they send.
   */
  email?: { identityArn: string; usageTable: string };
}): PolicyDocument {
  const { region, accountId: acct } = input;
  const email: PolicyStatement[] = input.email
    ? [
        {
          Sid: 'StageEmail',
          Effect: 'Allow',
          Action: 'ses:SendEmail',
          // Tenants and their configuration sets are `<app>--<stage>`.
          Resource: [input.email.identityArn, configurationSetArn(region, acct, '*--*')],
          Condition: { StringLike: { 'ses:TenantName': '*--*' } },
        },
        {
          Sid: 'StageEmailUsage',
          Effect: 'Allow',
          Action: 'dynamodb:UpdateItem',
          Resource: `arn:aws:dynamodb:${region}:${acct}:table/${input.email.usageTable}`,
          Condition: {
            'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [telemetryKeys.email('*', '*')] },
          },
        },
      ]
    : [];
  const realtime: PolicyStatement[] = input.realtimeApiId
    ? [
        {
          Sid: 'StageRealtime',
          Effect: 'Allow',
          Action: 'appsync:EventPublish',
          // Stage namespaces are `<app>--<stage>` (or that, hashed, when long); `--` never
          // appears in an app or stage name.
          Resource: channelNamespaceArn(region, acct, input.realtimeApiId, '*--*'),
        },
      ]
    : [];
  return policy(
    {
      Sid: 'StageLogs',
      Effect: 'Allow',
      Action: ['logs:CreateLogStream', 'logs:PutLogEvents'],
      Resource: `arn:aws:logs:${region}:${acct}:log-group:/platform/apps/*`,
    },
    {
      Sid: 'StageData',
      Effect: 'Allow',
      Action: ['dynamodb:*Item', 'dynamodb:Query', 'dynamodb:Scan', 'dynamodb:DescribeTable'],
      Resource: [
        `arn:aws:dynamodb:${region}:${acct}:table/*--*`,
        `arn:aws:dynamodb:${region}:${acct}:table/*--*/index/*`,
      ],
    },
    {
      Sid: 'StageQueues',
      Effect: 'Allow',
      Action: [
        'sqs:SendMessage',
        'sqs:ReceiveMessage',
        'sqs:DeleteMessage',
        'sqs:GetQueueAttributes',
        'sqs:GetQueueUrl',
        'sqs:ChangeMessageVisibility',
      ],
      Resource: `arn:aws:sqs:${region}:${acct}:*--*`,
    },
    {
      Sid: 'StageEvents',
      Effect: 'Allow',
      Action: 'events:PutEvents',
      Resource: `arn:aws:events:${region}:${acct}:event-bus/*--*`,
    },
    {
      // Jobs' retries and delayed sends (`_`-prefixed one-shot schedules in a stage's group), run as
      // a stage role.
      Sid: 'StageJobSchedules',
      Effect: 'Allow',
      Action: 'scheduler:CreateSchedule',
      Resource: `arn:aws:scheduler:${region}:${acct}:schedule/*--*/_*`,
    },
    {
      Sid: 'StageJobSchedulesRole',
      Effect: 'Allow',
      Action: 'iam:PassRole',
      Resource: `arn:aws:iam::${acct}:role${IAM_APP_PATH}*`,
      Condition: { StringEquals: { 'iam:PassedToService': 'scheduler.amazonaws.com' } },
    },
    {
      Sid: 'StageStorage',
      Effect: 'Allow',
      Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:ListBucket'],
      Resource: [`arn:aws:s3:::${input.storageBucket}`, `arn:aws:s3:::${input.storageBucket}/*`],
    },
    {
      Sid: 'StageSecrets',
      Effect: 'Allow',
      Action: ['ssm:GetParameter', 'ssm:GetParameters', 'ssm:GetParametersByPath', 'kms:Decrypt'],
      Resource: [
        `arn:aws:ssm:${region}:${acct}:parameter/platform/apps/*`,
        `arn:aws:kms:${region}:${acct}:key/*`,
      ],
    },
    {
      // Workers are `<app>--<stage>--worker`; handlers' own functions are `…--worker--<handler>`,
      // hashed when long, so all that's sure to remain is a second `--`.
      Sid: 'StageWorkers',
      Effect: 'Allow',
      Action: 'lambda:InvokeFunction',
      Resource: `arn:aws:lambda:${region}:${acct}:function:*--*--*`,
    },
    ...realtime,
    ...email,
  );
}

/**
 * The control plane (API + deployer + telemetry) manages every stage's
 * resources, reads telemetry and costs, and writes the route store. It may
 * only create roles under the app path, and only with the boundary attached.
 */
export function controlPlanePolicy(input: {
  region: string;
  accountId: string;
  runtime: Pick<
    PlatformRuntimeConfig,
    | 'artifactsBucket'
    | 'sitesBucket'
    | 'storageBucket'
    | 'kvsArn'
    | 'userPoolId'
    | 'boundaryPolicyArn'
    | 'alertsTopicArn'
    | 'distributionArn'
  > & {
    realtime?: Pick<NonNullable<PlatformRuntimeConfig['realtime']>, 'apiId'>;
    email?: Pick<EmailRuntimeConfig, 'identityArn'>;
  };
}): PolicyDocument {
  const { region, accountId: acct, runtime } = input;
  const appRoles = `arn:aws:iam::${acct}:role${IAM_APP_PATH}*`;
  const statements: PolicyStatement[] = [
    {
      Sid: 'StageRoles',
      Effect: 'Allow',
      Action: ['iam:CreateRole', 'iam:PutRolePermissionsBoundary'],
      Resource: appRoles,
      ...(runtime.boundaryPolicyArn
        ? { Condition: { StringEquals: { 'iam:PermissionsBoundary': runtime.boundaryPolicyArn } } }
        : {}),
    },
    {
      // IAM authorizes GetRole on a role that doesn't exist yet against the
      // path-less ARN (`role/<name>`), so a path-scoped grant can't cover the
      // "does it exist?" lookup. Reading role metadata is harmless; everything
      // that changes a role stays scoped to the app path below.
      Sid: 'StageRolesLookup',
      Effect: 'Allow',
      Action: ['iam:GetRole'],
      Resource: `arn:aws:iam::${acct}:role/*`,
    },
    {
      Sid: 'StageRolesManage',
      Effect: 'Allow',
      Action: [
        'iam:DeleteRole',
        'iam:UpdateAssumeRolePolicy',
        'iam:PutRolePolicy',
        'iam:GetRolePolicy',
        'iam:DeleteRolePolicy',
        'iam:ListRolePolicies',
        'iam:ListAttachedRolePolicies',
        'iam:TagRole',
        'iam:UntagRole',
        'iam:PassRole',
      ],
      Resource: appRoles,
    },
    {
      Sid: 'StageCompute',
      Effect: 'Allow',
      Action: ['lambda:*'],
      Resource: [
        `arn:aws:lambda:${region}:${acct}:function:*--*`,
        `arn:aws:lambda:${region}:${acct}:web-function/*--*`,
        `arn:aws:lambda:${region}:${acct}:web-function/*--*/*`,
        `arn:aws:lambda:${region}:${acct}:event-source-mapping:*`,
      ],
    },
    {
      Sid: 'StageComputeList',
      Effect: 'Allow',
      Action: [
        'lambda:ListEventSourceMappings',
        'lambda:CreateEventSourceMapping',
        'lambda:ListFunctions',
        'lambda:ListWebFunctions',
        // Whether `auto` may run a server in request mode (core `requestModeBlocked`).
        'lambda:GetAccountSettings',
      ],
      Resource: '*',
    },
    {
      Sid: 'StageData',
      Effect: 'Allow',
      Action: ['dynamodb:*'],
      Resource: [`arn:aws:dynamodb:${region}:${acct}:table/*`],
    },
    {
      Sid: 'StageMessaging',
      Effect: 'Allow',
      Action: ['sqs:*', 'events:*', 'scheduler:*'],
      Resource: '*',
    },
    {
      Sid: 'Logs',
      Effect: 'Allow',
      Action: ['logs:*'],
      Resource: '*',
    },
    {
      Sid: 'PlatformBuckets',
      Effect: 'Allow',
      Action: ['s3:*'],
      Resource: [runtime.artifactsBucket, runtime.sitesBucket, runtime.storageBucket].flatMap((b) => [
        `arn:aws:s3:::${b}`,
        `arn:aws:s3:::${b}/*`,
      ]),
    },
    {
      // PutParameter with Tags (secrets are created tagged) is also authorized
      // as ssm:AddTagsToResource, which `*Parameter*` doesn't match.
      Sid: 'Parameters',
      Effect: 'Allow',
      Action: [
        'ssm:*Parameter*',
        'ssm:AddTagsToResource',
        'kms:Decrypt',
        'kms:Encrypt',
        'kms:GenerateDataKey',
      ],
      Resource: [`arn:aws:ssm:${region}:${acct}:parameter/platform/*`, `arn:aws:kms:${region}:${acct}:key/*`],
    },
    {
      Sid: 'ReadOnlyTelemetry',
      Effect: 'Allow',
      Action: [
        'cloudwatch:GetMetricData',
        'cloudwatch:ListMetrics',
        'ce:GetCostAndUsage',
        'ce:GetCostForecast',
        'tag:GetResources',
        'sts:GetCallerIdentity',
      ],
      Resource: '*',
    },
  ];
  if (runtime.kvsArn) {
    statements.push({
      Sid: 'Routes',
      Effect: 'Allow',
      Action: ['cloudfront-keyvaluestore:*', 'cloudfront:DescribeKeyValueStore'],
      Resource: runtime.kvsArn,
    });
  }
  if (runtime.distributionArn) {
    // The edge floor (control plane edge-floor.ts): its web ACL exists only while it's on, so the
    // control plane creates, attaches, detaches and deletes it. Granted with or without
    // `limits.edgeFloorAt`, so a floor that was on when the setting went can still be taken down.
    // UpdateDistribution can change the whole router config, as writing the route store can
    // already route any host anywhere.
    const webAcl = `arn:aws:wafv2:us-east-1:${acct}:global/webacl/${platformNames.edgeWebAcl}/*`;
    statements.push(
      {
        Sid: 'EdgeFloorDistribution',
        Effect: 'Allow',
        Action: ['cloudfront:GetDistributionConfig', 'cloudfront:UpdateDistribution'],
        Resource: runtime.distributionArn,
      },
      {
        // GetWebACL is also what CloudFront checks when a distribution is pointed at a web ACL.
        Sid: 'EdgeFloorWebAcl',
        Effect: 'Allow',
        Action: [
          'wafv2:CreateWebACL',
          'wafv2:GetWebACL',
          'wafv2:UpdateWebACL',
          'wafv2:DeleteWebACL',
          'wafv2:TagResource',
          'wafv2:GetSampledRequests',
        ],
        Resource: webAcl,
      },
      {
        // Finds the web ACL's id and lock token by name; the action takes no resource.
        Sid: 'EdgeFloorLookup',
        Effect: 'Allow',
        Action: 'wafv2:ListWebACLs',
        Resource: '*',
      },
      {
        // The alarm on the router's requests per minute that turns it on (foundation stack).
        Sid: 'EdgeFloorAlarm',
        Effect: 'Allow',
        Action: 'cloudwatch:DescribeAlarms',
        Resource: `arn:aws:cloudwatch:${region}:${acct}:alarm:${platformNames.edgeFloorAlarm}`,
      },
    );
  }
  if (runtime.userPoolId) {
    statements.push({
      Sid: 'AppClients',
      Effect: 'Allow',
      Action: [
        'cognito-idp:*UserPoolClient*',
        'cognito-idp:*ManagedLoginBranding*',
        'cognito-idp:ListUsers',
        'cognito-idp:AdminGetUser',
      ],
      Resource: `arn:aws:cognito-idp:${region}:${acct}:userpool/${runtime.userPoolId}`,
    });
  }
  if (runtime.realtime) {
    const api = `arn:aws:appsync:${region}:${acct}:apis/${runtime.realtime.apiId}`;
    statements.push({
      // Stage namespaces (deploy, destroy) and the public subscribe key (nightly extension).
      Sid: 'Realtime',
      Effect: 'Allow',
      Action: [
        'appsync:CreateChannelNamespace',
        'appsync:UpdateChannelNamespace',
        'appsync:DeleteChannelNamespace',
        'appsync:GetChannelNamespace',
        'appsync:ListChannelNamespaces',
        'appsync:CreateApiKey',
        'appsync:UpdateApiKey',
        'appsync:ListApiKeys',
        'appsync:TagResource',
        'appsync:ListTagsForResource',
      ],
      Resource: [api, `${api}/*`],
    });
    statements.push({
      // listStageResources finds the API by name, like every other resource.
      Sid: 'RealtimeLookup',
      Effect: 'Allow',
      Action: 'appsync:ListApis',
      Resource: '*',
    });
  }
  if (runtime.email) {
    const ses = `arn:aws:ses:${region}:${acct}`;
    statements.push(
      {
        // Stage tenants and their configuration sets: the engine creates, associates and deletes
        // them; the control plane reads their status, pauses and resumes sending, and manages
        // their suppression lists. Tenant ARNs are `tenant/<name>/<id>`, so `*--*` covers both.
        Sid: 'Email',
        Effect: 'Allow',
        Action: [
          'ses:CreateConfigurationSet',
          'ses:GetConfigurationSet',
          'ses:DeleteConfigurationSet',
          'ses:PutConfigurationSetReputationOptions',
          'ses:CreateTenant',
          'ses:GetTenant',
          'ses:DeleteTenant',
          'ses:PutTenantSuppressionAttributes',
          'ses:CreateTenantResourceAssociation',
          'ses:DeleteTenantResourceAssociation',
          'ses:ListTenantResources',
          'ses:TagResource',
          'ses:ListTagsForResource',
          'ses:GetReputationEntity',
          'ses:UpdateReputationEntityCustomerManagedStatus',
          'ses:ListSuppressedDestinations',
          'ses:GetSuppressedDestination',
          'ses:DeleteSuppressedDestination',
        ],
        Resource: [`${ses}:tenant/*--*`, `${ses}:configuration-set/*--*`],
      },
      {
        // An association is authorized against the associated resource too: here, the domain.
        Sid: 'EmailDomain',
        Effect: 'Allow',
        Action: ['ses:CreateTenantResourceAssociation', 'ses:DeleteTenantResourceAssociation'],
        Resource: runtime.email.identityArn,
      },
      {
        // A tenant's ARN ends in an id SES assigns, so a lookup by name of a tenant that doesn't
        // exist (every deploy and destroy of a stage without email) is authorized against `*`.
        Sid: 'EmailTenantLookup',
        Effect: 'Allow',
        Action: ['ses:GetTenant', 'ses:ListTenantResources'],
        Resource: '*',
      },
    );
  }
  if (runtime.alertsTopicArn) {
    statements.push({
      Sid: 'Alerts',
      Effect: 'Allow',
      Action: 'sns:Publish',
      Resource: runtime.alertsTopicArn,
    });
  }
  return policy(...statements);
}

export function serviceTrustPolicy(...services: string[]): PolicyDocument {
  return policy({ Effect: 'Allow', Principal: { Service: services }, Action: 'sts:AssumeRole' });
}

export const BOUNDARY_POLICY_NAME = platformNames.boundaryPolicy;
