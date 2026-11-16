/**
 * Worker (Lambda Event Function) runtime. An app's `src/worker.ts` exports
 * `defineWorker({ layer, queues, events, crons })` (`../worker.ts`), which
 * compiles to `JobHandlers`; `plat build` generates
 * `export const handler = createWorkerHandler(def)`.
 *
 * One bundle per stage handles every queue, event subscription, cron and
 * direct invocation; the handler dispatches on the event shape. It runs in the
 * worker's function, and in each function of a handler that sets its own
 * memory, timeout or concurrency, which only that handler's jobs reach.
 *
 * Queue messages, events and cron firings are all jobs (core `jobs.ts`): a run
 * that fails is delivered again after a backoff until its handler's
 * `maxAttempts`, then dead-lettered, and the invocation itself succeeds so
 * Lambda doesn't retry it too. Lambda's own retries are left for crashes and
 * timeouts, where this code never gets to decide. Each job is
 * auto-instrumented (`job`/`err` telemetry, trace propagation from the
 * producer).
 *
 * CONTRACT: used by the CLI build. Keep stable.
 */

import { gunzipSync } from 'node:zlib';
import { APP_CONFIG_FILE, type JobPayload, newId, toJob } from '@ericminassian/platform-core';
import type { AnyPayload, CronName, EventDetail, EventType, QueueBody, QueueName } from '../register.ts';
import { getBindings, tryBindings } from './bindings.ts';
import { client } from './clients.ts';
import { currentTrace, newContext, runWithContext, startRoot } from './context.ts';
import { afterFailure, deadLetter, LOCAL_WORKER_URL_ENV } from './jobs.ts';
import {
  emit,
  emitError,
  endRoot,
  installConsoleCapture,
  installFetchInstrumentation,
  log,
} from './telemetry.ts';

export interface JobContext {
  /** Trace id propagated from whoever enqueued/published/invoked this job. */
  trace: string;
  attempt: number;
  /** Remaining Lambda time in ms. */
  remainingMs(): number;
}

export interface QueueMessage<T = unknown> {
  id: string;
  body: T;
  attempt: number;
  sentAt: Date;
}

export interface PlatformEvent<T = unknown> {
  id: string;
  type: string;
  detail: T;
  time: Date;
}

/** Decoded CloudWatch Logs subscription payload (system use: telemetry processor). */
export interface LogsBatch {
  logGroup: string;
  logStream: string;
  logEvents: Array<{ id: string; timestamp: number; message: string }>;
}

/** The dispatch table `createWorkerHandler` runs: one promise-returning handler per job. */
export interface JobHandlers {
  queues?: Record<string, (message: QueueMessage<AnyPayload>, ctx: JobContext) => unknown>;
  events?: Record<string, (event: PlatformEvent<AnyPayload>, ctx: JobContext) => unknown>;
  crons?: Record<string, (ctx: JobContext) => unknown>;
  /** Direct invocations by name, e.g. the control plane's `deploy`. Return value is the invoke result. */
  invoke?: Record<string, (payload: AnyPayload, ctx: JobContext) => unknown>;
  /** CloudWatch Logs subscription deliveries (system use). */
  logs?: (batch: LogsBatch, ctx: JobContext) => unknown;
}

type QueueHandlers<Out> = {
  [K in QueueName]: (message: QueueMessage<QueueBody<K>>, ctx: JobContext) => Out;
};
type EventHandlers<Out> = {
  [K in EventType]: (event: PlatformEvent<EventDetail<K>>, ctx: JobContext) => Out;
};
type CronHandlers<Out> = { [K in CronName]: (ctx: JobContext) => Out };

/**
 * Unregistered (names are `string`): an optional map. Registered: required
 * when the config declares any, and not allowed when it declares none.
 */
type Section<Key extends string, Name extends string, Handlers> = string extends Name
  ? { [P in Key]?: Handlers }
  : [Name] extends [never]
    ? { [P in Key]?: never }
    : { [P in Key]: Handlers };

/** Queue, event and cron handlers returning `Out`, checked against the registered config. */
export type AppWorkerHandlers<Out> = Section<'queues', QueueName, QueueHandlers<Out>> &
  Section<'events', EventType, EventHandlers<Out>> &
  Section<'crons', CronName, CronHandlers<Out>>;

/** Payload shapes the platform sends to the worker besides jobs and EventBridge events. */
export type DirectPayload =
  | { __platform: 'cron'; name: string; trace?: string }
  | { __platform: 'invoke'; name: string; payload: unknown; trace?: string };

interface LambdaContextLike {
  getRemainingTimeInMillis?: () => number;
  awsRequestId?: string;
}

/** A queue's SQS batch: only from a queue created before 0.4.0, while it drains. */
interface SqsRecord {
  messageId: string;
  body: string;
  eventSource: string;
  eventSourceARN: string;
  attributes?: { ApproximateReceiveCount?: string; SentTimestamp?: string };
  messageAttributes?: Record<string, { stringValue?: string; dataType?: string }>;
}

