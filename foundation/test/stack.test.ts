import { readFileSync } from 'node:fs';
import {
  EDGE_RATE_LIMITED_BODY,
  emailDomain,
  emailMailFromDomain,
  type PlatformConfig,
  platformNames,
  REALTIME_TOKEN_PATTERN,
} from '@ericminassian/platform-core';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import config from '../../platform.config.ts';
import { FOUNDATION_STACK, FoundationStack, type FoundationStackProps } from '../src/stack.ts';

const account = '123456789012';
const delegationRole = 'arn:aws:iam::210987654321:role/route53-delegation-platform-ericminassian-com';
// The feature flags `cdk synth` runs with, so the template matches a real deploy.
const { context } = JSON.parse(readFileSync(new URL('../cdk.json', import.meta.url), 'utf8')) as {
  context: Record<string, unknown>;
};

function synth(
  opts: {
    alertEmail?: string;
    userPoolEmail?: FoundationStackProps['userPoolEmail'];
    config?: PlatformConfig;
  } = {},
): Template {
  const stack = new FoundationStack(new App({ context }), FOUNDATION_STACK, {
    env: { account, region: config.region },
    config: opts.config ?? config,
    dnsDelegationRoleArn: delegationRole,
    ...(opts.alertEmail ? { alertEmail: opts.alertEmail } : {}),
    userPoolEmail: opts.userPoolEmail ?? 'cognito',
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
    template.hasResourceProperties('AWS::CloudFront::Function', { Name: platformNames.routerFunction });
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
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: platformNames.realtimeAuthorizer,
    });
    template.hasResourceProperties('AWS::SES::EmailIdentity', { EmailIdentity: mailDomain });
    template.hasResourceProperties('AWS::ECS::Cluster', { ClusterName: platformNames.containerCluster });
    template.hasResourceProperties('AWS::ECR::Repository', {
      RepositoryName: platformNames.containerRepository,
    });
    template.hasResourceProperties('AWS::EC2::VPC', {
      Tags: Match.arrayWith([{ Key: 'Name', Value: platformNames.containerNetwork }]),
    });
    template.hasResourceProperties('AWS::EC2::SecurityGroup', { GroupName: platformNames.containerNetwork });
    for (const role of [platformNames.containerExecutionRole, platformNames.containerSchedulerRole])
      template.hasResourceProperties('AWS::IAM::Role', { RoleName: role, Path: '/platform/' });
  });

  describe('containers', () => {
    const cluster = () => logicalId('AWS::ECS::Cluster', { ClusterName: platformNames.containerCluster });
    const repository = () =>
      logicalId('AWS::ECR::Repository', { RepositoryName: platformNames.containerRepository });

    it('runs them in public subnets across three zones, with no NAT gateway or flow logs', () => {
      template.resourceCountIs('AWS::EC2::VPC', 1);
      template.resourceCountIs('AWS::EC2::Subnet', 3);
      for (const zone of [0, 1, 2])
        template.hasResourceProperties('AWS::EC2::Subnet', {
          AvailabilityZone: { 'Fn::Select': [zone, { 'Fn::GetAZs': '' }] },
          MapPublicIpOnLaunch: true,
        });
      template.resourceCountIs('AWS::EC2::InternetGateway', 1);
      template.resourceCountIs('AWS::EC2::Route', 3);
      template.allResourcesProperties('AWS::EC2::Route', {
        DestinationCidrBlock: '0.0.0.0/0',
        GatewayId: { Ref: Match.stringLikeRegexp('^ContainerNetworkIGW') },
      });
      template.resourceCountIs('AWS::EC2::NatGateway', 0);
      template.resourceCountIs('AWS::EC2::EIP', 0);
      template.resourceCountIs('AWS::EC2::FlowLog', 0);
      // Leaving the default security group alone avoids CDK's custom-resource Lambda.
      template.resourceCountIs('Custom::VpcRestrictDefaultSG', 0);
    });

    it('reaches S3 and DynamoDB through free gateway endpoints only', () => {
      const endpoints = Object.values(
        template.findResources('AWS::EC2::VPCEndpoint') as Record<
          string,
          { Properties: { VpcEndpointType: string; ServiceName: { 'Fn::Join': [string, unknown[]] } } }
        >,
      );
      expect(endpoints.map((e) => e.Properties.VpcEndpointType)).toEqual(['Gateway', 'Gateway']);
      const services = endpoints.map((e) => String(e.Properties.ServiceName['Fn::Join'][1].at(-1)));
      expect(services.toSorted((a, b) => a.localeCompare(b))).toEqual(['.dynamodb', '.s3']);
    });

    it('takes no inbound traffic', () => {
      template.hasResourceProperties('AWS::EC2::SecurityGroup', {
        GroupName: platformNames.containerNetwork,
        SecurityGroupEgress: [Match.objectLike({ CidrIp: '0.0.0.0/0', IpProtocol: '-1' })],
        SecurityGroupIngress: Match.absent(),
      });
      template.resourceCountIs('AWS::EC2::SecurityGroupIngress', 0);
    });

    it('runs Fargate and Fargate Spot tasks without Container Insights', () => {
      template.hasResourceProperties('AWS::ECS::Cluster', {
        ClusterName: platformNames.containerCluster,
        ClusterSettings: [{ Name: 'containerInsights', Value: 'disabled' }],
      });
      template.hasResourceProperties('AWS::ECS::ClusterCapacityProviderAssociations', {
        Cluster: { Ref: cluster() },
        CapacityProviders: ['FARGATE', 'FARGATE_SPOT'],
      });
    });

    it('scans pushed images and expires only untagged ones', () => {
      const resources = template.toJSON().Resources as Record<
        string,
        {
          Properties: {
            ImageScanningConfiguration: unknown;
            LifecyclePolicy: { LifecyclePolicyText: string };
          };
        }
      >;
      const repo = resources[repository()]!.Properties;
      expect(repo.ImageScanningConfiguration).toEqual({ ScanOnPush: true });
      expect(JSON.parse(repo.LifecyclePolicy.LifecyclePolicyText)).toEqual({
        rules: [
          {
            rulePriority: 1,
            description: 'Expire untagged images after a day',
            selection: {
              tagStatus: 'untagged',
              countType: 'sinceImagePushed',
              countNumber: 1,
              countUnit: 'days',
            },
            action: { type: 'expire' },
          },
        ],
      });
    });

    it('lets ECS pull images and ship logs, and Scheduler only scale stage services', () => {
      template.hasResourceProperties('AWS::IAM::Role', {
        RoleName: platformNames.containerExecutionRole,
        AssumeRolePolicyDocument: {
          Statement: [
            Match.objectLike({ Action: 'sts:AssumeRole', Principal: { Service: 'ecs-tasks.amazonaws.com' } }),
          ],
        },
        Policies: [
          {
            PolicyName: 'execution',
            PolicyDocument: Match.objectLike({
              Statement: [
                Match.objectLike({ Sid: 'PullImages' }),
                Match.objectLike({ Sid: 'RegistryAuth' }),
                Match.objectLike({ Sid: 'ContainerLogs' }),
              ],
            }),
          },
        ],
      });
      template.hasResourceProperties('AWS::IAM::Role', {
        RoleName: platformNames.containerSchedulerRole,
        AssumeRolePolicyDocument: {
          Statement: [
            Match.objectLike({
              Action: 'sts:AssumeRole',
              Principal: { Service: 'scheduler.amazonaws.com' },
              Condition: { StringEquals: { 'aws:SourceAccount': account } },
            }),
          ],
        },
        Policies: [
          {
            PolicyName: 'scheduler',
            PolicyDocument: Match.objectLike({
              Statement: [Match.objectLike({ Sid: 'ScaleStageServices', Action: 'ecs:UpdateService' })],
            }),
          },
        ],
      });
    });

    it('lets the control plane run services and pass both roles', () => {
      template.hasResourceProperties('AWS::IAM::Role', {
        RoleName: platformNames.controlPlaneRole,
        Policies: [
          {
            PolicyName: 'control',
            PolicyDocument: Match.objectLike({
              Statement: Match.arrayWith([
                Match.objectLike({ Sid: 'ContainerServices' }),
                Match.objectLike({ Sid: 'ContainerImages' }),
                Match.objectLike({
                  Sid: 'ContainerRoles',
                  Action: 'iam:PassRole',
                  Resource: [
                    {
                      'Fn::GetAtt': [
                        logicalId('AWS::IAM::Role', { RoleName: platformNames.containerExecutionRole }),
                        'Arn',
                      ],
                    },
                    {
                      'Fn::GetAtt': [
                        logicalId('AWS::IAM::Role', { RoleName: platformNames.containerSchedulerRole }),
                        'Arn',
                      ],
                    },
                  ],
                }),
              ]),
            }),
          },
        ],
      });
    });
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

    /** The template's one user pool, as far as these tests read it. */
    const userPools = (t: Template) =>
      t.findResources('AWS::Cognito::UserPool') as Record<
        string,
        { Properties: { EmailConfiguration?: unknown }; DependsOn?: string[] }
      >;

    it("keeps Cognito's sender until SES can deliver to anyone", () => {
      const pool = Object.values(userPools(template))[0]!;
      expect(pool.Properties.EmailConfiguration).toBeUndefined();
      expect(pool.DependsOn).toBeUndefined();
    });

    it('then sends sign-up mail from login@ the mail domain through SES', () => {
      const ses = synth({ userPoolEmail: 'ses' });
      const [id, pool] = Object.entries(userPools(ses))[0]!;
      expect(pool.Properties.EmailConfiguration).toEqual({
        EmailSendingAccount: 'DEVELOPER',
        From: `"${config.domain}" <login@${mailDomain}>`,
        SourceArn: `arn:aws:ses:${config.region}:${account}:identity/${mailDomain}`,
      });
      // The ARN is a literal, so only this makes the identity come first.
      const identityId = Object.keys(ses.findResources('AWS::SES::EmailIdentity'))[0];
      expect(pool.DependsOn).toEqual([identityId]);
      // The same pool either way: switching updates it in place.
      expect(id).toBe(Object.keys(template.findResources('AWS::Cognito::UserPool'))[0]);
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
      ...Object.keys(template.findResources('AWS::ECR::Repository')),
    ];
    const resources = template.toJSON().Resources as Record<string, { DeletionPolicy?: string }>;
    expect(retained).toHaveLength(12);
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
    const router = logicalId('AWS::CloudFront::Function', { Name: platformNames.routerFunction });
    template.resourceCountIs('AWS::CloudFront::Distribution', 1);
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        Aliases: [`*.${config.domain}`],
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

  it('serves public stores from the storage bucket’s public root, and only there', () => {
    const router = logicalId('AWS::CloudFront::Function', { Name: platformNames.routerFunction });
    const storage = logicalId('AWS::S3::Bucket', {
      BucketName: platformNames.storageBucket(account, config.region),
    });
    const headers = logicalId('AWS::CloudFront::ResponseHeadersPolicy', {
      ResponseHeadersPolicyConfig: Match.objectLike({ Name: 'platform-storage' }),
    });
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        CacheBehaviors: [
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
        ],
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

  describe('edge floor', () => {
    const acl = () => logicalId('AWS::WAFv2::WebACL', { Name: platformNames.edgeWebAcl });

    it('answers a client over the limit for one host with a RateLimited 429', () => {
      expect(config.limits.edgeRequestsPerMinute).toBe(1000);
      template.hasResourceProperties('AWS::WAFv2::WebACL', {
        Name: platformNames.edgeWebAcl,
        Scope: 'CLOUDFRONT',
        DefaultAction: { Allow: {} },
        CustomResponseBodies: {
          'rate-limited': {
            ContentType: 'APPLICATION_JSON',
            Content: JSON.stringify(EDGE_RATE_LIMITED_BODY),
          },
        },
        Rules: [
          {
            Name: platformNames.edgeFloorRule,
            Priority: 0,
            Statement: {
              RateBasedStatement: {
                Limit: 1000,
                EvaluationWindowSec: 60,
                AggregateKeyType: 'CUSTOM_KEYS',
                CustomKeys: [
                  { IP: {} },
                  { Header: { Name: 'host', TextTransformations: [{ Priority: 0, Type: 'LOWERCASE' }] } },
                ],
              },
            },
            Action: {
              Block: {
                CustomResponse: {
                  ResponseCode: 429,
                  CustomResponseBodyKey: 'rate-limited',
                  ResponseHeaders: [{ Name: 'retry-after', Value: '60' }],
                },
              },
            },
            VisibilityConfig: {
              CloudWatchMetricsEnabled: true,
              MetricName: platformNames.edgeFloorRule,
              SampledRequestsEnabled: true,
            },
          },
        ],
      });
      template.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: Match.objectLike({ WebACLId: { 'Fn::GetAtt': [acl(), 'Arn'] } }),
      });
    });

    it('lets the control plane read its samples, and names it in the runtime config', () => {
      template.hasResourceProperties('AWS::IAM::Role', {
        RoleName: platformNames.controlPlaneRole,
        Policies: [
          Match.objectLike({
            PolicyDocument: Match.objectLike({
              Statement: Match.arrayWith([
                {
                  Sid: 'EdgeFloor',
                  Effect: 'Allow',
                  Action: 'wafv2:GetSampledRequests',
                  Resource: { 'Fn::GetAtt': [acl(), 'Arn'] },
                },
              ]),
            }),
          }),
        ],
      });
      const runtime = JSON.stringify(
        template.findResources('AWS::SSM::Parameter', {
          Properties: { Name: platformNames.runtimeConfigParameter },
        }),
      );
      expect(runtime).toContain('"edgeWebAclArn\\":\\"');
      expect(runtime).toContain(`{"Fn::GetAtt":["${acl()}","Arn"]}`);
    });

    it('has no web ACL without edgeRequestsPerMinute', () => {
      const { edgeRequestsPerMinute: _, ...limits } = config.limits;
      const bare = synth({ config: { ...config, limits } });
      bare.resourceCountIs('AWS::WAFv2::WebACL', 0);
      bare.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: Match.objectLike({ WebACLId: Match.absent() }),
      });
      expect(JSON.stringify(bare.toJSON())).not.toContain('edgeWebAclArn');
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
    expect(literal).toContain(`"containers":{"cluster":"`);
    for (const key of [
      'subnets',
      'securityGroups',
      'repository',
      'repositoryUri',
      'executionRoleArn',
      'schedulerRoleArn',
    ])
      expect(literal).toContain(`"${key}":`);
    const network = logicalId('AWS::EC2::SecurityGroup', { GroupName: platformNames.containerNetwork });
    expect(parts).toContainEqual({ 'Fn::GetAtt': [network, 'GroupId'] });
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
