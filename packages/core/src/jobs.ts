/**
 * Jobs: queue messages, events and cron runs. They are pushed, never polled:
 * a queue send is an async Lambda invoke of the function its handler runs in,
 * events arrive from EventBridge and crons from EventBridge Scheduler, and a
 * failed run is retried through a one-shot Scheduler schedule. A stage with
 * jobs costs nothing until one runs (an SQS queue with a Lambda event source
 * mapping costs ~$0.26 a month in empty polls).
 *
 * After its last attempt a job goes to the stage's dead-letter queue, an SQS
 * queue nothing polls. Four writers share it: the SDK (a handler that failed
 * every attempt, `DeadLetter`), Lambda's on-failure destination (a crash or
 * timeout retried twice, or an event older than six hours), Scheduler's
 * dead-letter queue (a retry or cron it couldn't deliver) and EventBridge's (an
 * event it couldn't deliver). `readDeadLetter` reads all four.
 */
import { fingerprint } from './fingerprint.ts';
import type { HandlerKind } from './manifest.ts';

/** Marker on every job payload the platform sends to a worker function. */
export const JOB_MARKER = 'job';

/** What a worker function receives for a queue message, a retry, or a delayed send. */
export interface JobPayload {
  __platform: typeof JOB_MARKER;
  kind: HandlerKind;
  /** Queue or cron key, or event type. */
  name: string;
  /** Stable across retries: the message's id, the event's id, or the cron run's. */
  id: string;
  /** Which delivery this is, from 1. */
  attempt: number;
  /** Epoch ms when the message was sent, the event published or the cron fired. */
  sentAt: number;
  /** A queue message's body. */
  body?: unknown;
  /** An event's detail. */
  detail?: unknown;
  trace?: string;
}

/**
 * The largest job payload, in bytes of JSON. Retries and delayed sends go
 * through a Scheduler schedule, whose input is capped at 256 KB, and a dead
 * letter wraps the payload with its error, so this leaves room for both.
 */
export const JOB_PAYLOAD_MAX_BYTES = 240 * 1024;

/** Attempts per kind when a handler sets none. Lambda retried events and crons twice before. */
export const DEFAULT_ATTEMPTS: Readonly<Record<HandlerKind, number>> = { queue: 5, event: 3, cron: 3 };
export const MAX_ATTEMPTS = 100;

/** The longest delay `send` takes: a one-shot schedule can be any time ahead, a year is plenty. */
export const MAX_JOB_DELAY_SECONDS = 365 * 86_400;

/**
 * Scheduler fires a one-shot schedule within about a minute of its time, and
 * refuses times in the past, so a delayed send or retry is scheduled at least
 * this far ahead.
 */
export const MIN_SCHEDULE_LEAD_SECONDS = 60;

/** Seconds before attempt `failed + 1`: 1, 2, 4 … minutes, at most an hour. */
export function retryDelaySeconds(failed: number): number {
  return Math.min(60 * 2 ** Math.max(0, failed - 1), 3600);
}

/** `kind:name`, the key bindings use for a handler. */
export const handlerKey = (kind: HandlerKind, name: string): string => `${kind}:${name}`;

/**
 * Name of the one-shot schedule for a retry or delayed send (≤ 64 chars of
 * Scheduler's alphabet). It leads with `_`, which no cron key (a cron's own
 * schedule) or service stop schedule (`<key>--stop`) starts with, then the
 * kind and queue or cron key, so the console can count what's waiting per
 * queue with a name prefix. Event types can be long and contain `:`, so they
 * are hashed.
 */
export function jobScheduleName(kind: HandlerKind, name: string, id: string): string {
  return `${jobSchedulePrefix(kind, name)}${id}`.slice(0, 64);
}

export function jobSchedulePrefix(kind: HandlerKind, name: string): string {
  if (kind === 'queue') return `_q-${name}-`;
  if (kind === 'cron') return `_c-${name}-`;
  return `_e-${fingerprint([name])}-`;
}

export const isJobSchedule = (name: string): boolean => name.startsWith('_');

/** One-shot schedule expression for `at` (UTC, whole seconds). */
export function atExpression(at: Date): string {
  return `at(${at.toISOString().slice(0, 19)})`;
}

/** What the SDK writes to the dead-letter queue when a handler failed its last attempt. */
export interface DeadLetter {
  v: 1;
  job: JobPayload;
  /** Epoch ms. */
  failedAt: number;
  error: { name: string; message: string };
}

/** A dead-letter queue message, whoever wrote it, in the terms the console shows. */
export interface DeadLetterView {
  /** `invoke` is a direct `invokeJob` call that crashed or timed out. */
  kind: HandlerKind | 'invoke';
  name: string;
  /** Deliveries made, when known. */
  attempts: number | null;
  error: { name: string; message: string };
  /** Epoch ms. */
  failedAt: number | null;
  /** Who gave up: the SDK, Lambda (crash, timeout, too old), Scheduler or EventBridge (couldn't deliver). */
  source: 'sdk' | 'lambda' | 'scheduler' | 'eventbridge';
  /** What redriving sends, to the function the job's handler runs in now. */
  redrive: JobPayload | { __platform: 'invoke'; name: string; payload: unknown; trace?: string };
}

