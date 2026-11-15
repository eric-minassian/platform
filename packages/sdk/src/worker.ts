/**
 * Worker (Lambda Event Function) entry. Apps write:
 *
 *   export default defineWorker({
 *     queues: { emails: async (msg) => { ... } },
 *     events: { 'order.created': async (evt) => { ... } },
 *     crons: { nightly: async () => { ... } },
 *   });
 *
 * `plat build` generates `export const handler = createWorkerHandler(def)`.
 * One function per stage handles every queue, event subscription, cron and
 * direct invocation; the handler dispatches on the event shape. Each job is
 * auto-instrumented (`job`/`err` telemetry, trace propagation from the
 * producer). SQS batches report partial failures.
 *
 * CONTRACT: used by the CLI build and the control plane. Keep stable.
 */

import { gunzipSync } from 'node:zlib';
import { getBindings, tryBindings } from './bindings.ts';
import { client } from './clients.ts';
import { currentTrace, newContext, runWithContext } from './context.ts';
import type { EventEnvelope } from './events.ts';
import { emit, emitError, installConsoleCapture, installFetchInstrumentation, log } from './telemetry.ts';

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

// biome-ignore lint/suspicious/noExplicitAny: handlers choose their own payload types
type AnyPayload = any;

export interface WorkerDefinition {
  queues?: Record<string, (message: QueueMessage<AnyPayload>, ctx: JobContext) => unknown | Promise<unknown>>;
  events?: Record<string, (event: PlatformEvent<AnyPayload>, ctx: JobContext) => unknown | Promise<unknown>>;
  crons?: Record<string, (ctx: JobContext) => unknown | Promise<unknown>>;
  /** Direct invocations by name, e.g. the control plane's `deploy`. Return value is the invoke result. */
  invoke?: Record<string, (payload: AnyPayload, ctx: JobContext) => unknown | Promise<unknown>>;
  /** CloudWatch Logs subscription deliveries (system use). */
  logs?: (batch: LogsBatch, ctx: JobContext) => unknown | Promise<unknown>;
}

/** Payload shapes the platform sends to the worker besides SQS/EventBridge records. */
export type DirectPayload =
  | { __platform: 'cron'; name: string; trace?: string }
  | { __platform: 'invoke'; name: string; payload: unknown; trace?: string };

interface LambdaContextLike {
  getRemainingTimeInMillis?: () => number;
}

interface SqsRecord {
  messageId: string;
  body: string;
  eventSource: string;
  eventSourceARN: string;
  attributes?: { ApproximateReceiveCount?: string; SentTimestamp?: string };
  messageAttributes?: Record<string, { stringValue?: string; dataType?: string }>;
}

interface EventBridgeEvent {
  id: string;
  'detail-type': string;
  source: string;
  time: string;
  detail: unknown;
}

export function defineWorker<T extends WorkerDefinition>(def: T): T {
  return def;
}

type Kind = 'queue' | 'event' | 'cron' | 'invoke';

