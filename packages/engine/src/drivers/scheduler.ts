import {
  CreateScheduleCommand,
  CreateScheduleGroupCommand,
  DeleteScheduleCommand,
  DeleteScheduleGroupCommand,
  GetScheduleCommand,
  GetScheduleGroupCommand,
  ListSchedulesCommand,
  UpdateScheduleCommand,
} from '@aws-sdk/client-scheduler';
import { type EngineContext, ignoreNotFound, retry, tagList } from '../util.ts';

export async function ensureScheduleGroup(
  ctx: EngineContext,
  spec: { name: string; tags?: Record<string, string> },
): Promise<string> {
  const sch = ctx.clients.scheduler;
  const existing = await ignoreNotFound(sch.send(new GetScheduleGroupCommand({ Name: spec.name })));
  if (existing?.Arn) return existing.Arn;
  const res = await sch.send(
    new CreateScheduleGroupCommand({ Name: spec.name, Tags: spec.tags ? tagList(spec.tags) : undefined }),
  );
  ctx.log('info', 'created schedule group', `schedule-group ${spec.name}`);
  return res.ScheduleGroupArn!;
}

export interface ScheduleSpec {
  group: string;
  name: string;
  /** EventBridge Scheduler expression (`cron(...)` / `rate(...)`). */
  expression: string;
  timezone?: string;
  target: { arn: string; roleArn: string; input: string };
}

export async function ensureSchedule(ctx: EngineContext, spec: ScheduleSpec): Promise<void> {
  const sch = ctx.clients.scheduler;
  const definition = {
    Name: spec.name,
    GroupName: spec.group,
    ScheduleExpression: spec.expression,
    ScheduleExpressionTimezone: spec.timezone,
    FlexibleTimeWindow: { Mode: 'OFF' as const },
    State: 'ENABLED' as const,
    Target: {
      Arn: spec.target.arn,
      RoleArn: spec.target.roleArn,
      Input: spec.target.input,
      RetryPolicy: { MaximumRetryAttempts: 2, MaximumEventAgeInSeconds: 3600 },
    },
  };
  const existing = await ignoreNotFound(
    sch.send(new GetScheduleCommand({ Name: spec.name, GroupName: spec.group })),
  );
  // A freshly created role may not be assumable by Scheduler yet.
  await retry(
    () =>
      existing
        ? sch.send(new UpdateScheduleCommand(definition))
        : sch.send(new CreateScheduleCommand(definition)),
    { when: (e) => /assume the role|execution role/i.test(String((e as Error).message)), attempts: 12 },
  );
  if (!existing) ctx.log('info', 'created schedule', `schedule ${spec.group}/${spec.name}`);
}

export async function listSchedules(ctx: EngineContext, group: string): Promise<string[]> {
  const out: string[] = [];
  let NextToken: string | undefined;
  do {
    const res = await ignoreNotFound(
      ctx.clients.scheduler.send(new ListSchedulesCommand({ GroupName: group, NextToken })),
    );
    if (!res) return out;
    for (const s of res.Schedules ?? []) if (s.Name) out.push(s.Name);
    NextToken = res.NextToken;
  } while (NextToken);
  return out;
}

export async function deleteSchedule(ctx: EngineContext, group: string, name: string): Promise<void> {
  await ignoreNotFound(
    ctx.clients.scheduler.send(new DeleteScheduleCommand({ Name: name, GroupName: group })),
  );
  ctx.log('info', 'deleted schedule', `schedule ${group}/${name}`);
}

export async function deleteScheduleGroup(ctx: EngineContext, group: string): Promise<void> {
  for (const s of await listSchedules(ctx, group)) await deleteSchedule(ctx, group, s);
  await ignoreNotFound(ctx.clients.scheduler.send(new DeleteScheduleGroupCommand({ Name: group })));
}
