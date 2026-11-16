/**
 * Pushed jobs (see core `jobs.ts`): delivering a job now (an async Lambda
 * invoke) or later (a one-shot EventBridge Scheduler schedule), and what a
 * worker does with a failed run: schedule the next attempt, or put the job in
 * the stage's dead-letter queue.
 *
 * Under `plat dev` / `plat test` jobs go to the CLI's local worker
 * (`PLATFORM_LOCAL_WORKER_URL`), which waits out delays itself: the
 * emulator's Lambda can't run the worker and its Scheduler never fires.
 */
import {
  APP_CONFIG_FILE,
  atExpression,
  type DeadLetter,
  DEFAULT_ATTEMPTS,
  type HandlerKind,
  handlerKey,
  JOB_PAYLOAD_MAX_BYTES,
  type JobBindings,
  type JobPayload,
  jobScheduleName,
  MIN_SCHEDULE_LEAD_SECONDS,
  newId,
  retryDelaySeconds,
} from '@ericminassian/platform-core';
import { getBindings } from './bindings.ts';
import { client } from './clients.ts';

/** The local worker reads this header and runs the job once that time (epoch ms) comes. */
export const LOCAL_DELIVER_AT_HEADER = 'x-platform-deliver-at';
export const LOCAL_WORKER_URL_ENV = 'PLATFORM_LOCAL_WORKER_URL';

function jobBindings(): JobBindings {
  const jobs = getBindings().jobs;
  if (!jobs)
    throw new Error(
      `This app has no worker. Add queues, events or crons (or \`worker\`) to ${APP_CONFIG_FILE}.`,
    );
  return jobs;
}

/** The function a handler runs in: its own, or the worker's. */
export function functionFor(kind: HandlerKind, name: string): string {
  const b = getBindings();
  const fn = jobBindings().fns[handlerKey(kind, name)] ?? b.worker;
  if (!fn) throw new Error(`no function runs the ${kind} handler "${name}"`);
  return fn;
}

export function attemptsFor(kind: HandlerKind, name: string): number {
  return jobBindings().attempts[handlerKey(kind, name)] ?? DEFAULT_ATTEMPTS[kind];
}

/** Declared queues, for messages that name an unknown one. */
export function declaredQueues(): readonly string[] {
  return getBindings().jobs?.queues ?? [];
}

const encoder = new TextEncoder();

function encode(job: JobPayload): Uint8Array {
  const bytes = encoder.encode(JSON.stringify(job));
  if (bytes.length > JOB_PAYLOAD_MAX_BYTES) {
    const what = job.kind === 'queue' ? 'message' : 'job';
    throw new Error(
      `${job.kind} "${job.name}": the ${what} is ${Math.ceil(bytes.length / 1024)} KB, over the ` +
        `${JOB_PAYLOAD_MAX_BYTES / 1024} KB limit. Store large payloads with Storage and send their key.`,
    );
  }
  return bytes;
}

function arn(service: 'lambda' | 'sqs', resource: string): string {
  const b = getBindings();
  return service === 'lambda'
    ? `arn:aws:lambda:${b.region}:${b.account}:function:${resource}`
    : `arn:aws:sqs:${b.region}:${b.account}:${resource}`;
}

/** The dead-letter queue's name: the last segment of its URL. */
const deadQueueName = (url: string) => url.slice(url.lastIndexOf('/') + 1);

/**
 * Runs `job` on function `fn` now, or at `at`. A schedule's time is at least
 * `MIN_SCHEDULE_LEAD_SECONDS` ahead (Scheduler fires within about a minute and
 * refuses past times), so a shorter delay waits about a minute.
 */
export async function deliver(job: JobPayload, fn: string, at?: Date): Promise<void> {
  const payload = encode(job);
  const local = process.env[LOCAL_WORKER_URL_ENV];
  if (local) {
    const res = await fetch(local, {
      method: 'POST',
      body: payload,
      headers: at ? { [LOCAL_DELIVER_AT_HEADER]: String(at.getTime()) } : {},
    });
    // The local worker answers once the job ran (or was queued for later); its outcome is in its logs.
    await res.body?.cancel();
    if (res.status >= 500)
      throw new Error(`the local worker refused ${job.kind} "${job.name}" (${res.status})`);
    return;
  }
  if (!at) {
    const { InvokeCommand } = await import('@aws-sdk/client-lambda');
    const lambda = await client('lambda');
    await lambda.send(new InvokeCommand({ FunctionName: fn, InvocationType: 'Event', Payload: payload }));
    return;
  }
  const jobs = jobBindings();
  const earliest = Date.now() + MIN_SCHEDULE_LEAD_SECONDS * 1000;
  const { CreateScheduleCommand } = await import('@aws-sdk/client-scheduler');
  const scheduler = await client('scheduler');
  await scheduler.send(
    new CreateScheduleCommand({
      Name: jobScheduleName(job.kind, job.name, newId()),
      GroupName: jobs.group,
      ScheduleExpression: atExpression(new Date(Math.max(at.getTime(), earliest))),
      ScheduleExpressionTimezone: 'UTC',
      FlexibleTimeWindow: { Mode: 'OFF' },
      ActionAfterCompletion: 'DELETE',
      Target: {
        Arn: arn('lambda', fn),
        RoleArn: jobs.role,
        Input: new TextDecoder().decode(payload),
        // Scheduler's own retries cover throttling and outages; a job it can't deliver is
        // dead-lettered rather than lost.
        RetryPolicy: { MaximumRetryAttempts: 10, MaximumEventAgeInSeconds: 86_400 },
        DeadLetterConfig: { Arn: arn('sqs', deadQueueName(jobs.dead)) },
      },
    }),
  );
}

/**
 * What a worker does with a job whose run failed: deliver the next attempt
 * after a backoff, or, after its last, put it in the dead-letter queue.
 */
export async function afterFailure(job: JobPayload, error: unknown): Promise<'retry' | 'dead'> {
  if (job.attempt < attemptsFor(job.kind, job.name)) {
    const at = new Date(Date.now() + retryDelaySeconds(job.attempt) * 1000);
    await deliver({ ...job, attempt: job.attempt + 1 }, functionFor(job.kind, job.name), at);
    return 'retry';
  }
  await deadLetter(job, error);
  return 'dead';
}

/** The longest error message a dead letter keeps; the error group has the rest. */
const ERROR_MESSAGE_MAX = 2000;

export async function deadLetter(job: JobPayload, error: unknown): Promise<void> {
  const e = error instanceof Error ? error : new Error(String(error));
  const letter: DeadLetter = {
    v: 1,
    job,
    failedAt: Date.now(),
    error: { name: e.name, message: e.message.slice(0, ERROR_MESSAGE_MAX) },
  };
  const { SendMessageCommand } = await import('@aws-sdk/client-sqs');
  const sqs = await client('sqs');
  await sqs.send(
    new SendMessageCommand({ QueueUrl: jobBindings().dead, MessageBody: JSON.stringify(letter) }),
  );
}
