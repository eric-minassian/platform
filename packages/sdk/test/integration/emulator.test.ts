import {
  CognitoIdentityProviderClient,
  CreateUserPoolClientCommand,
  CreateUserPoolCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  UpdateTimeToLiveCommand,
} from '@aws-sdk/client-dynamodb';
import {
  CreateEventBusCommand,
  EventBridgeClient,
  PutRuleCommand,
  PutTargetsCommand,
} from '@aws-sdk/client-eventbridge';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SetQueueAttributesCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { PutParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { BINDINGS_ENV, type Bindings, encodeBindings } from '@eric-minassian/platform-core';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setBindings } from '../../src/bindings.ts';
import { auth, db, events, queue, secrets, storage } from '../../src/index.ts';
import { captureTelemetry, createPlatformFetch, resetPlatform } from '../../src/testing.ts';

const region = process.env.AWS_REGION ?? 'us-east-1';
const endpoint = process.env.AWS_ENDPOINT_URL;
const cfg = { region, ...(endpoint ? { endpoint } : {}) };
const id = Date.now().toString(36);
const APP = `it${id}`;
const STAGE = 'test';
const base = `${APP}--${STAGE}`;

let bindings: Bindings;
let eventsTargetUrl = '';
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
  expect(endpoint, 'integration tests need the AWS Emulator (see setup.ts)').toBeTruthy();
  const ddb = new DynamoDBClient(cfg);
  const sqs = new SQSClient(cfg);
  const eb = new EventBridgeClient(cfg);
  const s3 = new S3Client({ ...cfg, forcePathStyle: true });
  const ssm = new SSMClient(cfg);
  const cognito = new CognitoIdentityProviderClient(cfg);

  await createTable(ddb, base);

  const emails = await sqs.send(new CreateQueueCommand({ QueueName: `${base}--emails` }));
  const emailsArn = await queueArn(sqs, emails.QueueUrl!);
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
    v: 1,
    app: APP,
    stage: STAGE,
    host: `${APP}--${STAGE}.localhost`,
    url: `http://${APP}--${STAGE}.localhost:3000`,
    revision: 'dlocal',
    region,
    table: base,
    queues: { emails: { url: emails.QueueUrl!, arn: emailsArn } },
    bus: { name: base, arn: bus.EventBusArn! },
    storage: { bucket, prefix: `${APP}/${STAGE}/`, stores: ['uploads'] },
    secrets: { path: secretsPath, sharedPath, names: ['STAGE_ONLY', 'SHARED'] },
    auth: {
      mode: 'local',
      userPoolId: poolId,
      clientId: appClient.UserPoolClient!.ClientId!,
      issuer: `https://cognito-idp.${region}.amazonaws.com/${poolId}`,
      jwksUri: `${endpoint!.replace(/\/$/, '')}/${poolId}/.well-known/jwks.json`,
      loginUrl: 'http://unused.localhost',
      required: false,
    },
  };
  process.env[BINDINGS_ENV] = encodeBindings(bindings);
  process.env.PLATFORM_LOCAL = '1';
  setBindings(undefined);
});

afterAll(() => resetPlatform());

interface Note extends Record<string, unknown> {
  ownerId: string;
  noteId: string;
  title: string;
  tag?: string;
  createdAt: string;
}

const notes = () =>
  db.collection<Note>('notes', {
    partition: 'ownerId',
    sort: 'noteId',
    indexes: { byTag: { slot: 1, partition: 'tag', sort: 'createdAt' } },
  });

