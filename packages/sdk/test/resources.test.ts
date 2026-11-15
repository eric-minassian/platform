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
      queues: { emails: { url: 'https://sqs/emails', arn: 'arn:q' } },
      bus: { name: 'todo--test', arn: 'arn:bus' },
      storage: { bucket: 'storage-bucket', prefix: 'todo/test/', stores: ['uploads'] },
    });
    tel = captureTelemetry();
  });
  afterEach(() => {
    tel.stop();
    resetPlatform();
  });

  it('sends queue messages with a trace attribute and batches by 10', async () => {
    const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
    mockClient('sqs', (cmd) => {
      calls.push({ name: cmd.constructor.name, input: cmd.input });
      return {};
    });
    await queue('emails').send({ to: 'a' }, { delaySeconds: 5 });
    expect(calls[0]!.input).toMatchObject({
      QueueUrl: 'https://sqs/emails',
      MessageBody: '{"to":"a"}',
      DelaySeconds: 5,
    });
    expect(
      (calls[0]!.input.MessageAttributes as { trace: { StringValue: string } }).trace.StringValue,
    ).toMatch(/^[0-9a-f]{32}$/);
    await queue('emails').sendBatch(Array.from({ length: 23 }, (_, i) => i));
    expect(calls.slice(1).map((c) => (c.input.Entries as unknown[]).length)).toEqual([10, 10, 3]);
    await expect(queue('nope').send(1)).rejects.toThrow(/Declared queues: emails/);
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