/** SQS message attributes as the SDK returns them. */
type Attributes = Record<string, { StringValue?: string } | undefined>;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/**
 * Normalizes anything a worker function can receive into the job it stands
 * for: a job payload as is, an EventBridge event, or a cron firing. `id` is
 * used when the input carries none (a cron firing). Undefined for anything
 * else, such as a direct `invoke`.
 */
export function toJob(input: unknown, id: string, now: number): JobPayload | undefined {
  if (!isObject(input)) return undefined;
  if (input.__platform === JOB_MARKER && typeof input.kind === 'string' && typeof input.name === 'string') {
    return input as unknown as JobPayload;
  }
  if (input.__platform === 'cron' && typeof input.name === 'string') {
    return {
      __platform: JOB_MARKER,
      kind: 'cron',
      name: input.name,
      id,
      attempt: 1,
      sentAt: now,
      ...(typeof input.trace === 'string' ? { trace: input.trace } : {}),
    };
  }
  if (typeof input['detail-type'] === 'string') {
    // The SDK publishes `{ data, trace }` as an event's detail; events from elsewhere are bare.
    const detail = input.detail;
    const envelope = isObject(detail) && 'data' in detail ? detail : undefined;
    return {
      __platform: JOB_MARKER,
      kind: 'event',
      name: input['detail-type'],
      id: typeof input.id === 'string' ? input.id : id,
      attempt: 1,
      sentAt: typeof input.time === 'string' ? Date.parse(input.time) || now : now,
      detail: envelope ? envelope.data : detail,
      ...(envelope && typeof envelope.trace === 'string' ? { trace: envelope.trace } : {}),
    };
  }
  return undefined;
}

/** Reads a dead-letter queue message; null for one the platform didn't write. */
export function readDeadLetter(body: string, attributes: Attributes = {}): DeadLetterView | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isObject(parsed)) return null;
  const attr = (name: string) => attributes[name]?.StringValue;

  // The SDK's own.
  if (parsed.v === 1 && isObject(parsed.job) && isObject(parsed.error)) {
    const d = parsed as unknown as DeadLetter;
    return {
      kind: d.job.kind,
      name: d.job.name,
      attempts: d.job.attempt,
      error: d.error,
      failedAt: d.failedAt,
      source: 'sdk',
      redrive: { ...d.job, attempt: 1 },
    };
  }

  // Lambda's on-failure destination record.
  if (isObject(parsed.requestContext) && 'requestPayload' in parsed) {
    const ctx = parsed.requestContext;
    const response = isObject(parsed.responsePayload) ? parsed.responsePayload : {};
    const condition = typeof ctx.condition === 'string' ? ctx.condition : 'RetriesExhausted';
    const error = {
      name:
        typeof response.errorType === 'string'
          ? response.errorType
          : condition === 'EventAgeExceeded'
            ? 'EventAgeExceeded'
            : 'FunctionError',
      message:
        typeof response.errorMessage === 'string'
          ? response.errorMessage
          : condition === 'EventAgeExceeded'
            ? 'the event waited longer than six hours (throttled)'
            : condition,
    };
    const failedAt = typeof parsed.timestamp === 'string' ? Date.parse(parsed.timestamp) || null : null;
    const attempts = typeof ctx.approximateInvokeCount === 'number' ? ctx.approximateInvokeCount : null;
    return fromPayload(parsed.requestPayload, error, failedAt, 'lambda', attempts);
  }

  // Scheduler (a retry, delayed send or cron it couldn't deliver) and EventBridge (an event it
  // couldn't deliver) put the input they meant to deliver in the body and the error in attributes.
  const error = {
    name: attr('ERROR_CODE') ?? 'DeliveryFailed',
    message: attr('ERROR_MESSAGE') ?? 'the target could not be invoked',
  };
  const source = attr('RULE_ARN') ? 'eventbridge' : 'scheduler';
  return fromPayload(parsed, error, null, source, null);
}

function fromPayload(
  payload: unknown,
  error: DeadLetterView['error'],
  failedAt: number | null,
  source: DeadLetterView['source'],
  attempts: number | null,
): DeadLetterView | null {
  const job = toJob(payload, `r${fingerprint([JSON.stringify(payload ?? null)])}`, failedAt ?? Date.now());
  if (job) {
    return {
      kind: job.kind,
      name: job.name,
      attempts: attempts ?? job.attempt,
      error,
      failedAt,
      source,
      redrive: { ...job, attempt: 1 },
    };
  }
  if (isObject(payload) && payload.__platform === 'invoke' && typeof payload.name === 'string') {
    return {
      kind: 'invoke',
      name: payload.name,
      attempts,
      error,
      failedAt,
      source,
      redrive: {
        __platform: 'invoke',
        name: payload.name,
        payload: payload.payload,
        ...(typeof payload.trace === 'string' ? { trace: payload.trace } : {}),
      },
    };
  }
  return null;
}
