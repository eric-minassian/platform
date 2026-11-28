import { readFileSync } from 'node:fs';
import {
  EDGE_FLOOR_JOB,
  EDGE_LOG_FIELDS,
  emailDomain,
  emailMailFromDomain,
  NOT_FOUND_PATH,
  type PlatformConfig,
  platformNames,
  REALTIME_TOKEN_PATTERN,
} from '@ericminassian/platform-core';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import config from '../../platform.config.ts';
import { FOUNDATION_STACK, FoundationStack, routerFunctionName } from '../src/stack.ts';

const account = '123456789012';
const delegationRole = 'arn:aws:iam::210987654321:role/route53-delegation-platform-ericminassian-com';
// The feature flags `cdk synth` runs with, so the template matches a real deploy.
const { context } = JSON.parse(readFileSync(new URL('../cdk.json', import.meta.url), 'utf8')) as {
  context: Record<string, unknown>;
};

function synth(opts: { alertEmail?: string; config?: PlatformConfig } = {}): Template {
  const stack = new FoundationStack(new App({ context }), FOUNDATION_STACK, {
    env: { account, region: config.region },
    config: opts.config ?? config,
    dnsDelegationRoleArn: delegationRole,
    ...(opts.alertEmail ? { alertEmail: opts.alertEmail } : {}),
  });
  return Template.fromStack(stack);
}

const template = synth({ alertEmail: 'alerts@example.com' });
const mailDomain = emailDomain(config.zone);

/** Logical id of the one resource of `type` whose properties match `props`. */
function logicalId(type: string, props: Record<string, unknown>): string {
  const ids = Object.keys(template.findResources(type, { Properties: props }));
  expect(ids).toHaveLength(1);
  return ids[0]!;
}

