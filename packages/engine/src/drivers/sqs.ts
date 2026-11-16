import {
  CreateQueueCommand,
  DeleteMessageBatchCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ListQueuesCommand,
  ReceiveMessageCommand,
  SendMessageBatchCommand,
  SetQueueAttributesCommand,
  TagQueueCommand,
} from '@aws-sdk/client-sqs';
import { type EngineContext, ignoreNotFound } from '../util.ts';

export interface QueueState {
  name: string;
  url: string;
  arn: string;
  created: boolean;
}

export async function getQueueUrl(ctx: EngineContext, name: string): Promise<string | undefined> {
  const res = await ignoreNotFound(ctx.clients.sqs.send(new GetQueueUrlCommand({ QueueName: name })));
  return res?.QueueUrl;
}

/** A queue's visibility timeout in seconds; undefined when the queue doesn't exist. */
export async function getQueueVisibility(ctx: EngineContext, name: string): Promise<number | undefined> {
  const url = await getQueueUrl(ctx, name);
  if (!url) return undefined;
  const res = await ignoreNotFound(
    ctx.clients.sqs.send(
      new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['VisibilityTimeout'] }),
    ),
  );
  const value = res?.Attributes?.VisibilityTimeout;
  return value === undefined ? undefined : Number(value);
}

export async function setQueueAttributes(
  ctx: EngineContext,
  url: string,
  attributes: Record<string, string>,
): Promise<void> {
  await ctx.clients.sqs.send(new SetQueueAttributesCommand({ QueueUrl: url, Attributes: attributes }));
}

export async function ensureQueue(
  ctx: EngineContext,
  spec: { name: string; attributes?: Record<string, string>; tags?: Record<string, string> },
): Promise<QueueState> {
  const sqs = ctx.clients.sqs;
  let url = await getQueueUrl(ctx, spec.name);
  let created = false;
  if (!url) {
    const res = await sqs.send(
      new CreateQueueCommand({ QueueName: spec.name, Attributes: spec.attributes, tags: spec.tags }),
    );
    url = res.QueueUrl!;
    created = true;
    ctx.log('info', 'created queue', `queue ${spec.name}`);
  } else {
    if (spec.attributes && Object.keys(spec.attributes).length) {
      await sqs.send(new SetQueueAttributesCommand({ QueueUrl: url, Attributes: spec.attributes }));
    }
    if (spec.tags) await sqs.send(new TagQueueCommand({ QueueUrl: url, Tags: spec.tags }));
  }
  const attrs = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['QueueArn'] }),
  );
  return { name: spec.name, url, arn: attrs.Attributes!.QueueArn!, created };
}

export async function deleteQueue(ctx: EngineContext, name: string): Promise<boolean> {
  const url = await getQueueUrl(ctx, name);
  if (!url) return false;
  await ignoreNotFound(ctx.clients.sqs.send(new DeleteQueueCommand({ QueueUrl: url })));
  ctx.log('info', 'deleted queue', `queue ${name}`);
  return true;
}

export async function listQueues(
  ctx: EngineContext,
  prefix: string,
): Promise<Array<{ name: string; url: string }>> {
  const out: Array<{ name: string; url: string }> = [];
  let NextToken: string | undefined;
  do {
    const res = await ctx.clients.sqs.send(new ListQueuesCommand({ QueueNamePrefix: prefix, NextToken }));
    for (const url of res.QueueUrls ?? []) out.push({ url, name: url.slice(url.lastIndexOf('/') + 1) });
    NextToken = res.NextToken;
  } while (NextToken);
  return out;
}

/** Messages a queue holds (visible, in flight and delayed); undefined when it doesn't exist. */
export async function queueDepth(ctx: EngineContext, url: string): Promise<number | undefined> {
  const res = await ignoreNotFound(
    ctx.clients.sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: url,
        AttributeNames: [
          'ApproximateNumberOfMessages',
          'ApproximateNumberOfMessagesNotVisible',
          'ApproximateNumberOfMessagesDelayed',
        ],
      }),
    ),
  );
  if (!res) return undefined;
  const a = res.Attributes ?? {};
  return (
    Number(a.ApproximateNumberOfMessages ?? 0) +
    Number(a.ApproximateNumberOfMessagesNotVisible ?? 0) +
    Number(a.ApproximateNumberOfMessagesDelayed ?? 0)
  );
}

/**
 * Moves every message visible on `from` to `to`, rewritten by `transform`,
 * deleting each once it's sent. Answers how many moved. Messages in flight
 * elsewhere stay where they are.
 */
export async function moveMessages(
  ctx: EngineContext,
  from: string,
  to: string,
  transform: (body: string, receiveCount: number) => string,
): Promise<number> {
  const sqs = ctx.clients.sqs;
  let moved = 0;
  for (;;) {
    const res = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: from,
        MaxNumberOfMessages: 10,
        VisibilityTimeout: 60,
        MessageSystemAttributeNames: ['ApproximateReceiveCount'],
      }),
    );
    const messages = res.Messages ?? [];
    if (messages.length === 0) return moved;
    const sent = await sqs.send(
      new SendMessageBatchCommand({
        QueueUrl: to,
        Entries: messages.map((m, i) => ({
          Id: String(i),
          MessageBody: transform(m.Body ?? '', Number(m.Attributes?.ApproximateReceiveCount ?? '1')),
        })),
      }),
    );
    const ok = new Set((sent.Successful ?? []).map((e) => e.Id));
    const done = messages.filter((_, i) => ok.has(String(i)));
    if (done.length)
      await sqs.send(
        new DeleteMessageBatchCommand({
          QueueUrl: from,
          Entries: done.map((m, i) => ({ Id: String(i), ReceiptHandle: m.ReceiptHandle! })),
        }),
      );
    moved += done.length;
    if (done.length < messages.length)
      throw new Error(`could not move ${messages.length - done.length} messages from ${from}`);
  }
}