async function runJob<R>(
  kind: Kind,
  name: string,
  trace: string | undefined,
  attempt: number,
  lambdaCtx: LambdaContextLike | undefined,
  fn: (ctx: JobContext) => R | Promise<R>,
): Promise<{ ok: true; value: R } | { ok: false; error: unknown }> {
  const ctx = newContext(trace);
  ctx.job = `${kind}:${name}`;
  return runWithContext(ctx, async () => {
    const t0 = performance.now();
    const jobCtx: JobContext = {
      trace: ctx.trace,
      attempt,
      remainingMs: () => lambdaCtx?.getRemainingTimeInMillis?.() ?? Number.POSITIVE_INFINITY,
    };
    try {
      const value = await fn(jobCtx);
      emit('job', { kind, name, status: 'ok', dur: ms(t0), attempt, span: ctx.span });
      return { ok: true as const, value };
    } catch (error) {
      emitError(error, 'job', { job: `${kind}:${name}` });
      emit('job', { kind, name, status: 'error', dur: ms(t0), attempt, span: ctx.span });
      return { ok: false as const, error };
    }
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

function isEventBridge(e: unknown): e is EventBridgeEvent {
  return (
    typeof e === 'object' && e !== null && typeof (e as Record<string, unknown>)['detail-type'] === 'string'
  );
}

function isDirect(e: unknown): e is DirectPayload {
  const p = (e as { __platform?: unknown })?.__platform;
  return p === 'cron' || p === 'invoke';
}

function isLogs(e: unknown): e is { awslogs: { data: string } } {
  return typeof (e as { awslogs?: { data?: unknown } })?.awslogs?.data === 'string';
}

/** Lambda handler for a worker definition. */
export function createWorkerHandler(
  def: WorkerDefinition,
): (event: unknown, context: unknown) => Promise<unknown> {
  installConsoleCapture();
  installFetchInstrumentation();
  emit('env', { event: 'start', runtime: 'worker', initMs: Math.round(performance.now()) });

  return async (event: unknown, context: unknown) => {
    const lambdaCtx = context as LambdaContextLike | undefined;

    if (isSqsEvent(event)) return handleSqs(def, event.Records, lambdaCtx);

    if (isLogs(event)) {
      const decoded = JSON.parse(
        gunzipSync(Buffer.from(event.awslogs.data, 'base64')).toString('utf8'),
      ) as LogsBatch & {
        messageType?: string;
      };
      if (decoded.messageType === 'CONTROL_MESSAGE') return;
      if (!def.logs) {
        log.warn('worker received a CloudWatch Logs batch but defines no `logs` handler');
        return;
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

    if (isEventBridge(event)) {
      const type = event['detail-type'];
      const handler = def.events?.[type];
      if (!handler) {
        log.warn(`no handler for event "${type}"`, { source: event.source });
        return;
      }
      const env = event.detail as Partial<EventEnvelope> | undefined;
      const isEnvelope = env !== null && typeof env === 'object' && 'data' in env;
      const r = await runJob('event', type, isEnvelope ? env.trace : undefined, 1, lambdaCtx, (ctx) =>
        handler(
          { id: event.id, type, detail: isEnvelope ? env.data : event.detail, time: new Date(event.time) },
          ctx,
        ),
      );
      // Rethrow so Lambda's async retries and the on-failure destination apply.
      if (!r.ok) throw r.error;
      return;
    }

    if (isDirect(event)) {
      if (event.__platform === 'cron') {
        const handler = def.crons?.[event.name];
        if (!handler) throw new Error(`no cron handler "${event.name}"`);
        const r = await runJob('cron', event.name, event.trace, 1, lambdaCtx, (ctx) => handler(ctx));
        if (!r.ok) throw r.error;
        return;
      }
      const handler = def.invoke?.[event.name];
      if (!handler) throw new Error(`no invoke handler "${event.name}"`);
      const r = await runJob('invoke', event.name, event.trace, 1, lambdaCtx, (ctx) =>
        handler(event.payload, ctx),
      );
      if (!r.ok) throw r.error;
      return r.value;
    }

    throw new Error('Unrecognized worker event');
  };
}

async function handleSqs(
  def: WorkerDefinition,
  records: SqsRecord[],
  lambdaCtx: LambdaContextLike | undefined,
): Promise<{ batchItemFailures: Array<{ itemIdentifier: string }> }> {
  const queues = tryBindings()?.queues ?? {};
  const byArn = new Map(Object.entries(queues).map(([name, q]) => [q.arn, name]));
  const failures: Array<{ itemIdentifier: string }> = [];
  for (const record of records) {
    const name = byArn.get(record.eventSourceARN);
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
    throw new Error('This app has no worker. Add a "worker" (or queues/events/crons) to platform.json.');
  const body: DirectPayload = { __platform: 'invoke', name, payload, trace: currentTrace() };
  // `plat dev` / `plat test` run the worker as a local Node process (the
  // emulator's Lambda sandbox has no networking modules) and set this URL.
  const local = process.env.PLATFORM_LOCAL_WORKER_URL;
  if (local) {
    // Fire-and-forget like an async Lambda invoke; failures surface in the worker's logs.
    void fetch(local, { method: 'POST', body: JSON.stringify(body) })
      .then((r) => r.body?.cancel())
      .catch((err: unknown) => console.warn(`invokeJob(${name}) could not reach the local worker`, err));
    return;
  }
  const { InvokeCommand } = await import('@aws-sdk/client-lambda');
  const out = await (await client('lambda')).send(
    new InvokeCommand({
      FunctionName: worker,
      InvocationType: 'Event',
      Payload: new TextEncoder().encode(JSON.stringify(body)),
    }),
  );
  if (out.FunctionError) throw new Error(`invokeJob(${name}) failed: ${out.FunctionError}`);
}
