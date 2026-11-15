import {
  captureTelemetry,
  createWorkerHandler,
  resetPlatform,
  useTestBindings,
} from '@ericminassian/platform/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/worker.ts';

// The worker as Lambda runs it, fed an SQS batch the way the queue delivers one.
const EMAILS_ARN = 'arn:aws:sqs:us-east-1:000000000000:template-app--test--emails';

const record = (messageId: string, body: unknown) => ({
  messageId,
  body: JSON.stringify(body),
  eventSource: 'aws:sqs',
  eventSourceARN: EMAILS_ARN,
  attributes: { ApproximateReceiveCount: '1', SentTimestamp: String(Date.now()) },
});

describe('worker', () => {
  let telemetry: ReturnType<typeof captureTelemetry>;
  beforeEach(() => {
    useTestBindings({
      app: 'template-app',
      queues: { emails: { url: 'https://sqs/emails', arn: EMAILS_ARN } },
    });
    telemetry = captureTelemetry();
  });
  afterEach(() => {
    telemetry.stop();
    resetPlatform();
  });

  it('sends emails and retries a message that no longer matches EmailJob', async () => {
    const handler = createWorkerHandler(worker);
    const result = await handler(
      {
        Records: [
          record('ok', { to: 'alice@example.com', subject: 'New todo', body: 'Buy milk' }),
          record('stale', { recipient: 'alice@example.com' }),
        ],
      },
      {},
    );

    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: 'stale' }] });
    const metric = telemetry.events.find((e) => e.t === 'metric');
    expect(metric).toMatchObject({ name: 'emails.sent', value: 1 });
    const log = telemetry.events.find((e) => e.t === 'log');
    expect(log).toMatchObject({
      level: 'info',
      msg: 'would send email',
      to: 'alice@example.com',
      attempt: 1,
    });
    const jobs = telemetry.events.flatMap((e) => (e.t === 'job' ? [e.status] : []));
    expect(jobs).toEqual(['ok', 'error']);
  });
});
