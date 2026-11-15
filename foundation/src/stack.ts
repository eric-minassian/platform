import {
  HOST_HEADER,
  names,
  type PlatformConfig,
  type PlatformRuntimeConfig,
  PROD_STAGE,
  platformNames,
} from '@ericminassian/platform-core';
import { buildRouterFunctionCode } from '@ericminassian/platform-core/cloudfront-function';
import { platformTags, policies } from '@ericminassian/platform-engine';
import {
  ArnFormat,
  aws_certificatemanager as acm,
  CfnOutput,
  aws_cloudfront as cloudfront,
  aws_cognito as cognito,
  Duration,
  aws_dynamodb as dynamodb,
  aws_iam as iam,
  RemovalPolicy,
  aws_route53 as route53,
  Stack,
  type StackProps,
  aws_s3 as s3,
  aws_sns as sns,
  aws_ssm as ssm,
  Tags,
} from 'aws-cdk-lib';
import { S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { CloudFrontTarget, UserPoolDomainTarget } from 'aws-cdk-lib/aws-route53-targets';
import type { Construct, IConstruct } from 'constructs';

export const FOUNDATION_STACK = 'platform-foundation';
/** The control plane is deployed by the engine as an ordinary app, after this stack. */
export const CONTROL_PLANE_APP = 'platform';

export interface FoundationStackProps extends StackProps {
  config: PlatformConfig;
  /**
   * Role in the root zone's account that may UPSERT/DELETE only this zone's
   * NS record (github.com/eric-minassian/aws).
   */
  dnsDelegationRoleArn: string;
  /** Subscribed to the alerts topic. Unset means no subscription. */
  alertEmail?: string;
}

/**
 * The platform's shared resources. Everything per app or per stage is created
 * by the engine, never here, so this stack stays a small, fixed set.
 *
 * Resources keep the names in `platformNames` (core): the engine, the control
 * plane and `plat dev` address them by name, and the stack adopted resources
 * the engine had created under those names. The zone, buckets, tables, route
 * store and user pool hold state that can't be recreated, so they're retained
 * if they ever leave the stack.
 */
export class FoundationStack extends Stack {
  constructor(scope: Construct, id: string, props: FoundationStackProps) {
    super(scope, id, {
      description: 'Platform shared resources: DNS, certificates, edge router, buckets, tables, Cognito, IAM',
      terminationProtection: true,
      ...props,
    });
    const { config } = props;
    tag(this, 'foundation');

    // ---------------------------------------------------------------- DNS
    const zone = new route53.PublicHostedZone(this, 'Zone', {
      zoneName: config.zone,
      comment: `Platform zone, delegated from ${config.domain}`,
    });
    zone.applyRemovalPolicy(RemovalPolicy.RETAIN);
    tag(zone, 'dns');
    const delegation = new route53.CrossAccountZoneDelegationRecord(this, 'ZoneDelegation', {
      delegatedZone: zone,
      parentHostedZoneName: config.domain,
      delegationRole: iam.Role.fromRoleArn(this, 'ParentZoneDelegationRole', props.dnsDelegationRoleArn),
      ttl: Duration.days(2),
      removalPolicy: RemovalPolicy.RETAIN,
    });
    tag(delegation, 'dns');

    // ------------------------------------------------------- certificates
    // Cognito's managed login on login.<zone>; validated in the zone above.
    const zoneCertificate = new acm.Certificate(this, 'ZoneCertificate', {
      domainName: config.zone,
      subjectAlternativeNames: [`*.${config.zone}`],
      validation: acm.CertificateValidation.fromDns(zone),
    });
    tag(zoneCertificate, 'edge');
    // Every app host. Its validation CNAME lives in the root zone, which this
    // account can't write: on a first deploy the stack waits until the record
    // is added in github.com/eric-minassian/aws (docs/SETUP.md).
    const edgeCertificate = new acm.Certificate(this, 'EdgeCertificate', {
      domainName: `*.${config.domain}`,
      validation: acm.CertificateValidation.fromDns(),
    });
    tag(edgeCertificate, 'edge');

    // ------------------------------------------------------------ buckets
    const artifacts = new s3.Bucket(this, 'ArtifactsBucket', {
      bucketName: platformNames.artifactsBucket(this.account, this.region),
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      lifecycleRules: [
        {
          id: 'expire-old-artifacts',
          expiration: Duration.days(90),
          noncurrentVersionExpiration: Duration.days(30),
          abortIncompleteMultipartUploadAfter: Duration.days(2),
        },
      ],
      removalPolicy: RemovalPolicy.RETAIN,
    });
    // Lambda Web Functions fetch revision code with the Lambda service
    // principal (not the caller's credentials), so it needs read access to
    // build artifacts. Scoped to this account's functions.
    artifacts.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'LambdaWebFunctionCode',
        principals: [new iam.ServicePrincipal('lambda.amazonaws.com')],
        actions: ['s3:GetObject', 's3:GetObjectVersion'],
        resources: [artifacts.arnForObjects('*')],
        conditions: { StringEquals: { 'aws:SourceAccount': this.account } },
      }),
    );
    tag(artifacts, 'artifacts');

    // Static files of every deployment; only the router distribution reads it (OAC).
    const sites = new s3.Bucket(this, 'SitesBucket', {
      bucketName: platformNames.sitesBucket(this.account, this.region),
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    tag(sites, 'sites');

    // App file storage; browsers upload with presigned URLs from app hosts.
    const storage = new s3.Bucket(this, 'StorageBucket', {
      bucketName: platformNames.storageBucket(this.account, this.region),
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      cors: [
        {
          allowedOrigins: [`https://*.${config.domain}`],
          allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.PUT, s3.HttpMethods.POST, s3.HttpMethods.HEAD],
          allowedHeaders: ['*'],
          exposedHeaders: ['ETag'],
          maxAge: 3600,
        },
      ],
      lifecycleRules: [{ id: 'abort-multipart', abortIncompleteMultipartUploadAfter: Duration.days(2) }],
      removalPolicy: RemovalPolicy.RETAIN,
    });
    tag(storage, 'storage');

    // ------------------------------------------------------------- tables
    // Apps, stages and deployments (layout in services/control-plane/src/records.ts).
    const state = new dynamodb.Table(this, 'StateTable', {
      tableName: platformNames.stateTable,
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    state.addGlobalSecondaryIndex({
      indexName: 'gsi1',
      partitionKey: { name: 'gsi1pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'gsi1sk', type: dynamodb.AttributeType.STRING },
    });
    tag(state, 'state');

    // Telemetry rollups and error groups; rows expire through TTL.
    const telemetry = new dynamodb.Table(this, 'TelemetryTable', {
      tableName: platformNames.telemetryTable,
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: RemovalPolicy.RETAIN,
    });
    tag(telemetry, 'telemetry');

    // ---------------------------------------------------------- edge router
    // host → route record; deploys and rollbacks write it, so it holds live
    // routing state. (ASCII comment: `cdk diff` can't compare non-ASCII values.)
    const routes = new cloudfront.KeyValueStore(this, 'Routes', {
      keyValueStoreName: platformNames.keyValueStore,
      comment: 'host -> route records',
    });
    routes.applyRemovalPolicy(RemovalPolicy.RETAIN);
    const router = new cloudfront.Function(this, 'Router', {
      functionName: platformNames.routerFunction,
      comment: 'platform router',
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      keyValueStore: routes,
      code: cloudfront.FunctionCode.fromInline(buildRouterFunctionCode({ kvsId: routes.keyValueStoreId })),
      autoPublish: true,
    });
    const sitesAccess = new cloudfront.S3OriginAccessControl(this, 'SitesOriginAccess', {
      originAccessControlName: 'platform-sites',
      signing: cloudfront.Signing.SIGV4_ALWAYS,
    });
    // Origins decide caching; the platform host header keeps hosts' responses apart.
    const cachePolicy = new cloudfront.CachePolicy(this, 'RouterCachePolicy', {
      cachePolicyName: 'platform-default',
      comment: 'platform router: origin-controlled caching, per-host keys',
      minTtl: Duration.seconds(0),
      defaultTtl: Duration.seconds(0),
      maxTtl: Duration.days(365),
      headerBehavior: cloudfront.CacheHeaderBehavior.allowList(HOST_HEADER, 'authorization'),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    });
    // One distribution for every app. The router function serves static files
    // from the sites bucket or switches the origin to the stage's Web Function.
    const distribution = new cloudfront.Distribution(this, 'Edge', {
      comment: 'platform-edge',
      domainNames: [`*.${config.domain}`],
      certificate: edgeCertificate,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      enableIpv6: true,
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessControl(sites, {
          originId: 'sites',
          originAccessControl: sitesAccess,
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
        compress: true,
        cachePolicy,
        // Web Function origins reject a forwarded Host header.
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        functionAssociations: [{ function: router, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }],
      },
    });
    tag(distribution, 'edge');

    // `*.<domain>` in the root zone is a CNAME to the edge host; the console
    // is the zone apex.
    const edgeTarget = route53.RecordTarget.fromAlias(new CloudFrontTarget(distribution));
    const aliases = (id: string, recordName: string, target: route53.RecordTarget) => [
      new route53.ARecord(this, `${id}A`, { zone, recordName, target }),
      new route53.AaaaRecord(this, `${id}Aaaa`, { zone, recordName, target }),
    ];
    aliases('EdgeAlias', config.edgeHost, edgeTarget);
    const consoleAliases = aliases('ConsoleAlias', config.consoleHost, edgeTarget);

    // ------------------------------------------------------------ identity
    // App end users, shared by every app (SSO across apps). Apps get their
    // own clients, which the engine creates per stage.
    const users = new cognito.UserPool(this, 'Users', {
      userPoolName: platformNames.userPool,
      signInAliases: { email: true },
      autoVerify: { email: true },
      signInCaseSensitive: false,
      selfSignUpEnabled: true,
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      passwordPolicy: {
        minLength: 10,
        requireLowercase: false,
        requireUppercase: false,
        requireDigits: false,
        requireSymbols: false,
      },
      mfa: cognito.Mfa.OFF,
      featurePlan: cognito.FeaturePlan.ESSENTIALS,
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    tag(users, 'identity');
    const login = users.addDomain('Login', {
      customDomain: { domainName: config.loginHost, certificate: zoneCertificate },
      managedLoginVersion: cognito.ManagedLoginVersion.NEWER_MANAGED_LOGIN,
    });
    // Cognito accepts a custom domain only once its parent domain resolves.
    for (const record of consoleAliases) login.node.addDependency(record);
    aliases('LoginAlias', config.loginHost, route53.RecordTarget.fromAlias(new UserPoolDomainTarget(login)));

    // ---------------------------------------------------------------- alerts
    const alerts = new sns.Topic(this, 'Alerts', { topicName: platformNames.alertsTopic });
    // A fixed construct id: the default one would spell the address into the
    // logical id, which `cdk diff` prints in public workflow logs.
    if (props.alertEmail) {
      new sns.Subscription(this, 'AlertEmail', {
        topic: alerts,
        protocol: sns.SubscriptionProtocol.EMAIL,
        endpoint: props.alertEmail,
      });
    }
    tag(alerts, 'alerts');

    // ------------------------------------------------------------------- IAM
    const boundary = new iam.ManagedPolicy(this, 'AppBoundary', {
      managedPolicyName: platformNames.boundaryPolicy,
      path: '/platform/',
      description: 'Maximum permissions of any per-stage app role',
      document: iam.PolicyDocument.fromJson(
        policies.boundaryPolicy({
          region: this.region,
          accountId: this.account,
          storageBucket: storage.bucketName,
        }),
      ),
    });

    const controlPlaneRole = new iam.Role(this, 'ControlPlaneRole', {
      roleName: platformNames.controlPlaneRole,
      path: '/platform/',
      description: 'Platform control plane (API, deployer, telemetry)',
      assumedBy: new iam.CompositePrincipal(
        new iam.ServicePrincipal('lambda.amazonaws.com'),
        new iam.ServicePrincipal('scheduler.amazonaws.com'),
      ),
      inlinePolicies: {
        control: iam.PolicyDocument.fromJson(
          policies.controlPlanePolicy({
            region: this.region,
            accountId: this.account,
            runtime: {
              artifactsBucket: artifacts.bucketName,
              sitesBucket: sites.bucketName,
              storageBucket: storage.bucketName,
              kvsArn: routes.keyValueStoreArn,
              userPoolId: users.userPoolId,
              boundaryPolicyArn: boundary.managedPolicyArn,
              alertsTopicArn: alerts.topicArn,
            },
          }),
        ),
      },
    });
    tag(controlPlaneRole, 'control-plane');

    // deploy-platform.yml: GitHub Actions on main of this repo only. Both OIDC
    // subject formats: the legacy `repo:<owner>/<repo>:…` and GitHub's
    // immutable `repo:<owner>@<ownerId>/<repo>@<repoId>:…`, so CI keeps
    // working if the repo setting is toggled.
    const github = new iam.OidcProviderNative(this, 'GithubOidc', {
      url: 'https://token.actions.githubusercontent.com',
      clientIds: ['sts.amazonaws.com'],
      // IAM no longer checks thumbprints for GitHub's issuer, but the field is required.
      thumbprints: ['6938fd4d98bab03faadb97b34396831e3780aea1'],
    });
    const { owner, repo, ownerId, repoId } = config.github;
    const ciRole = new iam.Role(this, 'CiRole', {
      roleName: platformNames.ciRole,
      path: '/platform/',
      description: `GitHub Actions for ${owner}/${repo} (main)`,
      assumedBy: new iam.WebIdentityPrincipal(github.oidcProviderArn, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          'token.actions.githubusercontent.com:sub': [
            `repo:${owner}/${repo}:ref:refs/heads/main`,
            `repo:${owner}@${ownerId}/${repo}@${repoId}:ref:refs/heads/main`,
          ],
        },
      }),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AdministratorAccess')],
      maxSessionDuration: Duration.hours(1),
    });
    tag(ciRole, 'ci');

    // ------------------------------------------------------- runtime config
    // What every stage deploy needs, read by the control plane and the CLI.
    const runtime: PlatformRuntimeConfig = {
      v: 1,
      target: 'aws',
      accountId: this.account,
      region: this.region,
      domain: config.domain,
      publicScheme: 'https',
      artifactsBucket: artifacts.bucketName,
      sitesBucket: sites.bucketName,
      storageBucket: storage.bucketName,
      stateTable: state.tableName,
      telemetryTable: telemetry.tableName,
      boundaryPolicyArn: boundary.managedPolicyArn,
      kvsArn: routes.keyValueStoreArn,
      distributionArn: distribution.distributionArn,
      userPoolId: users.userPoolId,
      loginUrl: `https://${config.loginHost}`,
      alertsTopicArn: alerts.topicArn,
      // The control plane's worker, deployed after this stack; its name is fixed.
      telemetryFunctionArn: this.formatArn({
        service: 'lambda',
        resource: 'function',
        resourceName: names.workerFunction(CONTROL_PLANE_APP, PROD_STAGE),
        arnFormat: ArnFormat.COLON_RESOURCE_NAME,
      }),
    };
    new ssm.StringParameter(this, 'RuntimeConfig', {
      parameterName: platformNames.runtimeConfigParameter,
      description: 'Shared platform resources (the platform-foundation stack)',
      stringValue: this.toJsonString(runtime),
    });

    new CfnOutput(this, 'ControlPlaneRoleArn', { value: controlPlaneRole.roleArn });
    new CfnOutput(this, 'CiRoleArn', { value: ciRole.roleArn });
    new CfnOutput(this, 'DistributionDomainName', { value: distribution.distributionDomainName });
  }
}

/** `platform:managed` + `platform:component` on every taggable resource under `scope`. */
function tag(scope: IConstruct, component: string): void {
  for (const [key, value] of Object.entries(platformTags(component))) Tags.of(scope).add(key, value);
}