describe('foundation stack', () => {
  it('keeps the names the engine, control plane and CLI address', () => {
    for (const bucket of [
      platformNames.artifactsBucket(account, config.region),
      platformNames.sitesBucket(account, config.region),
      platformNames.storageBucket(account, config.region),
    ])
      template.hasResourceProperties('AWS::S3::Bucket', { BucketName: bucket });
    template.hasResourceProperties('AWS::DynamoDB::Table', { TableName: platformNames.stateTable });
    template.hasResourceProperties('AWS::DynamoDB::Table', { TableName: platformNames.telemetryTable });
    template.hasResourceProperties('AWS::CloudFront::KeyValueStore', { Name: platformNames.keyValueStore });
    template.hasResourceProperties('AWS::CloudFront::Function', { Name: routerFunctionName() });
    template.hasResourceProperties('AWS::Cognito::UserPool', { UserPoolName: platformNames.userPool });
    template.hasResourceProperties('AWS::IAM::ManagedPolicy', {
      ManagedPolicyName: platformNames.boundaryPolicy,
      Path: '/platform/',
    });
    for (const role of [platformNames.controlPlaneRole, platformNames.ciRole])
      template.hasResourceProperties('AWS::IAM::Role', { RoleName: role, Path: '/platform/' });
    template.hasResourceProperties('AWS::SNS::Topic', { TopicName: platformNames.alertsTopic });
    template.hasResourceProperties('AWS::SSM::Parameter', { Name: platformNames.runtimeConfigParameter });
    template.hasResourceProperties('AWS::AppSync::Api', { Name: platformNames.realtimeApi });
    for (const fn of [platformNames.realtimeAuthorizer, platformNames.notFoundFunction])
      template.hasResourceProperties('AWS::Lambda::Function', { FunctionName: fn });
    template.hasResourceProperties('AWS::SES::EmailIdentity', { EmailIdentity: mailDomain });
  });

  describe('realtime', () => {
    const api = () => logicalId('AWS::AppSync::Api', { Name: platformNames.realtimeApi });
    const authorizer = () =>
      logicalId('AWS::Lambda::Function', { FunctionName: platformNames.realtimeAuthorizer });

    it('lets only IAM publish and subscribers in with the API key or a checked token', () => {
      template.hasResourceProperties('AWS::AppSync::Api', {
        Name: platformNames.realtimeApi,
        EventConfig: {
          AuthProviders: [
            { AuthType: 'API_KEY' },
            { AuthType: 'AWS_IAM' },
            {
              AuthType: 'AWS_LAMBDA',
              LambdaAuthorizerConfig: {
                AuthorizerUri: { 'Fn::GetAtt': [authorizer(), 'Arn'] },
                AuthorizerResultTtlInSeconds: 300,
                IdentityValidationExpression: REALTIME_TOKEN_PATTERN,
              },
            },
          ],
          ConnectionAuthModes: [{ AuthType: 'API_KEY' }, { AuthType: 'AWS_LAMBDA' }],
          DefaultPublishAuthModes: [{ AuthType: 'AWS_IAM' }],
          DefaultSubscribeAuthModes: [{ AuthType: 'AWS_LAMBDA' }],
        },
      });
      // The control plane owns the key (nightly extension); a stack copy would be reverted.
      template.resourceCountIs('AWS::AppSync::ApiKey', 0);
    });

    it('runs the authorizer on Node 24 and lets only this API invoke it', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: platformNames.realtimeAuthorizer,
        Runtime: 'nodejs24.x',
        Architectures: ['arm64'],
        Handler: 'index.handler',
      });
      template.hasResourceProperties('AWS::Lambda::Permission', {
        FunctionName: { 'Fn::GetAtt': [authorizer(), 'Arn'] },
        Principal: 'appsync.amazonaws.com',
        SourceArn: { 'Fn::GetAtt': [api(), 'ApiArn'] },
      });
    });

    it('lets the authorizer read stage keys and nothing else', () => {
      const policies = template.findResources('AWS::IAM::Policy') as Record<
        string,
        {
          Properties: {
            Roles: Array<{ Ref?: string }>;
            PolicyDocument: { Statement: Array<{ Action: string; Resource: unknown }> };
          };
        }
      >;
      const statements = Object.values(policies)
        .filter((p) => p.Properties.Roles.some((r) => r.Ref?.startsWith('RealtimeAuthorizer')))
        .flatMap((p) => p.Properties.PolicyDocument.Statement);
      expect(statements.map((s) => s.Action).toSorted()).toEqual(['kms:Decrypt', 'ssm:GetParameter']);
      const ssm = statements.find((s) => s.Action === 'ssm:GetParameter');
      expect(JSON.stringify(ssm?.Resource)).toContain(':parameter/platform/apps/*/*/stage-key');
    });

    it('bounds stage roles to publishing in stage namespaces', () => {
      template.hasResourceProperties('AWS::IAM::ManagedPolicy', {
        ManagedPolicyName: platformNames.boundaryPolicy,
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({ Sid: 'StageRealtime', Action: 'appsync:EventPublish' }),
          ]),
        }),
      });
    });
  });

  describe('email', () => {
    const identity = () => logicalId('AWS::SES::EmailIdentity', { EmailIdentity: mailDomain });
    const zone = () => logicalId('AWS::Route53::HostedZone', { Name: `${config.zone}.` });
    const records = (type: string) =>
      Object.values(template.findResources('AWS::Route53::RecordSet', { Properties: { Type: type } })).map(
        (r) => r.Properties as { Name: unknown; ResourceRecords: unknown[]; HostedZoneId: unknown },
      );

    it('verifies mail.<zone> with 2048-bit Easy DKIM and its own MAIL FROM domain', () => {
      template.resourceCountIs('AWS::SES::EmailIdentity', 1);
      template.hasResourceProperties('AWS::SES::EmailIdentity', {
        EmailIdentity: 'mail.platform.ericminassian.com',
        DkimSigningAttributes: { NextSigningKeyLength: 'RSA_2048_BIT' },
        MailFromAttributes: {
          MailFromDomain: emailMailFromDomain(mailDomain),
          BehaviorOnMxFailure: 'USE_DEFAULT_VALUE',
        },
        Tags: Match.arrayWith([{ Key: 'platform:component', Value: 'email' }]),
      });
    });

    it('publishes its DKIM, MAIL FROM and DMARC records in the platform zone, not at its apex', () => {
      const dkim = records('CNAME');
      expect(dkim.map((r) => r.Name)).toEqual(
        [1, 2, 3].map((n) => ({ 'Fn::GetAtt': [identity(), `DkimDNSTokenName${n}`] })),
      );
      expect(dkim.map((r) => r.ResourceRecords)).toEqual(
        [1, 2, 3].map((n) => [{ 'Fn::GetAtt': [identity(), `DkimDNSTokenValue${n}`] }]),
      );
      for (const r of dkim) expect(r.HostedZoneId).toEqual({ Ref: zone() });
      const bounce = `${emailMailFromDomain(mailDomain)}.`;
      expect(records('MX')).toEqual([
        expect.objectContaining({
          Name: bounce,
          ResourceRecords: [`10 feedback-smtp.${config.region}.amazonses.com`],
          HostedZoneId: { Ref: zone() },
        }),
      ]);
      const txt = Object.fromEntries(records('TXT').map((r) => [r.Name as string, r.ResourceRecords]));
      expect(txt).toEqual({
        [bounce]: ['"v=spf1 include:amazonses.com ~all"'],
        [`_dmarc.${mailDomain}.`]: ['"v=DMARC1; p=quarantine; adkim=r; aspf=r"'],
      });
    });

    it('bounds stage roles to sending as a stage tenant and counting their own sends', () => {
      template.hasResourceProperties('AWS::IAM::ManagedPolicy', {
        ManagedPolicyName: platformNames.boundaryPolicy,
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Sid: 'StageEmail',
              Action: 'ses:SendEmail',
              Condition: { StringLike: { 'ses:TenantName': '*--*' } },
            }),
            Match.objectLike({
              Sid: 'StageEmailUsage',
              Action: 'dynamodb:UpdateItem',
              Condition: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['mail#*#*'] } },
            }),
          ]),
        }),
      });
    });

    it('lets the control plane manage stage tenants and associate them with the domain', () => {
      template.hasResourceProperties('AWS::IAM::Role', {
        RoleName: platformNames.controlPlaneRole,
        Policies: [
          {
            PolicyName: 'control',
            PolicyDocument: Match.objectLike({
              Statement: Match.arrayWith([
                Match.objectLike({ Sid: 'Email', Action: Match.arrayWith(['ses:CreateTenant']) }),
                Match.objectLike({
                  Sid: 'EmailDomain',
                  Action: ['ses:CreateTenantResourceAssociation', 'ses:DeleteTenantResourceAssociation'],
                }),
              ]),
            }),
          },
        ],
      });
    });

    it('sends sign-up mail from login@ the mail domain through SES', () => {
      const [pool] = Object.values(template.findResources('AWS::Cognito::UserPool')) as Array<{
        Properties: { EmailConfiguration?: unknown };
        DependsOn?: string[];
      }>;
      expect(pool!.Properties.EmailConfiguration).toEqual({
        EmailSendingAccount: 'DEVELOPER',
        From: `"${config.domain}" <login@${mailDomain}>`,
        SourceArn: `arn:aws:ses:${config.region}:${account}:identity/${mailDomain}`,
      });
      // The ARN is a literal, so only this makes the identity come first.
      expect(pool!.DependsOn).toEqual(Object.keys(template.findResources('AWS::SES::EmailIdentity')));
    });
  });

  it('retains everything that holds data or routes traffic', () => {
    const retained = [
      logicalId('AWS::Route53::HostedZone', { Name: `${config.zone}.` }),
      ...Object.keys(template.findResources('AWS::S3::Bucket')),
      ...Object.keys(template.findResources('AWS::DynamoDB::Table')),
      ...Object.keys(template.findResources('AWS::CloudFront::KeyValueStore')),
      ...Object.keys(template.findResources('AWS::Cognito::UserPool')),
      ...Object.keys(template.findResources('Custom::CrossAccountZoneDelegation')),
      ...Object.keys(template.findResources('AWS::AppSync::Api')),
      ...Object.keys(template.findResources('AWS::SES::EmailIdentity')),
    ];
    const resources = template.toJSON().Resources as Record<string, { DeletionPolicy?: string }>;
    expect(retained).toHaveLength(11);
    for (const id of retained) expect(resources[id]?.DeletionPolicy, id).toBe('Retain');
  });

  it('delegates the zone through the role the parent zone account grants', () => {
    template.hasResourceProperties('Custom::CrossAccountZoneDelegation', {
      AssumeRoleArn: delegationRole,
      ParentZoneName: config.domain,
      DelegatedZoneName: config.zone,
      TTL: 172800,
    });
  });

  it('routes every app host through one distribution and the router function', () => {
    const router = logicalId('AWS::CloudFront::Function', { Name: routerFunctionName() });
    template.resourceCountIs('AWS::CloudFront::Distribution', 1);
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        // The apex too, which `hosts` redirects.
        Aliases: [`*.${config.domain}`, config.domain],
        DefaultCacheBehavior: Match.objectLike({
          TargetOriginId: 'sites',
          // Managed-AllViewerExceptHostHeader: Web Function origins reject a forwarded Host.
          OriginRequestPolicyId: 'b689b0a8-53d0-40ab-baf2-68738e2966ac',
          FunctionAssociations: [
            { EventType: 'viewer-request', FunctionARN: { 'Fn::GetAtt': [router, 'FunctionARN'] } },
          ],
        }),
        Origins: Match.arrayWith([
          Match.objectLike({ Id: 'sites', OriginAccessControlId: Match.anyValue() }),
        ]),
      }),
    });
  });

  it('holds the not-found origin static requests fail over to, which reads only 404 pages', () => {
    const router = logicalId('AWS::CloudFront::Function', { Name: routerFunctionName() });
    const notFound = logicalId('AWS::Lambda::Function', { FunctionName: platformNames.notFoundFunction });
    const sites = logicalId('AWS::S3::Bucket', {
      BucketName: platformNames.sitesBucket(account, config.region),
    });
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        // The router handles its path like any other; the behavior only puts the origin there.
        CacheBehaviors: Match.arrayWith([
          Match.objectLike({
            PathPattern: NOT_FOUND_PATH,
            TargetOriginId: 'not-found',
            OriginRequestPolicyId: 'b689b0a8-53d0-40ab-baf2-68738e2966ac',
            FunctionAssociations: [
              { EventType: 'viewer-request', FunctionARN: { 'Fn::GetAtt': [router, 'FunctionARN'] } },
            ],
          }),
        ]),
        Origins: Match.arrayWith([
          Match.objectLike({ Id: 'not-found', OriginAccessControlId: Match.anyValue() }),
        ]),
      }),
    });
    const url = logicalId('AWS::Lambda::Url', {
      TargetFunctionArn: { 'Fn::GetAtt': [notFound, 'Arn'] },
      AuthType: 'AWS_IAM',
    });
    // CloudFront calls it through the URL, and only this distribution may.
    for (const action of ['lambda:InvokeFunctionUrl', 'lambda:InvokeFunction'])
      template.hasResourceProperties('AWS::Lambda::Permission', {
        Action: action,
        Principal: 'cloudfront.amazonaws.com',
        FunctionName: { 'Fn::GetAtt': [url, 'FunctionArn'] },
      });
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: [
          {
            Effect: 'Allow',
            Action: 's3:GetObject',
            Resource: { 'Fn::Join': ['', [{ 'Fn::GetAtt': [sites, 'Arn'] }, '/*/404.html']] },
          },
        ],
      },
    });
  });

  it('names the router after its code, so new code arrives with the origins it needs', () => {
    expect(routerFunctionName()).toMatch(/^platform-router-[0-9a-f]{10}$/);
    expect(routerFunctionName()).toBe(routerFunctionName());
  });

  it('puts the apex on the certificate and the distribution only when `hosts` names it', () => {
    template.hasResourceProperties('AWS::CertificateManager::Certificate', {
      DomainName: `*.${config.domain}`,
      SubjectAlternativeNames: [config.domain],
    });
    const { [config.domain]: _apex, ...rest } = config.hosts ?? {};
    const without = synth({ config: { ...config, hosts: rest } });
    without.hasResourceProperties('AWS::CertificateManager::Certificate', {
      DomainName: `*.${config.domain}`,
      SubjectAlternativeNames: Match.absent(),
    });
    without.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({ Aliases: [`*.${config.domain}`] }),
    });
  });

  it('serves public stores from the storage bucket’s public root, and only there', () => {
    const router = logicalId('AWS::CloudFront::Function', { Name: routerFunctionName() });
    const storage = logicalId('AWS::S3::Bucket', {
      BucketName: platformNames.storageBucket(account, config.region),
    });
    const headers = logicalId('AWS::CloudFront::ResponseHeadersPolicy', {
      ResponseHeadersPolicyConfig: Match.objectLike({ Name: 'platform-storage' }),
    });
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        CacheBehaviors: Match.arrayWith([
          Match.objectLike({
            PathPattern: '/__platform/storage/*',
            TargetOriginId: 'storage',
            AllowedMethods: ['GET', 'HEAD'],
            Compress: true,
            ResponseHeadersPolicyId: { Ref: headers },
            OriginRequestPolicyId: Match.absent(),
            FunctionAssociations: [
              { EventType: 'viewer-request', FunctionARN: { 'Fn::GetAtt': [router, 'FunctionARN'] } },
            ],
          }),
        ]),
        Origins: Match.arrayWith([
          Match.objectLike({
            Id: 'storage',
            DomainName: { 'Fn::GetAtt': [storage, 'RegionalDomainName'] },
            OriginPath: '/_public',
            OriginAccessControlId: Match.anyValue(),
            S3OriginConfig: { OriginAccessIdentity: '' },
          }),
        ]),
      }),
    });
    template.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
      ResponseHeadersPolicyConfig: Match.objectLike({
        SecurityHeadersConfig: {
          ContentTypeOptions: { Override: true },
          ContentSecurityPolicy: { ContentSecurityPolicy: "script-src 'none'", Override: true },
        },
        CustomHeadersConfig: { Items: [{ Header: 'Cache-Control', Value: 'no-cache', Override: false }] },
      }),
    });

    // The distribution reads the public root, and lists only it, so a missing file is a 404.
    const policy = Object.values(
      template.findResources('AWS::S3::BucketPolicy', { Properties: { Bucket: { Ref: storage } } }),
    );
    expect(policy).toHaveLength(1);
    const statements = (
      policy[0] as { Properties: { PolicyDocument: { Statement: Array<Record<string, unknown>> } } }
    ).Properties.PolicyDocument.Statement;
    const edge = statements.filter(
      (st) => (st.Principal as { Service?: string } | undefined)?.Service === 'cloudfront.amazonaws.com',
    );
    expect(edge.map((st) => [st.Action, st.Resource])).toEqual([
      ['s3:GetObject', { 'Fn::Join': ['', [{ 'Fn::GetAtt': [storage, 'Arn'] }, '/_public/*']] }],
      ['s3:ListBucket', { 'Fn::GetAtt': [storage, 'Arn'] }],
    ]);
    for (const st of edge)
      expect(Object.keys((st.Condition as { StringEquals: object }).StringEquals)).toEqual(['AWS:SourceArn']);
    expect(edge[1]?.Condition).toMatchObject({ StringLike: { 's3:prefix': ['_public/*'] } });
  });

  it('delivers the router’s access log to the telemetry processor’s log group', () => {
    const distribution = logicalId('AWS::CloudFront::Distribution', {});
    const group = logicalId('AWS::Logs::LogGroup', { LogGroupName: platformNames.edgeLogGroup });
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: platformNames.edgeLogGroup,
      RetentionInDays: 1,
    });
    template.hasResourceProperties('AWS::Logs::DeliverySource', {
      Name: platformNames.edgeLogDelivery,
      LogType: 'ACCESS_LOGS',
      ResourceArn: Match.objectLike({
        'Fn::Join': Match.arrayWith([Match.arrayWith([{ Ref: distribution }])]),
      }),
    });
    const destination = logicalId('AWS::Logs::DeliveryDestination', {
      Name: platformNames.edgeLogDelivery,
      DeliveryDestinationType: 'CWL',
      DestinationResourceArn: { 'Fn::GetAtt': [group, 'Arn'] },
      OutputFormat: 'json',
    });
    // The fields the processor reads, and never the client's address.
    template.hasResourceProperties('AWS::Logs::Delivery', {
      DeliverySourceName: platformNames.edgeLogDelivery,
      DeliveryDestinationArn: { 'Fn::GetAtt': [destination, 'Arn'] },
      RecordFields: [...EDGE_LOG_FIELDS],
    });
    expect(EDGE_LOG_FIELDS).not.toContain('c-ip');
    const policy = template.findResources('AWS::Logs::ResourcePolicy', {
      Properties: { PolicyName: platformNames.edgeLogDelivery },
    });
    expect(JSON.stringify(policy)).toContain('delivery.logs.amazonaws.com');
    expect(JSON.stringify(policy)).toContain(`{"Fn::GetAtt":["${group}","Arn"]},":log-stream:*`);
  });

  describe('edge floor', () => {
    const distribution = () => logicalId('AWS::CloudFront::Distribution', {});
    const worker = `arn:aws:lambda:${config.region}:${account}:function:platform--prod--worker`;

    it('leaves the web ACL to the control plane, which attaches it only while the floor is on', () => {
      template.resourceCountIs('AWS::WAFv2::WebACL', 0);
      template.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: Match.objectLike({ WebACLId: Match.absent() }),
      });
    });

    it('goes off when the router serves edgeFloorAt requests in a minute', () => {
      expect(config.limits.edgeFloorAt).toBe(1000);
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: platformNames.edgeFloorAlarm,
        Namespace: 'AWS/CloudFront',
        MetricName: 'Requests',
        Dimensions: Match.arrayWith([
          { Name: 'DistributionId', Value: { Ref: distribution() } },
          { Name: 'Region', Value: 'Global' },
        ]),
        Statistic: 'Sum',
        Period: 60,
        Threshold: 1000,
        ComparisonOperator: 'GreaterThanOrEqualToThreshold',
        EvaluationPeriods: 1,
        DatapointsToAlarm: 1,
        TreatMissingData: 'notBreaching',
        // State changes reach EventBridge without an action.
        AlarmActions: Match.absent(),
      });
    });

    it('runs the control plane worker’s edge-floor job when it goes off', () => {
      const alarm = logicalId('AWS::CloudWatch::Alarm', { AlarmName: platformNames.edgeFloorAlarm });
      template.hasResourceProperties('AWS::Events::Rule', {
        Name: platformNames.edgeFloorAlarm,
        EventPattern: {
          source: ['aws.cloudwatch'],
          'detail-type': ['CloudWatch Alarm State Change'],
          resources: [{ 'Fn::GetAtt': [alarm, 'Arn'] }],
          detail: { state: { value: ['ALARM'] } },
        },
        Targets: [
          Match.objectLike({
            Arn: worker,
            Input: JSON.stringify({ __platform: 'invoke', name: EDGE_FLOOR_JOB, payload: {} }),
            RetryPolicy: { MaximumEventAgeInSeconds: 900 },
          }),
        ],
      });
      // The worker is deployed after this stack, which grants it nothing (src/deploy.ts does).
      expect(
        template.findResources('AWS::Lambda::Permission', {
          Properties: { Principal: 'events.amazonaws.com' },
        }),
      ).toEqual({});
    });

    it('lets the control plane run the web ACL on the router, and names the alarm in the runtime config', () => {
      const policy = template.findResources('AWS::IAM::Role', {
        Properties: { RoleName: platformNames.controlPlaneRole },
      });
      const statements = (
        Object.values(policy)[0] as {
          Properties: { Policies: Array<{ PolicyDocument: { Statement: Array<Record<string, unknown>> } }> };
        }
      ).Properties.Policies[0]!.PolicyDocument.Statement;
      expect(statements.find((st) => st.Sid === 'EdgeFloorDistribution')).toEqual({
        Sid: 'EdgeFloorDistribution',
        Effect: 'Allow',
        Action: ['cloudfront:GetDistributionConfig', 'cloudfront:UpdateDistribution'],
        Resource: {
          'Fn::Join': ['', [`arn:aws:cloudfront::${account}:distribution/`, { Ref: distribution() }]],
        },
      });
      const runtime = JSON.stringify(
        template.findResources('AWS::SSM::Parameter', {
          Properties: { Name: platformNames.runtimeConfigParameter },
        }),
      );
      const alarm = logicalId('AWS::CloudWatch::Alarm', { AlarmName: platformNames.edgeFloorAlarm });
      const rule = logicalId('AWS::Events::Rule', { Name: platformNames.edgeFloorAlarm });
      expect(runtime).toContain('"edgeFloor\\":{\\"alarmArn\\":\\"');
      expect(runtime).toContain(`{"Fn::GetAtt":["${alarm}","Arn"]}`);
      expect(runtime).toContain(`{"Fn::GetAtt":["${rule}","Arn"]}`);
      expect(runtime).not.toContain('edgeWebAclArn');
    });

    it('has no alarm or trigger without the setting, and still lets a floor left on be taken down', () => {
      const { edgeRequestsPerMinute: _, edgeFloorAt: __, ...limits } = config.limits;
      const bare = synth({ config: { ...config, limits } });
      bare.resourceCountIs('AWS::CloudWatch::Alarm', 0);
      bare.resourceCountIs('AWS::Events::Rule', 0);
      expect(JSON.stringify(bare.toJSON())).not.toContain('"edgeFloor\\"');
      bare.hasResourceProperties('AWS::IAM::Role', {
        RoleName: platformNames.controlPlaneRole,
        Policies: [
          Match.objectLike({
            PolicyDocument: Match.objectLike({
              Statement: Match.arrayWith([Match.objectLike({ Sid: 'EdgeFloorWebAcl' })]),
            }),
          }),
        ],
      });
    });
  });

  it('keys the router cache on the platform host header', () => {
    template.hasResourceProperties('AWS::CloudFront::CachePolicy', {
      CachePolicyConfig: Match.objectLike({
        Name: 'platform-default',
        DefaultTTL: 0,
        ParametersInCacheKeyAndForwardedToOrigin: Match.objectLike({
          HeadersConfig: { HeaderBehavior: 'whitelist', Headers: ['x-platform-host', 'authorization'] },
        }),
      }),
    });
  });

  it('aliases the edge, console and login hosts', () => {
    for (const host of [config.edgeHost, config.consoleHost, config.loginHost])
      for (const Type of ['A', 'AAAA'])
        template.hasResourceProperties('AWS::Route53::RecordSet', { Name: `${host}.`, Type });
  });

  it('pins CI trust to the main branch of the platform repo, in both OIDC subject formats', () => {
    const { owner, repo, ownerId, repoId } = config.github;
    template.hasResourceProperties('AWS::IAM::Role', {
      RoleName: platformNames.ciRole,
      AssumeRolePolicyDocument: {
        Statement: [
          Match.objectLike({
            Action: 'sts:AssumeRoleWithWebIdentity',
            Condition: {
              StringEquals: {
                'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
                'token.actions.githubusercontent.com:sub': [
                  `repo:${owner}/${repo}:ref:refs/heads/main`,
                  `repo:${owner}@${ownerId}/${repo}@${repoId}:ref:refs/heads/main`,
                ],
              },
            },
          }),
        ],
      },
    });
  });

  it('lets the control plane publish alerts', () => {
    const topic = logicalId('AWS::SNS::Topic', { TopicName: platformNames.alertsTopic });
    template.hasResourceProperties('AWS::IAM::Role', {
      RoleName: platformNames.controlPlaneRole,
      Policies: [
        {
          PolicyName: 'control',
          PolicyDocument: Match.objectLike({
            Statement: Match.arrayWith([
              { Sid: 'Alerts', Effect: 'Allow', Action: 'sns:Publish', Resource: { Ref: topic } },
            ]),
          }),
        },
      ],
    });
  });

  it('publishes the runtime config, including the control plane worker deployed after it', () => {
    const id = logicalId('AWS::SSM::Parameter', { Name: platformNames.runtimeConfigParameter });
    const resources = template.toJSON().Resources as Record<
      string,
      { Properties: { Value: { 'Fn::Join': [string, unknown[]] } } }
    >;
    const value = resources[id]!.Properties.Value;
    const parts = value['Fn::Join'][1];
    const literal = parts.filter((p) => typeof p === 'string').join('');
    for (const key of ['artifactsBucket', 'kvsArn', 'distributionArn', 'userPoolId', 'boundaryPolicyArn'])
      expect(literal).toContain(`"${key}":"`);
    expect(literal).toContain('"realtime":{"apiId":"');
    const api = logicalId('AWS::AppSync::Api', { Name: platformNames.realtimeApi });
    for (const attr of ['ApiId', 'Dns.Http', 'Dns.Realtime'])
      expect(parts).toContainEqual({ 'Fn::GetAtt': [api, attr] });
    expect(literal).toContain(`"email":{"domain":"${mailDomain}","identityArn":"arn:`);
    expect(parts).toContainEqual({
      Ref: logicalId('AWS::SES::EmailIdentity', { EmailIdentity: mailDomain }),
    });
    expect(literal).toContain(
      `"telemetryFunctionArn":"arn:aws:lambda:${config.region}:${account}:function:platform--prod--worker"`,
    );
  });

  it('subscribes the alert email only when one is given', () => {
    template.hasResourceProperties('AWS::SNS::Subscription', {
      Protocol: 'email',
      Endpoint: 'alerts@example.com',
    });
    synth().resourceCountIs('AWS::SNS::Subscription', 0);
  });
});
