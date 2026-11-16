import {
  captureEmails,
  captureJobs,
  captureTelemetry,
  createWorkerHandler,
  queueJob,
  resetPlatform,
  useTestBindings,
} from '@ericminassian/platform/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/worker.ts';

// The worker as Lambda runs it, fed queue messages the way the platform delivers them.
// `captureEmails` records what `Email.send` sends instead of delivering it, and `captureJobs`
// what a failed run schedules (a retry) or dead-letters instead of reaching AWS.
describe('worker', () => {
  let telemetry: ReturnType<typeof captureTelemetry>;
  let emails: ReturnType<typeof captureEmails>;
  let jobs: ReturnType<typeof captureJobs>;
  beforeEach(() => {
    useTestBindings({
      app: 'template-app',
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
    jobs = captureJobs();
  });
  afterEach(() => {
    emails.stop();
    telemetry.stop();
    resetPlatform();
  });

  it('sends emails, and retries a message that no longer matches EmailJob', async () => {
    const handler = createWorkerHandler(worker);
    await handler(queueJob('emails', { to: 'alice@example.com', subject: 'New todo', body: 'Buy milk' }), {});
    await handler(queueJob('emails', { recipient: 'alice@example.com' }), {});

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
    const runs = telemetry.events.flatMap((e) => (e.t === 'job' ? [e.status] : []));
    expect(runs).toEqual(['ok', 'error']);
    // The failed run's next attempt is scheduled about a minute out.
    expect(jobs.scheduled.map((s) => s.job)).toMatchObject([{ name: 'emails', attempt: 2 }]);
  });

  it('dead-letters a message whose email was refused on every attempt', async () => {
    const handler = createWorkerHandler(worker);
    await handler(queueJob('emails', { to: 'not-an-address', subject: 'x', body: 'y' }, 5), {});
    expect(emails.sent).toEqual([]);
    expect(jobs.dead).toMatchObject([
      { job: { name: 'emails', attempt: 5 }, error: { name: 'EmailNotSent' } },
    ]);
    const error = telemetry.events.find((e) => e.t === 'err');
    expect(error).toMatchObject({
      name: 'EmailNotSent',
      message: expect.stringContaining('not an email address') as unknown,
    });
  });
});
