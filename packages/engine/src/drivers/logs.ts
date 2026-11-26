import {
  CreateLogGroupCommand,
  DeleteLogGroupCommand,
  DescribeLogGroupsCommand,
  PutAccountPolicyCommand,
  PutRetentionPolicyCommand,
  PutSubscriptionFilterCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import { type EngineContext, errorName, ignoreNotFound } from '../util.ts';

/** Retention values CloudWatch Logs accepts. */
const RETENTION_DAYS = [
  1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653,
];

export function snapRetention(days: number): number {
  return RETENTION_DAYS.find((d) => d >= days) ?? 3653;
}

export async function ensureLogGroup(
  ctx: EngineContext,
  spec: { name: string; retentionDays: number; tags?: Record<string, string> },
): Promise<string> {
  const logs = ctx.clients.logs;
  try {
    await logs.send(new CreateLogGroupCommand({ logGroupName: spec.name, tags: spec.tags }));
    ctx.log('info', 'created log group', `log-group ${spec.name}`);
  } catch (e) {
    if (errorName(e) !== 'ResourceAlreadyExistsException') throw e;
  }
  await logs.send(
    new PutRetentionPolicyCommand({
      logGroupName: spec.name,
      retentionInDays: snapRetention(spec.retentionDays),
    }),
  );
  const acct = await ctx.accountId();
  return `arn:aws:logs:${ctx.region}:${acct}:log-group:${spec.name}`;
}

export async function deleteLogGroup(ctx: EngineContext, name: string): Promise<void> {
  await ignoreNotFound(ctx.clients.logs.send(new DeleteLogGroupCommand({ logGroupName: name })));
}

export async function listLogGroups(ctx: EngineContext, prefix: string): Promise<string[]> {
  const out: string[] = [];
  let nextToken: string | undefined;
  do {
    const res = await ctx.clients.logs.send(
      new DescribeLogGroupsCommand({ logGroupNamePrefix: prefix, nextToken }),
    );
    for (const g of res.logGroups ?? []) if (g.logGroupName) out.push(g.logGroupName);
    nextToken = res.nextToken;
  } while (nextToken);
  return out;
}

/**
 * The one account-level subscription filter: every log group in the region
 * (except `excludeLogGroups`, to avoid the processor feeding itself) streams
 * lines matching `filterPattern` to `destinationArn`.
 */
export async function ensureAccountSubscriptionFilter(
  ctx: EngineContext,
  spec: { name: string; destinationArn: string; filterPattern: string; excludeLogGroups: string[] },
): Promise<void> {
  await ctx.clients.logs.send(
    new PutAccountPolicyCommand({
      policyName: spec.name,
      policyType: 'SUBSCRIPTION_FILTER_POLICY',
      scope: 'ALL',
      policyDocument: JSON.stringify({
        DestinationArn: spec.destinationArn,
        FilterPattern: spec.filterPattern,
      }),
      selectionCriteria: spec.excludeLogGroups.length
        ? `LogGroupName NOT IN [${spec.excludeLogGroups.map((g) => JSON.stringify(g)).join(', ')}]`
        : undefined,
    }),
  );
  ctx.log('info', 'put account subscription filter', `account-policy ${spec.name}`);
}

/**
 * A subscription filter on one log group, for lines the account-level one
 * can't match (it takes a single pattern): every line of `logGroup` matching
 * `filterPattern` (empty: all of them) streams to `destinationArn`.
 */
export async function ensureSubscriptionFilter(
  ctx: EngineContext,
  spec: { name: string; logGroup: string; destinationArn: string; filterPattern: string },
): Promise<void> {
  await ctx.clients.logs.send(
    new PutSubscriptionFilterCommand({
      filterName: spec.name,
      logGroupName: spec.logGroup,
      destinationArn: spec.destinationArn,
      filterPattern: spec.filterPattern,
    }),
  );
  ctx.log('info', 'put subscription filter', `log-group ${spec.logGroup}`);
}