type Kind = 'queue' | 'event' | 'cron' | 'invoke';

type Outcome<R> = { ok: true; value: R } | { ok: false; error: unknown };

/**
 * Runs one job with its telemetry. `onFailure` decides what happens after a
 * failed run (`next` on the `job` line); when it fails itself, the job line
 * says so and its error is thrown, so Lambda retries the invocation.
 */
async function runJob<R>(
  kind: Kind,
  name: string,
  trace: string | undefined,
  attempt: number,
  lambdaCtx: LambdaContextLike | undefined,
  fn: (ctx: JobContext) => R | Promise<R>,
  onFailure?: (error: unknown) => Promise<'retry' | 'dead'>,
): Promise<Outcome<R>> {
  const ctx = startRoot(trace);
  ctx.job = `${kind}:${name}`;
  return runWithContext(ctx, async () => {
    const t0 = performance.now();
    const jobCtx: JobContext = {
      trace: ctx.trace,
      attempt,
      remainingMs: () => lambdaCtx?.getRemainingTimeInMillis?.() ?? Number.POSITIVE_INFINITY,
    };
    let outcome: Outcome<R>;
    try {
      outcome = { ok: true, value: await fn(jobCtx) };
    } catch (error) {
      outcome = { ok: false, error };
    }
    if (outcome.ok) {
      endRoot(ctx, 'job', { kind, name, status: 'ok', dur: ms(t0), attempt });
      return outcome;
    }
    emitError(outcome.error, 'job', { job: `${kind}:${name}` });
    const next = onFailure ? await onFailure(outcome.error).catch((e: unknown) => e as Error) : undefined;
    const line = { kind, name, status: 'error' as const, dur: ms(t0), attempt };
    if (next instanceof Error) {
      endRoot(ctx, 'job', line);
      throw next;
    }
    endRoot(ctx, 'job', next ? { ...line, next } : line);
    return outcome;
  });
}

function ms(t0: number): number {
  return Math.round((performance.now() - t0) * 10) / 10;
}

