import { CreateTopicCommand, ListSubscriptionsByTopicCommand, SubscribeCommand } from '@aws-sdk/client-sns';
import { type EngineContext, tagList } from '../util.ts';

export async function ensureTopic(
  ctx: EngineContext,
  spec: { name: string; tags?: Record<string, string> },
): Promise<string> {
  // CreateTopic is idempotent for an existing name.
  const res = await ctx.clients.sns.send(
    new CreateTopicCommand({ Name: spec.name, Tags: spec.tags ? tagList(spec.tags) : undefined }),
  );
  return res.TopicArn!;
}

/** Email subscription; AWS sends a confirmation email the first time. */
export async function ensureEmailSubscription(
  ctx: EngineContext,
  topicArn: string,
  email: string,
): Promise<void> {
  let NextToken: string | undefined;
  do {
    const res = await ctx.clients.sns.send(
      new ListSubscriptionsByTopicCommand({ TopicArn: topicArn, NextToken }),
    );
    if ((res.Subscriptions ?? []).some((s) => s.Protocol === 'email' && s.Endpoint === email)) return;
    NextToken = res.NextToken;
  } while (NextToken);
  await ctx.clients.sns.send(
    new SubscribeCommand({ TopicArn: topicArn, Protocol: 'email', Endpoint: email }),
  );
  ctx.log('info', 'subscribed alert email (confirm the email AWS sends)', `topic ${topicArn}`);
}
