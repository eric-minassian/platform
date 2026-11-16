import {
  APP_CONFIG_FILE,
  JOB_MARKER,
  type JobPayload,
  MAX_JOB_DELAY_SECONDS,
  newId,
} from '@ericminassian/platform-core';
import type { QueueBody, QueueName } from '../register.ts';
import { currentTrace } from './context.ts';
import { declaredQueues, deliver, functionFor } from './jobs.ts';
import { span } from './telemetry.ts';

export interface Queue<T> {
  /** `delaySeconds`: run it no sooner than this, to the minute (up to a year). */
  send(body: T, opts?: { delaySeconds?: number }): Promise<void>;
  sendBatch(bodies: T[]): Promise<void>;
}

/** Sends in a batch at once; each is its own async invoke. */
const BATCH_CONCURRENCY = 10;

function assertDeclared(name: string): void {
  const declared = declaredQueues();
  if (declared.includes(name)) return;
  throw new Error(
    `Unknown queue "${name}". Declared queues: ${declared.length ? declared.join(', ') : '(none)'}. Add it under \`queues\` in ${APP_CONFIG_FILE}.`,
  );
}

function message(name: string, body: unknown, trace: string): JobPayload {
  return {
    __platform: JOB_MARKER,
    kind: 'queue',
    name,
    id: newId('m'),
    attempt: 1,
    sentAt: Date.now(),
    body,
    trace,
  };
}

/**
 * A queue declared under `queues` in `plat.config.ts`; its body type comes
 * from `queue<T>()` there. A message is an async invoke of the function its
 * handler runs in; a delayed one is a one-shot schedule.
 */
export function queue<K extends QueueName>(name: K): Queue<QueueBody<K>> {
  return {
    send: (body, opts) =>
      span('queue.send', name, async () => {
        assertDeclared(name);
        const delay = opts?.delaySeconds ?? 0;
        if (!(delay >= 0 && delay <= MAX_JOB_DELAY_SECONDS))
          throw new Error(`queue "${name}": delaySeconds must be 0-${MAX_JOB_DELAY_SECONDS}, got ${delay}`);
        const at = delay > 0 ? new Date(Date.now() + delay * 1000) : undefined;
        await deliver(message(name, body, currentTrace()), functionFor('queue', name), at);
      }),
    sendBatch: (bodies) =>
      span('queue.send', name, async () => {
        assertDeclared(name);
        const trace = currentTrace();
        const fn = functionFor('queue', name);
        // Every message gets its try, so a failure sends the caller back for the failed ones only
        // if it retries; the first error says why.
        const failed: unknown[] = [];
        for (let i = 0; i < bodies.length; i += BATCH_CONCURRENCY) {
          const results = await Promise.allSettled(
            bodies.slice(i, i + BATCH_CONCURRENCY).map((body) => deliver(message(name, body, trace), fn)),
          );
          for (const r of results) if (r.status === 'rejected') failed.push(r.reason);
        }
        if (failed.length) {
          const first = failed[0] instanceof Error ? failed[0].message : String(failed[0]);
          throw new Error(`queue "${name}": ${failed.length} of ${bodies.length} messages failed: ${first}`);
        }
      }),
  };
}
