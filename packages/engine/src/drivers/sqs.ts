import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ListQueuesCommand,
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
