import { APP_CONFIG_FILE } from '@ericminassian/platform-core';
import type { QueueBody, QueueName } from '../register.ts';
import { getBindings } from './bindings.ts';
import { client } from './clients.ts';
import { currentTrace } from './context.ts';
import { span } from './telemetry.ts';

export interface Queue<T> {
  send(body: T, opts?: { delaySeconds?: number }): Promise<void>;
  sendBatch(bodies: T[]): Promise<void>;
}

function queueUrl(name: string): string {
  const queues = getBindings().queues;
  const q = queues[name];
  if (!q) {
    const declared = Object.keys(queues);
    throw new Error(
      `Unknown queue "${name}". Declared queues: ${declared.length ? declared.join(', ') : '(none)'} — add it under \`queues\` in ${APP_CONFIG_FILE}.`,
    );
  }
  return q.url;
}

function traceAttribute(trace: string) {
  return { trace: { DataType: 'String', StringValue: trace } };
}

/** A queue declared under `queues` in `plat.config.ts`; its body type comes from `queue<T>()` there. */
export function queue<K extends QueueName>(name: K): Queue<QueueBody<K>> {
  return {
    send: (body, opts) =>
      span('queue.send', name, async () => {
        const { SendMessageCommand } = await import('@aws-sdk/client-sqs');
        const sqs = await client('sqs');
        await sqs.send(
          new SendMessageCommand({
            QueueUrl: queueUrl(name),
            MessageBody: JSON.stringify(body),
            MessageAttributes: traceAttribute(currentTrace()),
            ...(opts?.delaySeconds !== undefined ? { DelaySeconds: opts.delaySeconds } : {}),
          }),
        );
      }),
    sendBatch: (bodies) =>
      span('queue.send', name, async () => {
        const url = queueUrl(name);
        const trace = currentTrace();
        const { SendMessageBatchCommand } = await import('@aws-sdk/client-sqs');
        const sqs = await client('sqs');
        for (let i = 0; i < bodies.length; i += 10) {
          const chunk = bodies.slice(i, i + 10);
          const out = await sqs.send(
            new SendMessageBatchCommand({
              QueueUrl: url,
              Entries: chunk.map((b, j) => ({
                Id: String(i + j),
                MessageBody: JSON.stringify(b),
                MessageAttributes: traceAttribute(trace),
              })),
            }),
          );
          if (out.Failed?.length) {
            throw new Error(
              `queue "${name}": ${out.Failed.length} message(s) failed: ${out.Failed[0]?.Message ?? out.Failed[0]?.Code}`,
            );
          }
        }
      }),
  };
}
