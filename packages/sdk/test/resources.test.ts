import { DEV_UPLOAD_PATH, DEV_UPLOAD_RELAY_ENV } from '@ericminassian/platform-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newContext, runWithContext } from '../src/runtime/context.ts';
import { events } from '../src/runtime/events.ts';
import { queue } from '../src/runtime/queue.ts';
import { secrets } from '../src/runtime/secrets.ts';
import { storage } from '../src/runtime/storage.ts';
import { log, metrics, span } from '../src/runtime/telemetry.ts';
import { captureTelemetry, mockClient, resetPlatform, useTestBindings } from '../src/testing.ts';

describe('queue / events / storage / secrets', () => {
  let tel: ReturnType<typeof captureTelemetry>;
  beforeEach(() => {
    useTestBindings({
      app: 'todo',
      worker: 'todo--test--worker',
      jobs: {
        queues: ['emails', 'slow'],
        fns: { 'queue:slow': 'todo--test--worker--queue-slow' },
        attempts: {},
        dead: 'https://sqs.us-east-1.amazonaws.com/000000000000/todo--test--jobs--dead',
        group: 'todo--test',
        role: 'arn:aws:iam::000000000000:role/platform/apps/todo--test',
      },
      bus: { name: 'todo--test', arn: 'arn:bus' },
      storage: { bucket: 'storage-bucket', prefix: 'todo/test/', stores: ['uploads'] },
    });
    tel = captureTelemetry();
  });
  afterEach(() => {
    tel.stop();
    resetPlatform();
  });

  it('sends a queue message as an async invoke of the function its handler runs in', async () => {
    const invokes: Record<string, unknown>[] = [];
    mockClient('lambda', (cmd) => {
      invokes.push(cmd.input);
      return { StatusCode: 202 };
    });
    await queue('emails').send({ to: 'a' });
    expect(invokes[0]).toMatchObject({ FunctionName: 'todo--test--worker', InvocationType: 'Event' });
    const job = JSON.parse(new TextDecoder().decode(invokes[0]!.Payload as Uint8Array)) as Record<
      string,
      unknown
    >;
    expect(job).toMatchObject({
      __platform: 'job',
      kind: 'queue',
      name: 'emails',
      attempt: 1,
      body: { to: 'a' },
    });
    expect(job.trace).toMatch(/^[0-9a-f]{32}$/);
    expect(job.id).toMatch(/^m[0-9a-z]{26}$/);

    await queue('slow').sendBatch(Array.from({ length: 23 }, (_, i) => i));
    expect(invokes.slice(1).map((i) => i.FunctionName)).toEqual(
      Array(23).fill('todo--test--worker--queue-slow'),
    );

    await expect(queue('nope').send(1)).rejects.toThrow(/Declared queues: emails, slow/);
    await expect(queue('emails').send('x'.repeat(250 * 1024))).rejects.toThrow(/over the 240 KB limit/);
  });

  it('sends a delayed message as a one-shot schedule, at least a minute out', async () => {
    const schedules: Record<string, unknown>[] = [];
    mockClient('scheduler', (cmd) => {
      schedules.push(cmd.input);
      return {};
    });
    const before = Date.now();
    await queue('emails').send({ to: 'a' }, { delaySeconds: 3600 });
    await queue('emails').send({ to: 'b' }, { delaySeconds: 5 });
    const [hour, soon] = schedules as Array<{
      Name: string;
      GroupName: string;
      ScheduleExpression: string;
      ActionAfterCompletion: string;
      Target: { Arn: string; RoleArn: string; Input: string; DeadLetterConfig: { Arn: string } };
    }>;
    expect(hour!.Name).toMatch(/^_q-emails-[0-9a-z]{26}$/);
    expect(hour).toMatchObject({ GroupName: 'todo--test', ActionAfterCompletion: 'DELETE' });
    expect(hour!.Target).toMatchObject({
      Arn: 'arn:aws:lambda:us-east-1:000000000000:function:todo--test--worker',
      RoleArn: 'arn:aws:iam::000000000000:role/platform/apps/todo--test',
      DeadLetterConfig: { Arn: 'arn:aws:sqs:us-east-1:000000000000:todo--test--jobs--dead' },
    });
    expect(JSON.parse(hour!.Target.Input)).toMatchObject({
      kind: 'queue',
      name: 'emails',
      body: { to: 'a' },
    });
    const at = (expr: string) => Date.parse(`${expr.slice(3, -1)}Z`);
    expect(at(hour!.ScheduleExpression)).toBeGreaterThanOrEqual(before + 3_599_000);
    // Scheduler fires within about a minute and refuses past times: short delays wait a minute.
    expect(at(soon!.ScheduleExpression)).toBeGreaterThanOrEqual(before + 59_000);
    await expect(queue('emails').send({}, { delaySeconds: -1 })).rejects.toThrow(/delaySeconds/);
  });

  it('publishes events in an envelope and surfaces failures', async () => {
    const inputs: Record<string, unknown>[] = [];
    let fail = false;
    mockClient('events', (cmd) => {
      inputs.push(cmd.input);
      return fail ? { FailedEntryCount: 1, Entries: [{ ErrorCode: 'Throttled' }] } : { FailedEntryCount: 0 };
    });
    await events.publish('order.created', { id: 1 });
    const entry = (inputs[0]!.Entries as Record<string, string>[])[0]!;
    expect(entry).toMatchObject({
      EventBusName: 'todo--test',
      Source: 'platform.todo',
      DetailType: 'order.created',
    });
    expect(JSON.parse(entry.Detail!)).toMatchObject({ data: { id: 1 } });
    fail = true;
    await expect(events.publish('x', {})).rejects.toThrow(/Throttled/);
  });

  it('scopes storage keys under the store prefix', async () => {
    const inputs: Array<{ name: string; input: Record<string, unknown> }> = [];
    mockClient('s3', (cmd) => {
      inputs.push({ name: cmd.constructor.name, input: cmd.input });
      if (cmd.constructor.name === 'GetObjectCommand') {
        const err = Object.assign(new Error('missing'), { name: 'NoSuchKey' });
        throw err;
      }
      if (cmd.constructor.name === 'ListObjectsV2Command') {
        return { Contents: [{ Key: 'todo/test/uploads/a/b.txt', Size: 3 }], NextContinuationToken: 'n' };
      }
      return {};
    });
    const s = storage('uploads');
    await s.put('/a/b.txt', 'hey', { contentType: 'text/plain' });
    expect(inputs[0]!.input).toMatchObject({
      Bucket: 'storage-bucket',
      Key: 'todo/test/uploads/a/b.txt',
      ContentType: 'text/plain',
    });
    expect(await s.get('missing.txt')).toBeUndefined();
    expect(await s.list('a/')).toEqual({ objects: [{ key: 'a/b.txt', size: 3 }], cursor: 'n' });
    await expect(s.put('../escape', 'x')).rejects.toThrow(/Invalid storage key/);
    await expect(storage('other').get('x')).rejects.toThrow(/Declared storage: uploads/);
    expect(() => s.publicUrl('a.png')).toThrow(/Store "uploads" isn't public/);
  });

  it('keeps public stores under their own prefix and names their edge URLs', async () => {
    useTestBindings({
      app: 'atlas',
      url: 'https://atlas.example.com',
      storage: {
        bucket: 'storage-bucket',
        prefix: 'atlas/test/',
        stores: ['uploads', 'snapshots'],
        public: ['snapshots'],
        publicPrefix: '_public/atlas/test/',
      },
    });
    const inputs: Array<Record<string, unknown>> = [];
    mockClient('s3', (cmd) => {
      inputs.push(cmd.input);
      return {};
    });
    const snapshots = storage('snapshots');
    await snapshots.put('fires/1105.json', '{}', { cacheControl: 'public, max-age=31536000, immutable' });
    expect(inputs[0]).toMatchObject({
      Bucket: 'storage-bucket',
      Key: '_public/atlas/test/snapshots/fires/1105.json',
      ContentType: 'application/json; charset=utf-8',
      CacheControl: 'public, max-age=31536000, immutable',
    });
    await storage('uploads').put('raw', new Uint8Array([1]));
    expect(inputs[1]).toMatchObject({
      Key: 'atlas/test/uploads/raw',
      ContentType: 'application/octet-stream',
    });
    expect(inputs[1]).not.toHaveProperty('CacheControl');

    expect(snapshots.publicUrl('fires/today 1.json')).toBe(
      'https://atlas.example.com/__platform/storage/snapshots/fires/today%201.json',
    );
    expect(() => snapshots.publicUrl('a/../b')).toThrow(/can't be served/);
    expect(() => storage('uploads').publicUrl('a')).toThrow(/isn't public/);
  });

  it('hands out presigned upload URLs, through the router’s relay only under plat dev', async () => {
    // Presigning runs locally: a real client with throwaway credentials, no network.
    const saved = { id: process.env.AWS_ACCESS_KEY_ID, secret: process.env.AWS_SECRET_ACCESS_KEY };
    process.env.AWS_ACCESS_KEY_ID = 'AKIDEXAMPLE';
    process.env.AWS_SECRET_ACCESS_KEY = 'secret';
    try {
      const url = new URL(await storage('uploads').uploadUrl('covers/a.png', { contentType: 'image/png' }));
      expect(url.pathname).toContain('todo/test/uploads/covers/a.png');
      expect(url.searchParams.has('X-Amz-Signature')).toBe(true);

      // Under `plat dev`, the browser uploads through the router's relay, which forwards to that URL.
      useTestBindings({
        app: 'todo',
        url: 'http://todo.localhost:3000',
        storage: { bucket: 'storage-bucket', prefix: 'todo/local/', stores: ['uploads'] },
      });
      process.env[DEV_UPLOAD_RELAY_ENV] = '1';
      const relay = new URL(await storage('uploads').uploadUrl('covers/a.png', { contentType: 'image/png' }));
      expect(`${relay.origin}${relay.pathname}`).toBe(`http://todo.localhost:3000${DEV_UPLOAD_PATH}`);
      const to = new URL(relay.searchParams.get('to')!);
      expect(to.pathname).toContain('todo/local/uploads/covers/a.png');
      expect(to.searchParams.has('X-Amz-Signature')).toBe(true);
    } finally {
      delete process.env[DEV_UPLOAD_RELAY_ENV];
      if (saved.id === undefined) delete process.env.AWS_ACCESS_KEY_ID;
      else process.env.AWS_ACCESS_KEY_ID = saved.id;
      if (saved.secret === undefined) delete process.env.AWS_SECRET_ACCESS_KEY;
      else process.env.AWS_SECRET_ACCESS_KEY = saved.secret;
    }
  });

  it('reads secrets with shared fallback and caching', async () => {
    const names: string[] = [];
    mockClient('ssm', (cmd) => {
      const name = String(cmd.input.Name);
      names.push(name);
      if (name.includes('/_shared/') && name.endsWith('/API_KEY'))
        return { Parameter: { Value: 'shared-value' } };
      throw Object.assign(new Error('nf'), { name: 'ParameterNotFound' });
    });
    expect(await secrets.get('API_KEY')).toBe('shared-value');
    expect(await secrets.get('API_KEY')).toBe('shared-value');
    expect(names).toEqual([
      '/platform/apps/test-app/test/secrets/API_KEY',
      '/platform/apps/test-app/_shared/secrets/API_KEY',
    ]);
    expect(await secrets.getOptional('NOPE')).toBeUndefined();
    await expect(secrets.get('NOPE')).rejects.toThrow(/plat secrets set/);
  });
});

describe('telemetry', () => {
  afterEach(() => resetPlatform());

  it('emits well-formed metric, log, err and span lines', async () => {
    useTestBindings({ app: 'todo', stage: 'prod', revision: 'd9' });
    const tel = captureTelemetry();
    metrics.count('signup');
    metrics.value('order_total', 42.5, 'usd');
    log.info('hello', { user: 'u1' });
    log.error('failed', new TypeError('bad input'));
    await expect(
      runWithContext(newContext(), () =>
        span('fetch', 'GET x', async () => Promise.reject(new Error('down'))),
      ),
    ).rejects.toThrow('down');
    await span('db.get', 'outside', async () => 1); // no context → no span line
    tel.stop();
    const [count, value, info, errLog, err, sp] = tel.events;
    expect(count).toMatchObject({
      _p: 1,
      t: 'metric',
      name: 'signup',
      value: 1,
      app: 'todo',
      stage: 'prod',
      rev: 'd9',
    });
    expect(value).toMatchObject({ t: 'metric', name: 'order_total', value: 42.5, unit: 'usd' });
    expect(info).toMatchObject({ t: 'log', level: 'info', msg: 'hello', user: 'u1' });
    expect(errLog).toMatchObject({ t: 'log', level: 'error', msg: 'failed' });
    expect(err).toMatchObject({ t: 'err', source: 'log', name: 'TypeError', message: 'bad input' });
    expect((err as { fingerprint: string }).fingerprint).toMatch(/^[0-9a-f]{8}$/);
    expect(sp).toMatchObject({ t: 'span', op: 'fetch', name: 'GET x', status: 'error' });
    expect(tel.events).toHaveLength(6);
    for (const e of tel.events) expect(typeof e.ts).toBe('number');
  });

  it('never throws without bindings', () => {
    const tel = captureTelemetry();
    expect(() => metrics.count('x')).not.toThrow();
    tel.stop();
    expect(tel.events[0]).toMatchObject({ app: 'unknown', stage: 'unknown' });
  });
});
