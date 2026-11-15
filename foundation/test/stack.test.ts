import { readFileSync } from 'node:fs';
import { platformNames } from '@ericminassian/platform-core';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import config from '../../platform.config.ts';
import { FOUNDATION_STACK, FoundationStack } from '../src/stack.ts';

const account = '123456789012';
const delegationRole = 'arn:aws:iam::210987654321:role/route53-delegation-platform-ericminassian-com';
// The feature flags `cdk synth` runs with, so the template matches a real deploy.
const { context } = JSON.parse(readFileSync(new URL('../cdk.json', import.meta.url), 'utf8'));

function synth(alertEmail?: string): Template {
  const stack = new FoundationStack(new App({ context }), FOUNDATION_STACK, {
    env: { account, region: config.region },
    config,
    dnsDelegationRoleArn: delegationRole,
    ...(alertEmail ? { alertEmail } : {}),
  });
  return Template.fromStack(stack);
}

const template = synth('alerts@example.com');

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
  });

  it('retains everything that holds data or routes traffic', () => {
    const retained = [
      logicalId('AWS::Route53::HostedZone', { Name: `${config.zone}.` }),
      ...Object.keys(template.findResources('AWS::S3::Bucket')),
      ...Object.keys(template.findResources('AWS::DynamoDB::Table')),
      ...Object.keys(template.findResources('AWS::CloudFront::KeyValueStore')),
      ...Object.keys(template.findResources('AWS::Cognito::UserPool')),
      ...Object.keys(template.findResources('Custom::CrossAccountZoneDelegation')),
    ];
    const resources = template.toJSON().Resources as Record<string, { DeletionPolicy?: string }>;
    expect(retained).toHaveLength(9);
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
        Origins: [Match.objectLike({ Id: 'sites', OriginAccessControlId: Match.anyValue() })],
      }),
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
    const value = template.toJSON().Resources[id].Properties.Value as { 'Fn::Join': [string, unknown[]] };
    const parts = value['Fn::Join'][1];
    const literal = parts.filter((p) => typeof p === 'string').join('');
    for (const key of ['artifactsBucket', 'kvsArn', 'distributionArn', 'userPoolId', 'boundaryPolicyArn'])
      expect(literal).toContain(`"${key}":"`);
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
