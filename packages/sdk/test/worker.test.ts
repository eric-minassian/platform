import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorkerHandler, invokeJob } from '../src/runtime/worker.ts';
import { captureTelemetry, mockClient, resetPlatform, useTestBindings } from '../src/testing.ts';

const QUEUE_ARN = 'arn:aws:sqs:us-east-1:000000000000:app--test--emails';

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

describe('worker dispatch', () => {
  let tel: ReturnType<typeof captureTelemetry>;
  beforeEach(() => {
    useTestBindings({
      queues: { emails: { url: 'https://sqs/emails', arn: QUEUE_ARN } },
      worker: 'app--test--worker',
    });
    tel = captureTelemetry();
  });
  afterEach(() => {
    tel.stop();
    resetPlatform();
  });

  it('routes SQS records and reports partial batch failures', async () => {
    const seen: unknown[] = [];
    const handler = createWorkerHandler({
      queues: {
        emails: (msg, ctx) => {
          seen.push({ body: msg.body, attempt: msg.attempt, trace: ctx.trace });
          if ((msg.body as { fail?: boolean }).fail) throw new Error('boom');
        },
      },
    });
    const out = await handler(
      { Records: [sqsRecord('m1', { to: 'a' }), sqsRecord('m2', { fail: true })] },
      {},
    );
    expect(out).toEqual({ batchItemFailures: [{ itemIdentifier: 'm2' }] });
    expect(seen[0]).toEqual({ body: { to: 'a' }, attempt: 2, trace: 'a'.repeat(32) });
    const jobs = tel.events.filter((e) => e.t === 'job');
    expect(jobs.map((j) => (j as { status: string }).status)).toEqual(['ok', 'error']);
    expect(tel.events.find((e) => e.t === 'err')).toMatchObject({
      source: 'job',
      job: 'queue:emails',
      message: 'boom',
    });
  });

  it('fails records from unknown queues', async () => {
    const handler = createWorkerHandler({ queues: {} });
    const out = await handler({ Records: [sqsRecord('m1', {}, { eventSourceARN: 'arn:other' })] }, {});
    expect(out).toEqual({ batchItemFailures: [{ itemIdentifier: 'm1' }] });
  });

  it('routes EventBridge events with the envelope trace and rethrows failures', async () => {
    const got: unknown[] = [];
    const handler = createWorkerHandler({
      events: {
        'order.created': (evt, ctx) => {
          got.push({ detail: evt.detail, trace: ctx.trace });
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
    expect(got).toEqual([{ detail: { id: 7 }, trace: 'b'.repeat(32) }]);
    await expect(
      handler({ ...base, 'detail-type': 'order.failed', detail: { data: {} } }, {}),
    ).rejects.toThrow('nope');
    // Unknown types are ignored (no retries for events nobody handles).
    await expect(handler({ ...base, 'detail-type': 'other', detail: {} }, {})).resolves.toBeUndefined();
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
    await expect(handler({ __platform: 'cron', name: 'missing' }, {})).rejects.toThrow(/no cron handler/);
    const job = tel.events.find((e) => e.t === 'job' && (e as { kind: string }).kind === 'invoke');
    expect(job).toMatchObject({ name: 'add', status: 'ok' });
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
    const body = JSON.parse(new TextDecoder().decode(calls[0]!.Payload as Uint8Array));
    expect(body).toMatchObject({ __platform: 'invoke', name: 'deploy', payload: { id: 'd1' } });
    expect(body.trace).toMatch(/^[0-9a-f]{32}$/);
  });
});
