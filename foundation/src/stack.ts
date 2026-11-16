import { fileURLToPath } from 'node:url';
import {
  EDGE_RATE_LIMITED_BODY,
  EDGE_RETRY_AFTER_SECONDS,
  EMAIL_LOGIN_LOCAL_PART,
  emailDomain,
  emailMailFromDomain,
  HOST_HEADER,
  names,
  PUBLIC_STORAGE_ROOT,
  type PlatformConfig,
  type PlatformRuntimeConfig,
  PROD_STAGE,
  platformNames,
  REALTIME_TOKEN_PATTERN,
  STORAGE_DEFAULT_CACHE_CONTROL,
  STORAGE_PATH,
  STORAGE_RESPONSE_HEADERS,
} from '@ericminassian/platform-core';
import { buildRouterFunctionCode } from '@ericminassian/platform-core/cloudfront-function';
import { platformTags, policies } from '@ericminassian/platform-engine';
import {
  ArnFormat,
  aws_certificatemanager as acm,
  aws_appsync as appsync,
  CfnOutput,
  aws_cloudfront as cloudfront,
  aws_cognito as cognito,
  Duration,
  aws_dynamodb as dynamodb,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_logs as logs,
  RemovalPolicy,
  aws_route53 as route53,
  Stack,
  type StackProps,
  aws_s3 as s3,
  aws_ses as ses,
  aws_sns as sns,
  aws_ssm as ssm,
  Tags,
  aws_wafv2 as wafv2,
} from 'aws-cdk-lib';
import { S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
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
  /**
   * Who sends the user pool's mail (sign-up codes, password resets): `ses` sends from
   * `login@mail.<zone>` through the platform's SES domain, `cognito` uses Cognito's own sender
   * (`no-reply@verificationemail.com`, at most 50 messages a day). app.ts picks `ses` once SES
   * can deliver to anyone.
   */
  userPoolEmail: 'ses' | 'cognito';
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
      description:
        'Platform shared resources: DNS, certificates, edge router, buckets, tables, Cognito, realtime, email, IAM',
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
    // Public stores (`STORAGE_PATH`): the storage bucket under its public
    // root, which is all this distribution may read of it (bucket policy
    // below), with headers that keep an uploaded HTML or SVG file from running
    // script on the app's origin. A file without its own Cache-Control gets
    // one that makes browsers revalidate; the edge itself caches it for the
    // cache policy's default TTL (none).
    const storageAccess = new cloudfront.S3OriginAccessControl(this, 'StorageOriginAccess', {
      originAccessControlName: 'platform-storage',
      signing: cloudfront.Signing.SIGV4_ALWAYS,
    });
    const storageHeaders = new cloudfront.ResponseHeadersPolicy(this, 'StorageHeaders', {
      responseHeadersPolicyName: 'platform-storage',
      comment: 'platform public stores: nosniff, no scripts, revalidate by default',
      securityHeadersBehavior: {
        contentTypeOptions: { override: true },
        contentSecurityPolicy: {
          contentSecurityPolicy: STORAGE_RESPONSE_HEADERS['content-security-policy'],
          override: true,
        },
      },
      customHeadersBehavior: {
        customHeaders: [{ header: 'Cache-Control', value: STORAGE_DEFAULT_CACHE_CONTROL, override: false }],
      },
    });

    // The floor under every app's own limits: a client sending one host more
    // than `edgeRequestsPerMinute` is answered 429 at the edge, static files
    // included, until its rate drops. Counted per client and host, so a busy
    // client of one app (or a CI runner testing several) isn't blocked from
    // the others. WAF evaluates before the router function, so `host` is the
    // app's own host; lowercased, so spelling it differently doesn't buy a
    // second budget.
    const floor = config.limits.edgeRequestsPerMinute;
    const edgeWebAcl =
      floor === undefined
        ? undefined
        : new wafv2.CfnWebACL(this, 'EdgeFloor', {
            name: platformNames.edgeWebAcl,
            scope: 'CLOUDFRONT',
            description: `At most ${floor} requests per client per app host per minute`,
            defaultAction: { allow: {} },
            customResponseBodies: {
              'rate-limited': {
                contentType: 'APPLICATION_JSON',
                content: JSON.stringify(EDGE_RATE_LIMITED_BODY),
              },
            },
            rules: [
              {
                name: platformNames.edgeFloorRule,
                priority: 0,
                statement: {
                  rateBasedStatement: {
                    limit: floor,
                    evaluationWindowSec: 60,
                    aggregateKeyType: 'CUSTOM_KEYS',
                    customKeys: [
                      { ip: {} },
                      { header: { name: 'host', textTransformations: [{ priority: 0, type: 'LOWERCASE' }] } },
                    ],
                  },
                },
                action: {
                  block: {
                    customResponse: {
                      responseCode: 429,
                      customResponseBodyKey: 'rate-limited',
                      responseHeaders: [{ name: 'retry-after', value: String(EDGE_RETRY_AFTER_SECONDS) }],
                    },
                  },
                },
                visibilityConfig: {
                  cloudWatchMetricsEnabled: true,
                  metricName: platformNames.edgeFloorRule,
                  // The console lists recently blocked requests from WAF's free sample.
                  sampledRequestsEnabled: true,
                },
              },
            ],
            visibilityConfig: {
              cloudWatchMetricsEnabled: true,
              metricName: platformNames.edgeWebAcl,
              sampledRequestsEnabled: true,
            },
          });
    if (edgeWebAcl) tag(edgeWebAcl, 'edge');

    // One distribution for every app. The router function serves static files
    // from the sites bucket or switches the origin to the stage's Web Function.
    const distribution = new cloudfront.Distribution(this, 'Edge', {
      ...(edgeWebAcl ? { webAclId: edgeWebAcl.attrArn } : {}),
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
      additionalBehaviors: {
        // The router rewrites a public store's file to `/<app>/<stage>/<store>/<key>`, or answers 404.
        [`${STORAGE_PATH}*`]: {
          origin: new PublicStorageOrigin(storage, storageAccess),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
          cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
          compress: true,
          // The cache key ignores the behavior; the router keeps these entries apart from the
          // default behavior's with its own x-platform-host (STORAGE_CACHE_HOST in core).
          cachePolicy,
          // No origin request policy: S3 gets only what the cache key holds.
          responseHeadersPolicy: storageHeaders,
          functionAssociations: [
            { function: router, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
          ],
        },
      },
    });
    tag(distribution, 'edge');
    // The public root and nothing else, so a routing mistake can't expose a
    // private store. Listing it makes a missing file a 404 instead of a 403.
    const fromEdge = {
      principals: [new iam.ServicePrincipal('cloudfront.amazonaws.com')],
      conditions: { StringEquals: { 'AWS:SourceArn': distribution.distributionArn } },
    };
    storage.addToResourcePolicy(
      new iam.PolicyStatement({
        ...fromEdge,
        sid: 'EdgeReadsPublicStores',
        actions: ['s3:GetObject'],
        resources: [storage.arnForObjects(`${PUBLIC_STORAGE_ROOT}*`)],
      }),
    );
    storage.addToResourcePolicy(
      new iam.PolicyStatement({
        ...fromEdge,
        sid: 'EdgeFindsMissingPublicFiles',
        actions: ['s3:ListBucket'],
        resources: [storage.bucketArn],
        conditions: {
          ...fromEdge.conditions,
          StringLike: { 's3:prefix': [`${PUBLIC_STORAGE_ROOT}*`] },
        },
      }),
    );

    // `*.<domain>` in the root zone is a CNAME to the edge host; the console
    // is the zone apex.
    const edgeTarget = route53.RecordTarget.fromAlias(new CloudFrontTarget(distribution));
    const aliases = (prefix: string, recordName: string, target: route53.RecordTarget) => [
      new route53.ARecord(this, `${prefix}A`, { zone, recordName, target }),
      new route53.AaaaRecord(this, `${prefix}Aaaa`, { zone, recordName, target }),
    ];
    aliases('EdgeAlias', config.edgeHost, edgeTarget);
    const consoleAliases = aliases('ConsoleAlias', config.consoleHost, edgeTarget);

    // ---------------------------------------------------------------- email
    // One SES domain identity every app sends from (`<app>@mail.<zone>`); the
    // engine gives each stage that declares `email` a tenant associated with
    // it. Every record lives in this zone, so the root zone needs no change
    // (not Identity.publicHostedZone: that would verify the zone apex).
    const mailDomain = emailDomain(config.zone);
    const mailFromDomain = emailMailFromDomain(mailDomain);
    const mail = new ses.EmailIdentity(this, 'MailIdentity', {
      identity: ses.Identity.domain(mailDomain),
      dkimIdentity: ses.DkimIdentity.easyDkim(ses.EasyDkimSigningKeyLength.RSA_2048_BIT),
      mailFromDomain,
      // Without the MX record SES still sends, with its own bounce domain; DMARC then passes
      // on DKIM alone.
      mailFromBehaviorOnMxFailure: ses.MailFromBehaviorOnMxFailure.USE_DEFAULT_VALUE,
    });
    // Stages' tenants are associated with it and the runtime config names it:
    // a replacement would stop every app's mail until it verified again.
    mail.applyRemovalPolicy(RemovalPolicy.RETAIN);
    tag(mail, 'email');
    // Easy DKIM: three CNAMEs to keys SES holds and rotates. Plain record sets,
    // as CDK makes for a hosted-zone identity: the names are tokens that are
    // already fully qualified, which the record constructs would qualify again.
    for (const [i, record] of mail.dkimRecords.entries()) {
      new route53.CfnRecordSet(this, `MailDkim${i + 1}`, {
        hostedZoneId: zone.hostedZoneId,
        name: record.name,
        type: 'CNAME',
        resourceRecords: [record.value],
        ttl: '1800',
      });
    }
    // MAIL FROM: bounces return to SES, and SPF passes for a domain aligned with the sender's.
    new route53.MxRecord(this, 'MailFromMx', {
      zone,
      recordName: mailFromDomain,
      values: [{ priority: 10, hostName: `feedback-smtp.${this.region}.amazonses.com` }],
    });
    new route53.TxtRecord(this, 'MailFromSpf', {
      zone,
      recordName: mailFromDomain,
      values: ['v=spf1 include:amazonses.com ~all'],
    });
    // Receivers quarantine mail that claims the domain without aligned DKIM or
    // SPF. No `rua`: there is no mailbox to receive aggregate reports.
    new route53.TxtRecord(this, 'MailDmarc', {
      zone,
      recordName: `_dmarc.${mailDomain}`,
      values: ['v=DMARC1; p=quarantine; adkim=r; aspf=r'],
    });

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
      // DEVELOPER email from an identity in this account and region needs no
      // sending-authorization policy (that's for Cognito's own sender with a
      // custom From): Cognito sends with its service-linked role
      // (AWSServiceRoleForAmazonCognitoIdpEmailService), which it creates on
      // the first such update with the deploying credentials, CloudFormation's
      // execution role. Without a configuration set or tenant, these count
      // against the account, not any app.
      ...(props.userPoolEmail === 'ses'
        ? {
            email: cognito.UserPoolEmail.withSES({
              fromEmail: `${EMAIL_LOGIN_LOCAL_PART}@${mailDomain}`,
              // Quoted: a display name with a dot isn't a plain phrase (RFC 5322).
              fromName: `"${config.domain}"`,
              sesRegion: this.region,
              sesVerifiedDomain: mailDomain,
            }),
          }
        : {}),
    });
    tag(users, 'identity');
    // The pool names the identity by ARN, which CloudFormation can't see as a reference.
    if (props.userPoolEmail === 'ses') users.node.addDependency(mail);
    const login = users.addDomain('Login', {
      customDomain: { domainName: config.loginHost, certificate: zoneCertificate },
      managedLoginVersion: cognito.ManagedLoginVersion.NEWER_MANAGED_LOGIN,
    });
    // Cognito accepts a custom domain only once its parent domain resolves.
    for (const record of consoleAliases) login.node.addDependency(record);
    aliases('LoginAlias', config.loginHost, route53.RecordTarget.fromAlias(new UserPoolDomainTarget(login)));

    // -------------------------------------------------------------- realtime
    // One AppSync Event API for every app: the engine gives each stage that
    // declares `realtime` a channel namespace in it. Browsers reach it through
    // the router (`/__platform/realtime` on the app's own host). Publishing is
    // IAM only (stage roles); subscribing takes the public API key or a token
    // from the app's server, which this authorizer checks. There is no API key
    // here: the control plane owns it and extends it nightly, and a drift-
    // reverting stack deploy would fight that.
    const authorizerLogs = new logs.LogGroup(this, 'RealtimeAuthorizerLogs', {
      logGroupName: `/aws/lambda/${platformNames.realtimeAuthorizer}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const authorizer = new NodejsFunction(this, 'RealtimeAuthorizer', {
      functionName: platformNames.realtimeAuthorizer,
      description: 'Checks signed-in subscribe tokens for the realtime Event API',
      entry: fileURLToPath(new URL('./realtime-authorizer.ts', import.meta.url)),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      // It verifies an HMAC and reads one cached SSM parameter.
      memorySize: 256,
      timeout: Duration.seconds(5),
      logGroup: authorizerLogs,
      bundling: {
        format: OutputFormat.ESM,
        target: 'node24',
        minify: true,
        // The Node.js runtime ships the AWS SDK v3.
        externalModules: ['@aws-sdk/*'],
      },
    });
    // Stage keys only (the token names its stage); SecureStrings decrypt through SSM.
    authorizer.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [
          this.formatArn({
            service: 'ssm',
            resource: 'parameter',
            resourceName: names.stageKeyParameter('*', '*').replace(/^\//, ''),
          }),
        ],
      }),
    );
    authorizer.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['kms:Decrypt'],
        resources: [this.formatArn({ service: 'kms', resource: 'key', resourceName: '*' })],
        conditions: { StringEquals: { 'kms:ViaService': `ssm.${this.region}.amazonaws.com` } },
      }),
    );
    tag(authorizer, 'realtime');

    const realtimeApi = new appsync.CfnApi(this, 'RealtimeApi', {
      name: platformNames.realtimeApi,
      eventConfig: {
        authProviders: [
          { authType: 'API_KEY' },
          { authType: 'AWS_IAM' },
          {
            authType: 'AWS_LAMBDA',
            lambdaAuthorizerConfig: {
              authorizerUri: authorizer.functionArn,
              // A default; each answer sets its own ttlOverride (the token's remaining life).
              authorizerResultTtlInSeconds: 300,
              // Malformed tokens are refused without invoking the function.
              identityValidationExpression: REALTIME_TOKEN_PATTERN,
            },
          },
        ],
        connectionAuthModes: [{ authType: 'API_KEY' }, { authType: 'AWS_LAMBDA' }],
        defaultPublishAuthModes: [{ authType: 'AWS_IAM' }],
        defaultSubscribeAuthModes: [{ authType: 'AWS_LAMBDA' }],
      },
    });
    // Its domains are in the runtime config and the route store, and stages'
    // namespaces live in it: a replacement would break every realtime app.
    realtimeApi.applyRemovalPolicy(RemovalPolicy.RETAIN);
    tag(realtimeApi, 'realtime');
    authorizer.addPermission('AppSyncInvoke', {
      principal: new iam.ServicePrincipal('appsync.amazonaws.com'),
      action: 'lambda:InvokeFunction',
      sourceArn: realtimeApi.attrApiArn,
    });

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
          realtimeApiId: realtimeApi.attrApiId,
          email: { identityArn: mail.emailIdentityArn, usageTable: telemetry.tableName },
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
              realtime: { apiId: realtimeApi.attrApiId },
              email: { identityArn: mail.emailIdentityArn },
              ...(edgeWebAcl ? { edgeWebAclArn: edgeWebAcl.attrArn } : {}),
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
      ...(edgeWebAcl ? { edgeWebAclArn: edgeWebAcl.attrArn } : {}),
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
      realtime: {
        apiId: realtimeApi.attrApiId,
        httpDomain: realtimeApi.attrDnsHttp,
        realtimeDomain: realtimeApi.attrDnsRealtime,
      },
      email: { domain: mailDomain, identityArn: mail.emailIdentityArn },
    };
    new ssm.StringParameter(this, 'RuntimeConfig', {
      parameterName: platformNames.runtimeConfigParameter,
      description: 'Shared platform resources (the platform-foundation stack)',
      stringValue: this.toJsonString(runtime),
    });

    new CfnOutput(this, 'ControlPlaneRoleArn', { value: controlPlaneRole.roleArn });
    new CfnOutput(this, 'CiRoleArn', { value: ciRole.roleArn });
    new CfnOutput(this, 'DistributionDomainName', { value: distribution.distributionDomainName });
    new CfnOutput(this, 'RealtimeApiId', { value: realtimeApi.attrApiId });
  }
}

/**
 * The storage bucket's public root through OAC. `S3BucketOrigin` would also
 * let the distribution read the whole bucket, private stores included; the
 * stack grants it the public root itself.
 */
class PublicStorageOrigin extends cloudfront.OriginBase {
  constructor(bucket: s3.IBucket, access: cloudfront.IOriginAccessControl) {
    super(bucket.bucketRegionalDomainName, {
      originId: 'storage',
      originPath: `/${PUBLIC_STORAGE_ROOT}`,
      originAccessControlId: access.originAccessControlId,
    });
  }

  protected override renderS3OriginConfig(): cloudfront.CfnDistribution.S3OriginConfigProperty {
    // OAC, not an origin access identity.
    return { originAccessIdentity: '' };
  }
}

/** `platform:managed` + `platform:component` on every taggable resource under `scope`. */
function tag(scope: IConstruct, component: string): void {
  for (const [key, value] of Object.entries(platformTags(component))) Tags.of(scope).add(key, value);
}
