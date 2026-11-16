import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createWorkerHandler,
  invokeJob,
  type PlatformEvent,
  type QueueMessage,
} from '../src/runtime/worker.ts';
import { captureTelemetry, mockClient, resetPlatform, useTestBindings } from '../src/testing.ts';

const QUEUE_ARN = 'arn:aws:sqs:us-east-1:000000000000:app--test--emails';
const DEAD = 'https://sqs.us-east-1.amazonaws.com/000000000000/app--test--jobs--dead';

function sqsRecord(id: string, body: unknown, extra: Record<string, unknown> = {}) {
  return {
    messageId: id,
    body: JSON.stringify(body),
    eventSource: 'aws:sqs',
    eventSourceARN: QUEUE_ARN,
    attributes: { ApproximateReceiveCount: '2', SentTimestamp: '1700000000000' },
    messageAttributes: { trace: { stringValue: 'a'.repeat(32), dataType: 'String' } },
    ...extra,
  };
}

function job(kind: 'queue' | 'event' | 'cron', name: string, attempt: number, extra: object = {}) {
  return { __platform: 'job', kind, name, id: `id-${name}`, attempt, sentAt: 1_700_000_000_000, ...extra };
}

describe('worker dispatch', () => {
  let tel: ReturnType<typeof captureTelemetry>;
  let scheduled: Array<Record<string, unknown>>;
  let dead: Array<Record<string, unknown>>;
  beforeEach(() => {
    useTestBindings({
      app: 'app',
      worker: 'app--test--worker',
      jobs: {
        queues: ['emails'],
        fns: { 'event:order.failed': 'app--test--worker--event-order_failed' },
        attempts: { 'queue:emails': 2 },
        dead: DEAD,
        group: 'app--test',
        role: 'arn:aws:iam::000000000000:role/platform/apps/app--test',
      },
    });
    tel = captureTelemetry();
    scheduled = [];
    dead = [];
    mockClient('scheduler', (cmd) => void scheduled.push(cmd.input));
    mockClient('sqs', (cmd) => void dead.push(cmd.input));
  });
  afterEach(() => {
    tel.stop();
    resetPlatform();
  });

  const jobLines = () => tel.events.filter((e) => e.t === 'job') as Array<Record<string, unknown>>;
  const input = (s: Record<string, unknown>) =>
    JSON.parse((s.Target as { Input: string }).Input) as Record<string, unknown>;

  it('runs a queue message, retries a failed one later, then dead-letters it', async () => {
    const seen: unknown[] = [];
    const handler = createWorkerHandler({
      queues: {
        emails: (msg: QueueMessage<{ to?: string; fail?: boolean }>, ctx) => {
          seen.push({ id: msg.id, body: msg.body, attempt: msg.attempt, trace: ctx.trace });
          if (msg.body.fail) throw new Error('boom');
        },
      },
    });
    await expect(
      handler(job('queue', 'emails', 1, { body: { to: 'a' }, trace: 'a'.repeat(32) }), {}),
    ).resolves.toBeUndefined();
    expect(seen[0]).toEqual({ id: 'id-emails', body: { to: 'a' }, attempt: 1, trace: 'a'.repeat(32) });

    // Attempt 1 of 2 fails: attempt 2 is scheduled a minute out on the same function.
    await expect(handler(job('queue', 'emails', 1, { body: { fail: true } }), {})).resolves.toBeUndefined();
    expect(scheduled[0]).toMatchObject({ GroupName: 'app--test', ActionAfterCompletion: 'DELETE' });
    expect(scheduled[0]!.Name).toMatch(/^_q-emails-/);
    expect((scheduled[0]!.Target as { Arn: string }).Arn).toBe(
      'arn:aws:lambda:us-east-1:000000000000:function:app--test--worker',
    );
    expect(input(scheduled[0]!)).toMatchObject({ id: 'id-emails', attempt: 2, body: { fail: true } });

    // Attempt 2 of 2 fails: the job goes to the dead-letter queue, and the invocation still succeeds.
    await expect(handler(job('queue', 'emails', 2, { body: { fail: true } }), {})).resolves.toBeUndefined();
    expect(dead[0]!.QueueUrl).toBe(DEAD);
    expect(JSON.parse(dead[0]!.MessageBody as string)).toMatchObject({
      v: 1,
      job: { kind: 'queue', name: 'emails', attempt: 2 },
      error: { name: 'Error', message: 'boom' },
    });
    expect(jobLines().map((j) => [j.status, j.attempt, j.next])).toEqual([
      ['ok', 1, undefined],
      ['error', 1, 'retry'],
      ['error', 2, 'dead'],
    ]);
    expect(tel.events.find((e) => e.t === 'err')).toMatchObject({
      source: 'job',
      job: 'queue:emails',
      message: 'boom',
    });
  });

  it('fails the invocation when the next attempt can’t be scheduled, so Lambda retries it', async () => {
    mockClient('scheduler', () => {
      throw new Error('throttled');
    });
    const handler = createWorkerHandler({
      queues: {
        emails: () => {
          throw new Error('boom');
        },
      },
    });
    await expect(handler(job('queue', 'emails', 1, { body: {} }), {})).rejects.toThrow('throttled');
    expect(jobLines()).toMatchObject([{ status: 'error', attempt: 1 }]);
    expect(jobLines()[0]!.next).toBeUndefined();
  });

  it('dead-letters a job whose handler is gone', async () => {
    await createWorkerHandler({})(job('queue', 'emails', 1, { body: {} }), {});
    expect(JSON.parse(dead[0]!.MessageBody as string)).toMatchObject({ error: { name: 'NoHandler' } });
  });

  it('runs EventBridge events as jobs, retrying failures on the handler’s own function', async () => {
    const got: unknown[] = [];
    const handler = createWorkerHandler({
      events: {
        'order.created': (evt: PlatformEvent, ctx) => {
          got.push({ id: evt.id, detail: evt.detail, trace: ctx.trace, time: evt.time.toISOString() });
        },
        'order.failed': () => {
          throw new Error('nope');
        },
      },
    });
    const base = { id: 'e1', source: 'platform.app', time: '2026-01-01T00:00:00Z' };
    await handler(
      { ...base, 'detail-type': 'order.created', detail: { data: { id: 7 }, trace: 'b'.repeat(32) } },
      {},
    );
    expect(got).toEqual([
      { id: 'e1', detail: { id: 7 }, trace: 'b'.repeat(32), time: '2026-01-01T00:00:00.000Z' },
    ]);
    await expect(
      handler({ ...base, 'detail-type': 'order.failed', detail: { data: {} } }, {}),
    ).resolves.toBeUndefined();
    expect(scheduled[0]!.Name).toMatch(/^_e-[0-9a-f]{8}-/);
    expect((scheduled[0]!.Target as { Arn: string }).Arn).toMatch(
      /function:app--test--worker--event-order_failed$/,
    );
    expect(input(scheduled[0]!)).toMatchObject({ kind: 'event', name: 'order.failed', id: 'e1', attempt: 2 });
  });

  it('drains a queue created before 0.4.0, reporting partial batch failures', async () => {
    const seen: unknown[] = [];
    const handler = createWorkerHandler({
      queues: {
        emails: (msg: QueueMessage<{ to?: string; fail?: boolean }>, ctx) => {
          seen.push({ body: msg.body, attempt: msg.attempt, trace: ctx.trace });
          if (msg.body.fail) throw new Error('boom');
        },
      },
    });
    const out = await handler(
      { Records: [sqsRecord('m1', { to: 'a' }), sqsRecord('m2', { fail: true })] },
      {},
    );
    expect(out).toEqual({ batchItemFailures: [{ itemIdentifier: 'm2' }] });
    expect(seen[0]).toEqual({ body: { to: 'a' }, attempt: 2, trace: 'a'.repeat(32) });
    const other = await handler({ Records: [sqsRecord('m3', {}, { eventSourceARN: 'arn:other' })] }, {});
    expect(other).toEqual({ batchItemFailures: [{ itemIdentifier: 'm3' }] });
  });

  it('runs crons and returns invoke results', async () => {
    let ran = false;
    const handler = createWorkerHandler({
      crons: {
        nightly: () => {
          ran = true;
        },
      },
      invoke: { add: (p: { a: number; b: number }) => p.a + p.b },
    });
    await handler({ __platform: 'cron', name: 'nightly' }, { getRemainingTimeInMillis: () => 1000 });
    expect(ran).toBe(true);
    expect(await handler({ __platform: 'invoke', name: 'add', payload: { a: 2, b: 3 } }, {})).toBe(5);
    await expect(handler({ __platform: 'invoke', name: 'missing', payload: {} }, {})).rejects.toThrow(
      /no invoke handler/,
    );
    const line = tel.events.find((e) => e.t === 'job' && (e as { kind: string }).kind === 'invoke');
    expect(line).toMatchObject({ name: 'add', status: 'ok' });
  });

  it('decodes CloudWatch Logs subscription batches', async () => {
    const batches: unknown[] = [];
    const handler = createWorkerHandler({ logs: (b) => void batches.push(b) });
    const payload = {
      messageType: 'DATA_MESSAGE',
      logGroup: '/platform/apps/x/prod/web',
      logStream: 's',
      logEvents: [{ id: '1', timestamp: 1, message: '{"_p":1}' }],
    };
    await handler({ awslogs: { data: gzipSync(JSON.stringify(payload)).toString('base64') } }, {});
    expect(batches).toEqual([{ logGroup: payload.logGroup, logStream: 's', logEvents: payload.logEvents }]);
    const control = { ...payload, messageType: 'CONTROL_MESSAGE' };
    await handler({ awslogs: { data: gzipSync(JSON.stringify(control)).toString('base64') } }, {});
    expect(batches).toHaveLength(1);
  });

  it('rejects unrecognized events', async () => {
    await expect(createWorkerHandler({})({ hello: 1 }, {})).rejects.toThrow(/Unrecognized/);
  });

  it('invokeJob sends an async invoke payload to the worker', async () => {
    const calls: Record<string, unknown>[] = [];
    mockClient('lambda', (cmd) => {
      calls.push(cmd.input);
      return { StatusCode: 202 };
    });
    await invokeJob('deploy', { id: 'd1' });
    expect(calls[0]).toMatchObject({ FunctionName: 'app--test--worker', InvocationType: 'Event' });
    const body = JSON.parse(new TextDecoder().decode(calls[0]!.Payload as Uint8Array)) as { trace: string };
    expect(body).toMatchObject({ __platform: 'invoke', name: 'deploy', payload: { id: 'd1' } });
    expect(body.trace).toMatch(/^[0-9a-f]{32}$/);
  });
});
