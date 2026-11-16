import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  CognitoIdentityProviderClient,
  CreateUserPoolClientCommand,
  CreateUserPoolCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  GetItemCommand,
  UpdateTimeToLiveCommand,
} from '@aws-sdk/client-dynamodb';
import {
  CreateEventBusCommand,
  EventBridgeClient,
  PutRuleCommand,
  PutTargetsCommand,
} from '@aws-sdk/client-eventbridge';
import { CreateBucketCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SetQueueAttributesCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { PutParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { BINDINGS_ENV, type Bindings, encodeBindings, readDeadLetter } from '@ericminassian/platform-core';
import { Effect, Layer, Option, Redacted } from 'effect';
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from 'effect/http-api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Authentication,
  CurrentUser,
  Db,
  Events,
  Platform,
  Queues,
  RateLimits,
  Secrets,
  Storage,
  toFetchHandler,
  User,
} from '../../src/index.ts';
import { setBindings } from '../../src/runtime/bindings.ts';
import { afterFailure } from '../../src/runtime/jobs.ts';
import { captureTelemetry, createPlatformFetch, resetPlatform } from '../../src/testing.ts';
import { batchContract, countersContract, dbContract, transactContract } from '../effect-db-contract.ts';
import { rateLimitContract } from '../rate-limit-contract.ts';

const region = process.env.AWS_REGION ?? 'us-east-1';
const endpoint = process.env.AWS_ENDPOINT_URL;
const cfg = { region, ...(endpoint ? { endpoint } : {}) };
const id = Date.now().toString(36);
const APP = `it${id}`;
const STAGE = 'test';
const base = `${APP}--${STAGE}`;

let bindings: Bindings;
let eventsTargetUrl = '';
let localWorker: Server;
const delivered: Array<{ body: unknown; at: string | string[] | undefined }> = [];
let headObject: (key: string) => Promise<{ contentType?: string; cacheControl?: string }>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function createTable(ddb: DynamoDBClient, name: string) {
  const attrs = ['pk', 'sk', 'gsi1pk', 'gsi1sk', 'gsi2pk', 'gsi2sk', 'gsi3pk', 'gsi3sk'];
  await ddb.send(
    new CreateTableCommand({
      TableName: name,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: attrs.map((a) => ({ AttributeName: a, AttributeType: 'S' })),
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
      GlobalSecondaryIndexes: [1, 2, 3].map((n) => ({
        IndexName: `gsi${n}`,
        KeySchema: [
          { AttributeName: `gsi${n}pk`, KeyType: 'HASH' },
          { AttributeName: `gsi${n}sk`, KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
      })),
    }),
  );
  for (let i = 0; i < 60; i++) {
    const t = await ddb.send(new DescribeTableCommand({ TableName: name }));
    if (t.Table?.TableStatus === 'ACTIVE') break;
    await sleep(250);
  }
  await ddb.send(
    new UpdateTimeToLiveCommand({
      TableName: name,
      TimeToLiveSpecification: { Enabled: true, AttributeName: '_ttl' },
    }),
  );
}

async function queueArn(sqs: SQSClient, url: string): Promise<string> {
  const a = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['QueueArn'] }));
  return a.Attributes!.QueueArn!;
}

