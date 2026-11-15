import type { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import type { LambdaClient } from '@aws-sdk/client-lambda';
import type { S3Client } from '@aws-sdk/client-s3';
import type { SESv2Client } from '@aws-sdk/client-sesv2';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { SSMClient } from '@aws-sdk/client-ssm';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { isEmulator, region } from './bindings.ts';

/**
 * AWS clients, created on first use. Under `plat dev` / `plat test` the
 * standard `AWS_ENDPOINT_URL` points every client at the AWS Emulator and
 * `NODE_EXTRA_CA_CERTS` trusts its certificate; nothing else differs.
 *
 * Only DynamoDB is imported eagerly (most apps use it, and `db.raw()` is
 * synchronous). Everything else is a dynamic import, which esbuild keeps in
 * the same bundle but evaluates lazily — so cold starts only pay for the
 * services a request actually touches.
 */
export interface Clients {
  ddb: DynamoDBDocumentClient;
  sqs: SQSClient;
  events: EventBridgeClient;
  s3: S3Client;
  ssm: SSMClient;
  lambda: LambdaClient;
  cognito: CognitoIdentityProviderClient;
  sesv2: SESv2Client;
}

export type LazyClientName = Exclude<keyof Clients, 'ddb'>;

/** Minimal client shape (tests may substitute `{ send }` fakes). */
export interface SendClient {
  send(command: unknown): Promise<unknown>;
}

const instances: Partial<Record<keyof Clients, unknown>> = {};
const pending: Partial<Record<keyof Clients, Promise<unknown>>> = {};
const overrides: Partial<Record<keyof Clients, SendClient>> = {};

function config(): { region: string; endpoint?: string } {
  const endpoint = process.env.AWS_ENDPOINT_URL;
  return { region: region(), ...(endpoint ? { endpoint } : {}) };
}

const lazyFactories: { [K in LazyClientName]: () => Promise<Clients[K]> } = {
  sqs: async () => new (await import('@aws-sdk/client-sqs')).SQSClient(config()),
  events: async () => new (await import('@aws-sdk/client-eventbridge')).EventBridgeClient(config()),
  s3: async () =>
    new (await import('@aws-sdk/client-s3')).S3Client({
      ...config(),
      ...(isEmulator() ? { forcePathStyle: true } : {}),
    }),
  ssm: async () => new (await import('@aws-sdk/client-ssm')).SSMClient(config()),
  lambda: async () => new (await import('@aws-sdk/client-lambda')).LambdaClient(config()),
  cognito: async () =>
    new (await import('@aws-sdk/client-cognito-identity-provider')).CognitoIdentityProviderClient(config()),
  sesv2: async () => new (await import('@aws-sdk/client-sesv2')).SESv2Client(config()),
};

/** The DynamoDB document client (synchronous). */
export function ddbClient(): DynamoDBDocumentClient {
  const o = overrides.ddb;
  if (o) return o as unknown as DynamoDBDocumentClient;
  let c = instances.ddb as DynamoDBDocumentClient | undefined;
  if (!c) {
    c = DynamoDBDocumentClient.from(new DynamoDBClient(config()), {
      marshallOptions: { removeUndefinedValues: true, convertClassInstanceToMap: true },
    });
    instances.ddb = c;
  }
  return c;
}

export async function client<K extends LazyClientName>(name: K): Promise<Clients[K]> {
  const o = overrides[name];
  if (o) return o as unknown as Clients[K];
  const existing = instances[name];
  if (existing) return existing as Clients[K];
  pending[name] ??= lazyFactories[name]().then((c) => {
    instances[name] = c;
    return c;
  });
  return pending[name] as Promise<Clients[K]>;
}

/** Substitute a client (tests). `undefined` removes the override. */
export function setClient(name: keyof Clients, fake: SendClient | undefined): void {
  if (fake) overrides[name] = fake;
  else delete overrides[name];
}

/** Drop cached clients (tests that change region/endpoint between runs). */
export function resetClients(): void {
  for (const k of Object.keys(instances) as (keyof Clients)[]) delete instances[k];
  for (const k of Object.keys(pending) as (keyof Clients)[]) delete pending[k];
  for (const k of Object.keys(overrides) as (keyof Clients)[]) delete overrides[k];
}
