import {
  captureEmails,
  captureTelemetry,
  createWorkerHandler,
  resetPlatform,
  useTestBindings,
} from '@ericminassian/platform/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/worker.ts';

// The worker as Lambda runs it, fed an SQS batch the way the queue delivers one.
// `captureEmails` records what `Email.send` sends instead of delivering it.
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
  let emails: ReturnType<typeof captureEmails>;
  beforeEach(() => {
    useTestBindings({
      app: 'template-app',
      queues: { emails: { url: 'https://sqs/emails', arn: EMAILS_ARN } },
      email: {
        mode: 'local',
        from: 'template-app--test@mail.localhost',
        name: 'Todo',
        tenant: 'template-app--test',
        dailyLimit: 50,
        usageTable: 'platform-telemetry',
      },
    });
    telemetry = captureTelemetry();
    emails = captureEmails();
  });
  afterEach(() => {
    emails.stop();
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
    expect(emails.sent).toEqual([
      expect.objectContaining({
        from: '"Todo" <template-app--test@mail.localhost>',
        to: ['alice@example.com'],
        subject: 'New todo',
        text: 'Buy milk',
      }),
    ]);
    const metric = telemetry.events.find((e) => e.t === 'metric');
    expect(metric).toMatchObject({ name: 'emails.sent', value: 1 });
    const jobs = telemetry.events.flatMap((e) => (e.t === 'job' ? [e.status] : []));
    expect(jobs).toEqual(['ok', 'error']);
  });

  it('retries a message whose email was refused', async () => {
    const handler = createWorkerHandler(worker);
    const result = await handler(
      { Records: [record('bad', { to: 'not-an-address', subject: 'x', body: 'y' })] },
      {},
    );
    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: 'bad' }] });
    expect(emails.sent).toEqual([]);
    const error = telemetry.events.find((e) => e.t === 'err');
    expect(error).toMatchObject({
      name: 'EmailNotSent',
      message: expect.stringContaining('not an email address') as unknown,
    });
  });
});
