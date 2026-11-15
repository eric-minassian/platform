import { readFileSync } from 'node:fs';
import { Agent } from 'node:https';
import { ACMClient } from '@aws-sdk/client-acm';
import { CloudFrontClient } from '@aws-sdk/client-cloudfront';
import { CloudFrontKeyValueStoreClient } from '@aws-sdk/client-cloudfront-keyvaluestore';
import { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import { IAMClient } from '@aws-sdk/client-iam';
import { LambdaClient } from '@aws-sdk/client-lambda';
import { LambdaWebClient } from '@aws-sdk/client-lambda-web';
import { ResourceGroupsTaggingAPIClient } from '@aws-sdk/client-resource-groups-tagging-api';
import { Route53Client } from '@aws-sdk/client-route-53';
import { S3Client } from '@aws-sdk/client-s3';
import { SchedulerClient } from '@aws-sdk/client-scheduler';
import { SNSClient } from '@aws-sdk/client-sns';
import { SQSClient } from '@aws-sdk/client-sqs';
import { SSMClient } from '@aws-sdk/client-ssm';
import { STSClient } from '@aws-sdk/client-sts';
import { NodeHttpHandler } from '@smithy/node-http-handler';
// CloudFront KeyValueStore requests are signed with SigV4a; this registers the
// pure-JS signer with the SDK.
import '@aws-sdk/signature-v4a';
import { addEmulatorCompat } from './compat.ts';

export interface ClientOptions {
  region: string;
  emulator?: {
    endpoint: string;
    caFile: string;
    credentials: { accessKeyId: string; secretAccessKey: string };
  };
  credentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
}

export interface AwsClients {
  readonly region: string;
  readonly iam: IAMClient;
  readonly sts: STSClient;
  readonly dynamodb: DynamoDBClient;
  readonly sqs: SQSClient;
  readonly events: EventBridgeClient;
  readonly scheduler: SchedulerClient;
  readonly lambda: LambdaClient;
  readonly lambdaWeb: LambdaWebClient;
  readonly logs: CloudWatchLogsClient;
  readonly s3: S3Client;
  readonly ssm: SSMClient;
  readonly cognito: CognitoIdentityProviderClient;
  readonly cloudfront: CloudFrontClient;
  readonly kvs: CloudFrontKeyValueStoreClient;
  readonly route53: Route53Client;
  /** Certificates for CloudFront and Cognito custom domains must live in us-east-1. */
  readonly acm: ACMClient;
  readonly sns: SNSClient;
  readonly tagging: ResourceGroupsTaggingAPIClient;
  /** Same clients with different credentials (e.g. an assumed cross-account role). */
  withCredentials(credentials: NonNullable<ClientOptions['credentials']>): AwsClients;
}

type ClientConfig = {
  region: string;
  endpoint?: string;
  credentials?: ClientOptions['credentials'];
  requestHandler?: NodeHttpHandler;
  disableHostPrefix?: boolean;
  maxAttempts?: number;
};

/** Lazily constructed SDK clients, configured for AWS or for the AWS Emulator. */
export function createClients(opts: ClientOptions): AwsClients {
  const base = baseConfig(opts);
  const cache = new Map<string, unknown>();
  const lazy = <T>(key: string, make: () => T): T => {
    if (!cache.has(key)) cache.set(key, make());
    return cache.get(key) as T;
  };
  const emulator = Boolean(opts.emulator);

  return {
    region: opts.region,
    get iam() {
      return lazy('iam', () => new IAMClient(base));
    },
    get sts() {
      return lazy('sts', () => new STSClient(base));
    },
    get dynamodb() {
      return lazy('dynamodb', () => new DynamoDBClient(base));
    },
    get sqs() {
      return lazy('sqs', () => new SQSClient(base));
    },
    get events() {
      return lazy('events', () => new EventBridgeClient(base));
    },
    get scheduler() {
      return lazy('scheduler', () => new SchedulerClient(base));
    },
    get lambda() {
      return lazy('lambda', () => new LambdaClient(base));
    },
    get lambdaWeb() {
      return lazy('lambdaWeb', () => {
        const c = new LambdaWebClient(base);
        if (emulator) addEmulatorCompat(c);
        return c;
      });
    },
    get logs() {
      return lazy('logs', () => new CloudWatchLogsClient(base));
    },
    get s3() {
      return lazy('s3', () => new S3Client({ ...base, forcePathStyle: emulator }));
    },
    get ssm() {
      return lazy('ssm', () => new SSMClient(base));
    },
    get cognito() {
      return lazy('cognito', () => new CognitoIdentityProviderClient(base));
    },
    get cloudfront() {
      return lazy('cloudfront', () => new CloudFrontClient({ ...base, region: 'us-east-1' }));
    },
    get kvs() {
      return lazy('kvs', () => new CloudFrontKeyValueStoreClient({ ...base, region: 'us-east-1' }));
    },
    get route53() {
      return lazy('route53', () => new Route53Client({ ...base, region: 'us-east-1' }));
    },
    get acm() {
      return lazy('acm', () => new ACMClient({ ...base, region: 'us-east-1' }));
    },
    get sns() {
      return lazy('sns', () => new SNSClient(base));
    },
    get tagging() {
      return lazy('tagging', () => new ResourceGroupsTaggingAPIClient(base));
    },
    withCredentials(credentials) {
      return createClients({ ...opts, credentials });
    },
  };
}

function baseConfig(opts: ClientOptions): ClientConfig {
  if (opts.emulator) {
    return {
      region: opts.region,
      endpoint: opts.emulator.endpoint,
      credentials: opts.credentials ?? opts.emulator.credentials,
      requestHandler: new NodeHttpHandler({
        httpsAgent: new Agent({ ca: readFileSync(opts.emulator.caFile), keepAlive: true }),
      }),
      // Host-prefixed operations (e.g. Cloud Map, KeyValueStore) must hit the emulator host.
      disableHostPrefix: true,
      maxAttempts: 5,
    };
  }
  return {
    region: opts.region,
    ...(opts.credentials ? { credentials: opts.credentials } : {}),
    maxAttempts: 8,
  };
}