beforeAll(async () => {
  if (!endpoint) throw new Error('integration tests need the AWS Emulator (see setup.ts)');
  const ddb = new DynamoDBClient(cfg);
  const sqs = new SQSClient(cfg);
  const eb = new EventBridgeClient(cfg);
  const s3 = new S3Client({ ...cfg, forcePathStyle: true });
  const ssm = new SSMClient(cfg);
  const cognito = new CognitoIdentityProviderClient(cfg);

  await createTable(ddb, base);

  const dead = await sqs.send(new CreateQueueCommand({ QueueName: `${base}--jobs--dead` }));
  // Under `plat dev` / `plat test` jobs go to the CLI's local worker; this stands in for it.
  localWorker = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      delivered.push({ body: JSON.parse(body), at: req.headers['x-platform-deliver-at'] });
      res.writeHead(202).end();
    });
  });
  await new Promise<void>((resolve) => localWorker.listen(0, '127.0.0.1', resolve));
  process.env.PLATFORM_LOCAL_WORKER_URL = `http://127.0.0.1:${(localWorker.address() as AddressInfo).port}/`;
  const target = await sqs.send(new CreateQueueCommand({ QueueName: `${base}--evt-target` }));
  eventsTargetUrl = target.QueueUrl!;
  const targetArn = await queueArn(sqs, eventsTargetUrl);
  await sqs.send(
    new SetQueueAttributesCommand({
      QueueUrl: eventsTargetUrl,
      Attributes: {
        Policy: JSON.stringify({
          Version: '2012-10-17',
          Statement: [
            {
              Effect: 'Allow',
              Principal: { Service: 'events.amazonaws.com' },
              Action: 'sqs:SendMessage',
              Resource: targetArn,
            },
          ],
        }),
      },
    }),
  );
  const bus = await eb.send(new CreateEventBusCommand({ Name: base }));
  await eb.send(
    new PutRuleCommand({
      Name: `${base}--order`,
      EventBusName: base,
      EventPattern: JSON.stringify({ 'detail-type': ['order.created'] }),
    }),
  );
  await eb.send(
    new PutTargetsCommand({
      Rule: `${base}--order`,
      EventBusName: base,
      Targets: [{ Id: '1', Arn: targetArn }],
    }),
  );

  const bucket = `platform-000000000000-${region}-storage-${id}`;
  await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  headObject = async (key) => {
    const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return {
      ...(head.ContentType ? { contentType: head.ContentType } : {}),
      ...(head.CacheControl ? { cacheControl: head.CacheControl } : {}),
    };
  };

  const secretsPath = `/platform/apps/${APP}/${STAGE}/secrets/`;
  const sharedPath = `/platform/apps/${APP}/_shared/secrets/`;
  await ssm.send(
    new PutParameterCommand({ Name: `${secretsPath}STAGE_ONLY`, Type: 'SecureString', Value: 'stage-value' }),
  );
  await ssm.send(
    new PutParameterCommand({ Name: `${sharedPath}SHARED`, Type: 'SecureString', Value: 'shared-value' }),
  );
  await ssm.send(
    new PutParameterCommand({ Name: `${sharedPath}STAGE_ONLY`, Type: 'SecureString', Value: 'overridden' }),
  );

  const pool = await cognito.send(
    new CreateUserPoolCommand({
      PoolName: `platform-users-${id}`,
      UsernameAttributes: ['email'],
      AutoVerifiedAttributes: ['email'],
    }),
  );
  const poolId = pool.UserPool!.Id!;
  const appClient = await cognito.send(
    new CreateUserPoolClientCommand({
      UserPoolId: poolId,
      ClientName: base,
      ExplicitAuthFlows: [
        'ALLOW_ADMIN_USER_PASSWORD_AUTH',
        'ALLOW_USER_PASSWORD_AUTH',
        'ALLOW_REFRESH_TOKEN_AUTH',
      ],
    }),
  );

  bindings = {
    v: 2,
    app: APP,
    stage: STAGE,
    host: `${APP}--${STAGE}.localhost`,
    url: `http://${APP}--${STAGE}.localhost:3000`,
    revision: 'dlocal',
    region,
    account: '000000000000',
    table: base,
    worker: `${base}--worker`,
    jobs: {
      queues: ['emails'],
      fns: {},
      attempts: {},
      dead: dead.QueueUrl!,
      group: base,
      role: `arn:aws:iam::000000000000:role/platform/apps/${base}`,
    },
    bus: { name: base, arn: bus.EventBusArn! },
    storage: {
      bucket,
      prefix: `${APP}/${STAGE}/`,
      stores: ['uploads', 'snapshots'],
      public: ['snapshots'],
      publicPrefix: `_public/${APP}/${STAGE}/`,
    },
    secrets: { path: secretsPath, sharedPath, names: ['STAGE_ONLY', 'SHARED'] },
    auth: {
      mode: 'local',
      userPoolId: poolId,
      clientId: appClient.UserPoolClient!.ClientId!,
      issuer: `https://cognito-idp.${region}.amazonaws.com/${poolId}`,
      jwksUri: `${endpoint.replace(/\/$/, '')}/${poolId}/.well-known/jwks.json`,
      loginUrl: 'http://unused.localhost',
      required: false,
    },
    stageKey: randomBytes(32).toString('base64url'),
  };
  process.env[BINDINGS_ENV] = encodeBindings(bindings);
  process.env.PLATFORM_LOCAL = '1';
  setBindings(undefined);
});