function parseBody(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function isSqsEvent(e: unknown): e is { Records: SqsRecord[] } {
  const records = (e as { Records?: unknown })?.Records;
  return Array.isArray(records) && records.length > 0 && (records[0] as SqsRecord)?.eventSource === 'aws:sqs';
}

function isInvoke(e: unknown): e is Extract<DirectPayload, { __platform: 'invoke' }> {
  return (e as { __platform?: unknown })?.__platform === 'invoke';
}

function isLogs(e: unknown): e is { awslogs: { data: string } } {
  return typeof (e as { awslogs?: { data?: unknown } })?.awslogs?.data === 'string';
}

/** Lambda handler for a worker definition. */
export function createWorkerHandler(
  def: JobHandlers,
): (event: unknown, context: unknown) => Promise<unknown> {
  installConsoleCapture();
  installFetchInstrumentation();
  emit('env', { event: 'start', runtime: 'worker', initMs: Math.round(performance.now()) });

  return async (event: unknown, context: unknown) => {
    const lambdaCtx = context as LambdaContextLike | undefined;

    if (isSqsEvent(event)) return handleLegacySqs(def, event.Records, lambdaCtx);

    if (isLogs(event)) {
      const decoded = JSON.parse(
        gunzipSync(Buffer.from(event.awslogs.data, 'base64')).toString('utf8'),
      ) as LogsBatch & {
        messageType?: string;
      };
      if (decoded.messageType === 'CONTROL_MESSAGE') return undefined;
      if (!def.logs) {
        log.warn('worker received a CloudWatch Logs batch but defines no `logs` handler');
        return undefined;
      }
      const ctx = newContext();
      return runWithContext(ctx, () =>
        def.logs!(
          { logGroup: decoded.logGroup, logStream: decoded.logStream, logEvents: decoded.logEvents ?? [] },
          {
            trace: ctx.trace,
            attempt: 1,
            remainingMs: () => lambdaCtx?.getRemainingTimeInMillis?.() ?? Number.POSITIVE_INFINITY,
          },
        ),
      );
    }

    if (isInvoke(event)) {
      const handler = def.invoke?.[event.name];
      if (!handler) throw new Error(`no invoke handler "${event.name}"`);
      const r = await runJob('invoke', event.name, event.trace, 1, lambdaCtx, (ctx) =>
        handler(event.payload, ctx),
      );
      // Rethrow: a direct invoke's caller gets the error, and an async one's goes to Lambda's
      // retries and then the dead-letter queue (the on-failure destination).
      if (!r.ok) throw r.error;
      return r.value;
    }

    // A queue message, an event from EventBridge, a cron firing from Scheduler, or a retry.
    const job = toJob(event, lambdaCtx?.awsRequestId ?? newId('j'), Date.now());
    if (!job) throw new Error('Unrecognized worker event');
    await runJobPayload(def, job, lambdaCtx);
    return undefined;
  };
}

/** Runs a queue, event or cron job; a failed run is retried later or dead-lettered, never rethrown. */
async function runJobPayload(
  def: JobHandlers,
  job: JobPayload,
  lambdaCtx: LambdaContextLike | undefined,
): Promise<void> {
  const run = handlerFor(def, job);
  if (!run) {
    // A handler removed while jobs for it were waiting (a retry, a delayed send): keep the job.
    const error = new Error(`the worker has no ${job.kind} handler "${job.name}"`);
    error.name = 'NoHandler';
    emitError(error, 'job', { job: `${job.kind}:${job.name}` });
    await deadLetter(job, error);
    return;
  }
  await runJob(job.kind, job.name, job.trace, job.attempt, lambdaCtx, run, (error) =>
    afterFailure(job, error),
  );
}

function handlerFor(def: JobHandlers, job: JobPayload): ((ctx: JobContext) => unknown) | undefined {
  if (job.kind === 'queue') {
    const handler = def.queues?.[job.name];
    return (
      handler &&
      ((ctx) =>
        handler({ id: job.id, body: job.body, attempt: job.attempt, sentAt: new Date(job.sentAt) }, ctx))
    );
  }
  if (job.kind === 'event') {
    const handler = def.events?.[job.name];
    return (
      handler &&
      ((ctx) => handler({ id: job.id, type: job.name, detail: job.detail, time: new Date(job.sentAt) }, ctx))
    );
  }
  const handler = def.crons?.[job.name];
  return handler && ((ctx) => handler(ctx));
}

/**
 * A pre-0.4.0 queue still draining: the engine keeps its event source mapping
 * until it's empty. Its name is `<app>--<stage>--<queue>`. Failures go back to
 * SQS (partial batch response), whose redrive policy moves them to the old
 * dead-letter queue; the next deploy moves those into the stage's.
 */
async function handleLegacySqs(
  def: JobHandlers,
  records: SqsRecord[],
  lambdaCtx: LambdaContextLike | undefined,
): Promise<{ batchItemFailures: Array<{ itemIdentifier: string }> }> {
  const b = tryBindings();
  const prefix = b ? `${b.app}--${b.stage}--` : '';
  const failures: Array<{ itemIdentifier: string }> = [];
  for (const record of records) {
    const queueName = record.eventSourceARN.slice(record.eventSourceARN.lastIndexOf(':') + 1);
    const name = prefix && queueName.startsWith(prefix) ? queueName.slice(prefix.length) : undefined;
    const handler = name ? def.queues?.[name] : undefined;
    if (!name || !handler) {
      emitError(new Error(`no queue handler for ${record.eventSourceARN}`), 'job');
      failures.push({ itemIdentifier: record.messageId });
      continue;
    }
    const attempt = Number(record.attributes?.ApproximateReceiveCount ?? '1');
    const trace = record.messageAttributes?.trace?.stringValue;
    const sentAt = new Date(Number(record.attributes?.SentTimestamp ?? Date.now()));
    const r = await runJob('queue', name, trace, attempt, lambdaCtx, (ctx) =>
      handler({ id: record.messageId, body: parseBody(record.body), attempt, sentAt }, ctx),
    );
    if (!r.ok) failures.push({ itemIdentifier: record.messageId });
  }
  return { batchItemFailures: failures };
}

/** Invoke another named job on this stage's worker asynchronously. */
export async function invokeJob(name: string, payload: unknown): Promise<void> {
  const worker = getBindings().worker;
  if (!worker)
    throw new Error(
      `This app has no worker. Add \`worker\` (or queues, events or crons) to ${APP_CONFIG_FILE}.`,
    );
  const body: DirectPayload = { __platform: 'invoke', name, payload, trace: currentTrace() };
  // `plat dev` / `plat test` run the worker as a local Node process (the
  // emulator's Lambda sandbox has no networking modules) and set this URL.
  const local = process.env[LOCAL_WORKER_URL_ENV];
  if (local) {
    // Fire-and-forget like an async Lambda invoke; failures surface in the worker's logs.
    void fetch(local, { method: 'POST', body: JSON.stringify(body) })
      .then((r) => r.body?.cancel())
      .catch((err: unknown) => console.warn(`invokeJob(${name}) could not reach the local worker`, err));
    return;
  }
  const { InvokeCommand } = await import('@aws-sdk/client-lambda');
  const lambda = await client('lambda');
  const out = await lambda.send(
    new InvokeCommand({
      FunctionName: worker,
      InvocationType: 'Event',
      Payload: new TextEncoder().encode(JSON.stringify(body)),
    }),
  );
  if (out.FunctionError) throw new Error(`invokeJob(${name}) failed: ${out.FunctionError}`);
}
