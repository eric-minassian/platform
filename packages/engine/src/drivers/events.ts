import {
  CreateEventBusCommand,
  DeleteEventBusCommand,
  DeleteRuleCommand,
  DescribeEventBusCommand,
  ListRulesCommand,
  ListTargetsByRuleCommand,
  PutRuleCommand,
  PutTargetsCommand,
  RemoveTargetsCommand,
} from '@aws-sdk/client-eventbridge';
import { type EngineContext, ignoreNotFound, tagList } from '../util.ts';

export async function ensureEventBus(
  ctx: EngineContext,
  spec: { name: string; tags?: Record<string, string> },
): Promise<string> {
  const ev = ctx.clients.events;
  const existing = await ignoreNotFound(ev.send(new DescribeEventBusCommand({ Name: spec.name })));
  if (existing?.Arn) return existing.Arn;
  const res = await ev.send(
    new CreateEventBusCommand({ Name: spec.name, Tags: spec.tags ? tagList(spec.tags) : undefined }),
  );
  ctx.log('info', 'created event bus', `bus ${spec.name}`);
  return res.EventBusArn!;
}

export interface RuleSpec {
  bus: string;
  name: string;
  pattern: unknown;
  targets: Array<{ id: string; arn: string; input?: string; roleArn?: string }>;
  tags?: Record<string, string>;
  /**
   * Runs once the rule exists, before it targets anything new: where the
   * targets grant the rule access, so no event is refused in between.
   */
  beforeTargets?: (ruleArn: string) => Promise<void>;
}

export async function ensureRule(ctx: EngineContext, spec: RuleSpec): Promise<string> {
  const ev = ctx.clients.events;
  const rule = await ev.send(
    new PutRuleCommand({
      Name: spec.name,
      EventBusName: spec.bus,
      EventPattern: JSON.stringify(spec.pattern),
      State: 'ENABLED',
      Tags: spec.tags ? tagList(spec.tags) : undefined,
    }),
  );
  await spec.beforeTargets?.(rule.RuleArn!);
  await ev.send(
    new PutTargetsCommand({
      Rule: spec.name,
      EventBusName: spec.bus,
      Targets: spec.targets.map((t) => ({ Id: t.id, Arn: t.arn, Input: t.input, RoleArn: t.roleArn })),
    }),
  );
  const existing = await ev.send(new ListTargetsByRuleCommand({ Rule: spec.name, EventBusName: spec.bus }));
  const wanted = new Set(spec.targets.map((t) => t.id));
  const stale = (existing.Targets ?? []).map((t) => t.Id!).filter((id) => !wanted.has(id));
  if (stale.length)
    await ev.send(new RemoveTargetsCommand({ Rule: spec.name, EventBusName: spec.bus, Ids: stale }));
  return rule.RuleArn!;
}

export async function listRules(ctx: EngineContext, bus: string, prefix?: string): Promise<string[]> {
  const out: string[] = [];
  let NextToken: string | undefined;
  do {
    const res = await ignoreNotFound(
      ctx.clients.events.send(new ListRulesCommand({ EventBusName: bus, NamePrefix: prefix, NextToken })),
    );
    if (!res) return out;
    for (const r of res.Rules ?? []) if (r.Name) out.push(r.Name);
    NextToken = res.NextToken;
  } while (NextToken);
  return out;
}

export async function deleteRule(ctx: EngineContext, bus: string, name: string): Promise<void> {
  const ev = ctx.clients.events;
  const targets = await ignoreNotFound(
    ev.send(new ListTargetsByRuleCommand({ Rule: name, EventBusName: bus })),
  );
  const ids = (targets?.Targets ?? []).map((t) => t.Id!);
  if (ids.length)
    await ev.send(new RemoveTargetsCommand({ Rule: name, EventBusName: bus, Ids: ids, Force: true }));
  await ignoreNotFound(ev.send(new DeleteRuleCommand({ Name: name, EventBusName: bus, Force: true })));
  ctx.log('info', 'deleted rule', `rule ${name}`);
}

export async function deleteEventBus(ctx: EngineContext, name: string): Promise<void> {
  for (const rule of await listRules(ctx, name)) await deleteRule(ctx, name, rule);
  await ignoreNotFound(ctx.clients.events.send(new DeleteEventBusCommand({ Name: name })));
  ctx.log('info', 'deleted event bus', `bus ${name}`);
}
