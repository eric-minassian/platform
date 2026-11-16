import { describe, expect, it } from 'vitest';
import {
  atExpression,
  type DeadLetter,
  isJobSchedule,
  type JobPayload,
  jobScheduleName,
  jobSchedulePrefix,
  readDeadLetter,
  retryDelaySeconds,
  toJob,
} from '../src/index.ts';

const job: JobPayload = {
  __platform: 'job',
  kind: 'queue',
  name: 'emails',
  id: 'm01',
  attempt: 3,
  sentAt: 1_700_000_000_000,
  body: { to: 'a@b.c' },
  trace: 't1',
};

describe('jobs', () => {
  it('backs off 1, 2, 4 … minutes, at most an hour', () => {
    expect([1, 2, 3, 4, 7, 20].map(retryDelaySeconds)).toEqual([60, 120, 240, 480, 3600, 3600]);
  });

  it('names schedules within Scheduler’s 64 chars, by queue and cron', () => {
    const id = '01k0000000000000000000000z';
    expect(jobScheduleName('queue', 'emails', id)).toBe(`q-emails-${id}`);
    expect(jobScheduleName('cron', 'nightly', id)).toBe(`c-nightly-${id}`);
    expect(jobScheduleName('queue', 'q'.repeat(20), id).length).toBeLessThanOrEqual(64);
    const event = jobScheduleName('event', `order:${'x'.repeat(60)}`, id);
    expect(event).toMatch(/^e-[0-9a-f]{8}-/);
    expect(event.length).toBeLessThanOrEqual(64);
    expect(event.startsWith(jobSchedulePrefix('event', `order:${'x'.repeat(60)}`))).toBe(true);
    // Crons' own schedules are the cron key; services' stop schedules contain `--`.
    expect(isJobSchedule(`q-emails-${id}`)).toBe(true);
    expect(isJobSchedule('nightly')).toBe(false);
    expect(isJobSchedule('firehose--stop')).toBe(false);
  });

  it('writes one-shot expressions in UTC to the second', () => {
    expect(atExpression(new Date('2026-11-16T10:20:30.456Z'))).toBe('at(2026-11-16T10:20:30)');
  });

  it('reads jobs, EventBridge events and cron firings as jobs', () => {
    expect(toJob(job, 'x', 1)).toBe(job);
    expect(toJob({ __platform: 'cron', name: 'nightly', trace: 't' }, 'req1', 5)).toEqual({
      __platform: 'job',
      kind: 'cron',
      name: 'nightly',
      id: 'req1',
      attempt: 1,
      sentAt: 5,
      trace: 't',
    });
    const event = {
      id: 'ev1',
      'detail-type': 'order.created',
      source: 'todo',
      time: '2026-11-16T10:00:00Z',
      detail: { data: { n: 1 }, trace: 't2' },
    };
    expect(toJob(event, 'x', 5)).toEqual({
      __platform: 'job',
      kind: 'event',
      name: 'order.created',
      id: 'ev1',
      attempt: 1,
      sentAt: Date.parse('2026-11-16T10:00:00Z'),
      detail: { n: 1 },
      trace: 't2',
    });
    // An event published by something other than the SDK keeps its detail as is.
    expect(toJob({ ...event, detail: { n: 2 } }, 'x', 5)?.detail).toEqual({ n: 2 });
    expect(toJob({ __platform: 'invoke', name: 'deploy', payload: {} }, 'x', 5)).toBeUndefined();
    expect(toJob('nope', 'x', 5)).toBeUndefined();
  });

  it('reads the SDK’s dead letters, ready to redrive from the first attempt', () => {
    const letter: DeadLetter = { v: 1, job, failedAt: 9, error: { name: 'Boom', message: 'no' } };
    expect(readDeadLetter(JSON.stringify(letter))).toEqual({
      kind: 'queue',
      name: 'emails',
      attempts: 3,
      error: { name: 'Boom', message: 'no' },
      failedAt: 9,
      source: 'sdk',
      redrive: { ...job, attempt: 1 },
    });
  });

  it('reads Lambda’s on-failure records: a crash, and an event that waited too long', () => {
    const record = (requestPayload: unknown, extra: object) =>
      JSON.stringify({
        version: '1.0',
        timestamp: '2026-11-16T10:00:00.000Z',
        requestContext: { requestId: 'r', functionArn: 'arn:fn', approximateInvokeCount: 3, ...extra },
        requestPayload,
        responseContext: { statusCode: 200, functionError: 'Unhandled' },
        responsePayload: { errorType: 'Runtime.ExitError', errorMessage: 'exited' },
      });
    const crash = readDeadLetter(record(job, { condition: 'RetriesExhausted' }));
    expect(crash).toMatchObject({
      kind: 'queue',
      name: 'emails',
      attempts: 3,
      source: 'lambda',
      error: { name: 'Runtime.ExitError', message: 'exited' },
      failedAt: Date.parse('2026-11-16T10:00:00Z'),
      redrive: { ...job, attempt: 1 },
    });

    const old = JSON.parse(record({ __platform: 'invoke', name: 'deploy', payload: { id: 'd1' } }, {}));
    delete old.responsePayload;
    old.requestContext.condition = 'EventAgeExceeded';
    expect(readDeadLetter(JSON.stringify(old))).toMatchObject({
      kind: 'invoke',
      name: 'deploy',
      error: { name: 'EventAgeExceeded' },
      redrive: { __platform: 'invoke', name: 'deploy', payload: { id: 'd1' } },
    });
  });

  it('reads what Scheduler and EventBridge couldn’t deliver', () => {
    const attrs = (extra: Record<string, string>) =>
      Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, { StringValue: v }]));
    expect(
      readDeadLetter(
        JSON.stringify({ __platform: 'cron', name: 'nightly' }),
        attrs({ ERROR_CODE: 'AccessDenied', ERROR_MESSAGE: 'denied' }),
      ),
    ).toMatchObject({
      kind: 'cron',
      name: 'nightly',
      source: 'scheduler',
      error: { name: 'AccessDenied', message: 'denied' },
    });
    expect(
      readDeadLetter(
        JSON.stringify({ id: 'e', 'detail-type': 'a.b', time: '2026-11-16T10:00:00Z', detail: {} }),
        attrs({ RULE_ARN: 'arn:rule', ERROR_CODE: 'Throttled' }),
      ),
    ).toMatchObject({ kind: 'event', name: 'a.b', source: 'eventbridge' });
  });

  it('ignores messages the platform didn’t write', () => {
    expect(readDeadLetter('not json')).toBeNull();
    expect(readDeadLetter(JSON.stringify({ hello: 'world' }))).toBeNull();
  });
});