afterAll(() => {
  resetPlatform();
  delete process.env.PLATFORM_LOCAL_WORKER_URL;
  localWorker?.close();
});

/** Runs `effect` on the real platform services, through this stage's bindings. */
const run = <A, E>(effect: Effect.Effect<A, E, Platform.Services>) =>
  Effect.runPromise(effect.pipe(Effect.provide(Platform.layer)));

describe('against the AWS Emulator', () => {
  it('db: behaves like the in-memory store', () =>
    Effect.runPromise(dbContract('notes-effect').pipe(Effect.provide(Db.layer))));

  it('db: putMany/deleteMany write batches like the in-memory store', () =>
    Effect.runPromise(batchContract('notes-batch').pipe(Effect.provide(Db.layer))));

  it('db: transact applies all writes or, when one condition fails, none', () =>
    Effect.runPromise(transactContract('notes-tx').pipe(Effect.provide(Db.layer))));

  it('db: increments and conditional updates behave like the in-memory store', async () => {
    await Effect.runPromise(countersContract('ctr').pipe(Effect.provide(Db.layer)));
    // What only the stored item shows: the TTL DynamoDB expires it by, and the
    // index attributes `create` determined, written by the increment itself.
    const ddb = new DynamoDBClient(cfg);
    const item = async (pk: string, sk: string) =>
      (await ddb.send(new GetItemCommand({ TableName: base, Key: { pk: { S: pk }, sk: { S: sk } } }))).Item;
    expect((await item('ctr-usage#c3', '1'))?._ttl).toEqual({ N: '240' });
    expect(await item('ctr-usage#c1', '1')).toMatchObject({
      _ttl: { N: '120' },
      gsi1pk: { S: 'ctr-usage#byPlan#pro' },
      gsi1sk: { S: 'c1' },
    });
  });

  it('rate limits: count like the in-memory counters, with exactly max of 64 racing checks', async () => {
    await Effect.runPromise(rateLimitContract('rl').pipe(Effect.provide(RateLimits.layer)));
    // The counter as stored: the window's count, and an expiry once the next window ends.
    const per = 30 * 86_400_000;
    const window = Math.floor(Date.now() / per);
    const ddb = new DynamoDBClient(cfg);
    const key = { pk: { S: '_rl#rl-cost#k' }, sk: { S: `${per}#${window}` } };
    expect((await ddb.send(new GetItemCommand({ TableName: base, Key: key }))).Item).toEqual({
      ...key,
      n: { N: '100' },
      _ttl: { N: String(Math.ceil(((window + 2) * per) / 1000)) },
    });
  });

  it('queue: send hands the local worker a job with the body and trace, delayed ones with their time', async () => {
    await run(Effect.flatMap(Queues, (queues) => queues.send('emails', { to: 'eric@example.com' })));
    await run(
      Effect.flatMap(Queues, (queues) => queues.send('emails', { to: 'later' }, { delay: '2 hours' })),
    );
    expect(delivered[0]!.body).toMatchObject({
      kind: 'queue',
      name: 'emails',
      attempt: 1,
      body: { to: 'eric@example.com' },
    });
    expect((delivered[0]!.body as { trace: string }).trace).toMatch(/^[0-9a-f]{32}$/);
    expect(delivered[0]!.at).toBeUndefined();
    expect(Number(delivered[1]!.at)).toBeGreaterThan(Date.now() + 7_000_000);
  });

  it('jobs: a job past its last attempt lands in the dead-letter queue', async () => {
    const job = {
      __platform: 'job' as const,
      kind: 'queue' as const,
      name: 'emails',
      id: 'm1',
      attempt: 5,
      sentAt: Date.now(),
      body: { to: 'x' },
    };
    expect(await afterFailure(job, new Error('bounced'))).toBe('dead');
    const out = await new SQSClient(cfg).send(
      new ReceiveMessageCommand({ QueueUrl: bindings.jobs!.dead, WaitTimeSeconds: 2 }),
    );
    expect(readDeadLetter(out.Messages![0]!.Body!)).toMatchObject({
      kind: 'queue',
      name: 'emails',
      attempts: 5,
      error: { message: 'bounced' },
      redrive: { attempt: 1, body: { to: 'x' } },
    });
  });

  it('events: publish reaches a subscribed rule target', async () => {
    await run(Effect.flatMap(Events, (events) => events.publish('order.created', { orderId: 42 })));
    const sqs = new SQSClient(cfg);
    type Delivered = { 'detail-type': string; source: string; detail: { data: unknown; trace: string } };
    let body: Delivered | undefined;
    for (let i = 0; i < 10 && !body; i++) {
      const out = await sqs.send(
        new ReceiveMessageCommand({ QueueUrl: eventsTargetUrl, WaitTimeSeconds: 1 }),
      );
      if (out.Messages?.[0]) body = JSON.parse(out.Messages[0].Body!) as Delivered;
    }
    expect(body).toMatchObject({
      'detail-type': 'order.created',
      source: `platform.${APP}`,
      detail: { data: { orderId: 42 } },
    });
  });

  it('storage: put/get/list and presigned upload/download URLs', () =>
    run(
      Effect.gen(function* () {
        const s = (yield* Storage).store('uploads');
        yield* s.put('docs/hello.txt', 'hello world', { contentType: 'text/plain' });
        expect(yield* s.getText('docs/hello.txt')).toEqual(Option.some('hello world'));
        expect(yield* s.get('docs/missing.txt')).toEqual(Option.none());
        expect((yield* s.list('docs/')).objects.map((o) => o.key)).toEqual(['docs/hello.txt']);

        const uploadUrl = yield* s.uploadUrl('direct.bin', { contentType: 'application/octet-stream' });
        const put = yield* Effect.promise(() =>
          fetch(uploadUrl, {
            method: 'PUT',
            headers: { 'content-type': 'application/octet-stream' },
            body: new Uint8Array([1, 2, 3]),
          }),
        );
        expect(put.status).toBe(200);
        expect(yield* s.get('direct.bin')).toEqual(Option.some(new Uint8Array([1, 2, 3])));
        const downloadUrl = yield* s.downloadUrl('docs/hello.txt');
        expect(yield* Effect.promise(() => fetch(downloadUrl).then((r) => r.text()))).toBe('hello world');
        yield* s.delete('direct.bin');
        expect(yield* s.get('direct.bin')).toEqual(Option.none());
      }),
    ));

  it('storage: public stores keep their files under the public prefix, with their headers', () =>
    run(
      Effect.gen(function* () {
        const s = (yield* Storage).store('snapshots');
        yield* s.put('fires/1105.json', '{"n":1}', { cacheControl: 'public, max-age=31536000, immutable' });
        expect(
          yield* Effect.promise(() => headObject(`_public/${APP}/${STAGE}/snapshots/fires/1105.json`)),
        ).toEqual({
          contentType: 'application/json; charset=utf-8',
          cacheControl: 'public, max-age=31536000, immutable',
        });
        expect(yield* s.getText('fires/1105.json')).toEqual(Option.some('{"n":1}'));

        // A browser upload sends the headers it was signed with.
        const uploadUrl = yield* s.uploadUrl('tiles/a.png', {
          contentType: 'image/png',
          cacheControl: 'no-cache',
        });
        const put = yield* Effect.promise(() =>
          fetch(uploadUrl, {
            method: 'PUT',
            headers: { 'content-type': 'image/png', 'cache-control': 'no-cache' },
            body: new Uint8Array([1]),
          }),
        );
        expect(put.status).toBe(200);
        expect(
          yield* Effect.promise(() => headObject(`_public/${APP}/${STAGE}/snapshots/tiles/a.png`)),
        ).toEqual({
          contentType: 'image/png',
          cacheControl: 'no-cache',
        });
        expect(yield* s.publicUrl('fires/1105.json')).toBe(
          `http://${APP}--${STAGE}.localhost:3000/__platform/storage/snapshots/fires/1105.json`,
        );
      }),
    ));

  it('secrets: stage value wins, shared is the fallback', () =>
    run(
      Effect.gen(function* () {
        const secrets = yield* Secrets;
        expect(Redacted.value(yield* secrets.get('STAGE_ONLY'))).toBe('stage-value');
        expect(Redacted.value(yield* secrets.get('SHARED'))).toBe('shared-value');
        expect(yield* secrets.getOptional('MISSING')).toEqual(Option.none());
      }),
    ));

  it('auth (local mode): sign in through the form, then resolve the user', async () => {
    const tel = captureTelemetry();
    // An app's API behind `Authentication`, served as a deployed app serves it.
    const Api = HttpApi.make('it').add(
      HttpApiGroup.make('me', { topLevel: true })
        .add(HttpApiEndpoint.get('whoami', '/api/whoami', { success: User }))
        .middleware(Authentication),
    );
    const Handlers = HttpApiBuilder.group(Api, 'me', (handlers) =>
      handlers.handle('whoami', () => CurrentUser),
    );
    const f = createPlatformFetch(
      toFetchHandler(HttpApiBuilder.layer(Api).pipe(Layer.provide(Handlers), Layer.provide(Platform.layer))),
    );
    const origin = bindings.url;

    const form = await f(new Request(`${origin}/__platform/auth/login?redirect=/api/whoami`));
    expect(form.status).toBe(200);
    expect(await form.text()).toContain('<form method="post"');
    expect((await f(new Request(`${origin}/api/whoami`))).status).toBe(401);

    const signIn = await f(
      new Request(`${origin}/__platform/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ email: 'Dev@Example.com', name: 'Dev', redirect: '/api/whoami' }),
      }),
    );
    expect(signIn.status).toBe(303);
    expect(signIn.headers.get('location')).toBe('/api/whoami');
    const setCookies = signIn.headers.getSetCookie();
    expect(setCookies.some((c) => c.startsWith('__plat_id=') && !c.includes('Secure'))).toBe(true);
    const cookie = setCookies.map((c) => c.split(';')[0]).join('; ');

    const me = await f(new Request(`${origin}/__platform/auth/me`, { headers: { cookie } }));
    expect(me.status).toBe(200);
    const user = (await me.json()) as { id: string; email: string };
    expect(user.email).toBe('dev@example.com');
    expect(user.id).toBeTruthy();
    const whoami = await f(new Request(`${origin}/api/whoami`, { headers: { cookie } }));
    expect(((await whoami.json()) as { id: string }).id).toBe(user.id);

    // Signing in again reuses the same user.
    const again = await f(
      new Request(`${origin}/__platform/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ email: 'dev@example.com' }),
      }),
    );
    const cookie2 = again.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');
    const me2 = (await (
      await f(new Request(`${origin}/__platform/auth/me`, { headers: { cookie: cookie2 } }))
    ).json()) as { id: string };
    expect(me2.id).toBe(user.id);
    tel.stop();
    expect(tel.events.filter((e) => e.t === 'req').length).toBeGreaterThanOrEqual(5);
  });
});