describe('against the AWS Emulator', () => {
  it('db: put/get/query/index/update/delete', async () => {
    await notes().put({ ownerId: 'u1', noteId: 'n1', title: 'one', tag: 'work', createdAt: '2026-01-01' });
    await notes().put({ ownerId: 'u1', noteId: 'n2', title: 'two', tag: 'home', createdAt: '2026-01-02' });
    await notes().put({ ownerId: 'u1', noteId: 'n3', title: 'three', tag: 'work', createdAt: '2026-01-03' });
    await notes().put({ ownerId: 'u2', noteId: 'n1', title: 'other user', createdAt: '2026-01-01' });

    expect(await notes().get({ ownerId: 'u1', noteId: 'n2' })).toEqual({
      ownerId: 'u1',
      noteId: 'n2',
      title: 'two',
      tag: 'home',
      createdAt: '2026-01-02',
    });
    const all = await notes().query({ ownerId: 'u1' });
    expect(all.items.map((n) => n.noteId)).toEqual(['n1', 'n2', 'n3']);

    const page1 = await notes().query({ ownerId: 'u1' }, { limit: 2, reverse: true });
    expect(page1.items.map((n) => n.noteId)).toEqual(['n3', 'n2']);
    const page2 = await notes().query({ ownerId: 'u1' }, { limit: 2, reverse: true, cursor: page1.cursor });
    expect(page2.items.map((n) => n.noteId)).toEqual(['n1']);

    const work = await notes().query({ tag: 'work' }, { index: 'byTag', gte: '2026-01-02' });
    expect(work.items.map((n) => n.noteId)).toEqual(['n3']);

    const updated = await notes().update({ ownerId: 'u1', noteId: 'n3' }, { tag: 'home', title: 'moved' });
    expect(updated).toMatchObject({ title: 'moved', tag: 'home' });
    const home = await notes().query({ tag: 'home' }, { index: 'byTag' });
    expect(home.items.map((n) => n.noteId).sort()).toEqual(['n2', 'n3']);

    await expect(
      notes().put({ ownerId: 'u1', noteId: 'n1', title: 'dup', createdAt: 'x' }, { ifNotExists: true }),
    ).rejects.toThrow();
    await expect(notes().update({ ownerId: 'u9', noteId: 'nx' }, { title: 'nope' })).rejects.toThrow();
    await notes().delete({ ownerId: 'u1', noteId: 'n1' });
    expect(await notes().get({ ownerId: 'u1', noteId: 'n1' })).toBeUndefined();
  });

  it('queue: send carries the body and trace', async () => {
    await queue('emails').send({ to: 'eric@example.com' });
    const sqs = new SQSClient(cfg);
    const out = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: bindings.queues.emails!.url,
        MessageAttributeNames: ['All'],
        WaitTimeSeconds: 2,
      }),
    );
    const m = out.Messages?.[0];
    expect(JSON.parse(m!.Body!)).toEqual({ to: 'eric@example.com' });
    expect(m!.MessageAttributes?.trace?.StringValue).toMatch(/^[0-9a-f]{32}$/);
  });

  it('events: publish reaches a subscribed rule target', async () => {
    await events.publish('order.created', { orderId: 42 });
    const sqs = new SQSClient(cfg);
    let body: { 'detail-type': string; source: string; detail: { data: unknown; trace: string } } | undefined;
    for (let i = 0; i < 10 && !body; i++) {
      const out = await sqs.send(
        new ReceiveMessageCommand({ QueueUrl: eventsTargetUrl, WaitTimeSeconds: 1 }),
      );
      if (out.Messages?.[0]) body = JSON.parse(out.Messages[0].Body!);
    }
    expect(body).toMatchObject({
      'detail-type': 'order.created',
      source: `platform.${APP}`,
      detail: { data: { orderId: 42 } },
    });
  });

  it('storage: put/get/list and presigned upload/download URLs', async () => {
    const s = storage('uploads');
    await s.put('docs/hello.txt', 'hello world', { contentType: 'text/plain' });
    expect(await s.getText('docs/hello.txt')).toBe('hello world');
    expect(await s.get('docs/missing.txt')).toBeUndefined();
    expect((await s.list('docs/')).objects.map((o) => o.key)).toEqual(['docs/hello.txt']);

    const put = await fetch(await s.uploadUrl('direct.bin', { contentType: 'application/octet-stream' }), {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: new Uint8Array([1, 2, 3]),
    });
    expect(put.status).toBe(200);
    expect(await s.get('direct.bin')).toEqual(new Uint8Array([1, 2, 3]));
    const dl = await fetch(await s.downloadUrl('docs/hello.txt'));
    expect(await dl.text()).toBe('hello world');
    await s.delete('direct.bin');
    expect(await s.get('direct.bin')).toBeUndefined();
  });

  it('secrets: stage value wins, shared is the fallback', async () => {
    expect(await secrets.get('STAGE_ONLY')).toBe('stage-value');
    expect(await secrets.get('SHARED')).toBe('shared-value');
    expect(await secrets.getOptional('MISSING')).toBeUndefined();
  });

  it('auth (local mode): sign in through the form, then resolve the user', async () => {
    const tel = captureTelemetry();
    const h = new Hono();
    h.get('/api/whoami', async (c) => c.json(await auth.requireUser(c.req.raw)));
    const f = createPlatformFetch(h);
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
