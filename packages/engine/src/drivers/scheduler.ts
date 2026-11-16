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
import { atExpression } from '@ericminassian/platform-core';
import { type EngineContext, ignoreNotFound, retry, tagList, waitFor } from '../util.ts';

export { atExpression };

export async function ensureScheduleGroup(
  ctx: EngineContext,
  spec: { name: string; tags?: Record<string, string> },
): Promise<string> {
  const sch = ctx.clients.scheduler;
  const get = () => ignoreNotFound(sch.send(new GetScheduleGroupCommand({ Name: spec.name })));
  let existing = await get();
  if (existing?.State === 'DELETING') {
    // Groups are deleted asynchronously; one deleted by the previous deploy may still be going.
    await waitFor(`schedule group ${spec.name} to finish deleting`, async () => !(await get()));
    existing = undefined;
  }
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
  /** Where a firing Scheduler couldn't deliver goes (the stage's dead-letter queue). */
  deadLetterArn?: string;
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
      ...(spec.deadLetterArn ? { DeadLetterConfig: { Arn: spec.deadLetterArn } } : {}),
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
    { when: (e) => /assume the role|execution role/i.test((e as Error).message), attempts: 12 },
  );
  if (!existing) ctx.log('info', 'created schedule', `schedule ${spec.group}/${spec.name}`);
}

export interface OneShotScheduleSpec {
  group: string;
  name: string;
  /** When it fires (to the second, UTC). The schedule deletes itself afterwards. */
  at: Date;
  target: { arn: string; roleArn: string; input: string };
}

/** Inverse of {@link atExpression}. */
export function parseAtExpression(expression: string | undefined): Date | undefined {
  const m = /^at\((\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\)$/.exec(expression ?? '');
  return m ? new Date(`${m[1]}Z`) : undefined;
}

/** Create or move a schedule that fires once, then deletes itself. */
export async function ensureOneShotSchedule(ctx: EngineContext, spec: OneShotScheduleSpec): Promise<void> {
  const sch = ctx.clients.scheduler;
  const definition = {
    Name: spec.name,
    GroupName: spec.group,
    ScheduleExpression: atExpression(spec.at),
    ScheduleExpressionTimezone: 'UTC',
    ActionAfterCompletion: 'DELETE' as const,
    FlexibleTimeWindow: { Mode: 'OFF' as const },
    State: 'ENABLED' as const,
    Target: {
      Arn: spec.target.arn,
      RoleArn: spec.target.roleArn,
      Input: spec.target.input,
      RetryPolicy: { MaximumRetryAttempts: 5, MaximumEventAgeInSeconds: 3600 },
    },
  };
  const existing = await ignoreNotFound(
    sch.send(new GetScheduleCommand({ Name: spec.name, GroupName: spec.group })),
  );
  await retry(
    () =>
      existing
        ? sch.send(new UpdateScheduleCommand(definition))
        : sch.send(new CreateScheduleCommand(definition)),
    { when: (e) => /assume the role|execution role/i.test((e as Error).message), attempts: 12 },
  );
  ctx.log('info', `fires at ${spec.at.toISOString()}`, `schedule ${spec.group}/${spec.name}`);
}

/** When a one-shot schedule fires, or undefined when there is none (or it isn't one-shot). */
export async function getOneShotScheduleTime(
  ctx: EngineContext,
  group: string,
  name: string,
): Promise<Date | undefined> {
  const s = await ignoreNotFound(
    ctx.clients.scheduler.send(new GetScheduleCommand({ Name: name, GroupName: group })),
  );
  return parseAtExpression(s?.ScheduleExpression);
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
  const res = await ignoreNotFound(
    ctx.clients.scheduler.send(new DeleteScheduleCommand({ Name: name, GroupName: group })),
  );
  if (res) ctx.log('info', 'deleted schedule', `schedule ${group}/${name}`);
}

/** Delete the group and every schedule in it. */
export async function deleteScheduleGroup(ctx: EngineContext, group: string): Promise<void> {
  for (const s of await listSchedules(ctx, group)) await deleteSchedule(ctx, group, s);
  const exists = await ignoreNotFound(
    ctx.clients.scheduler.send(new GetScheduleGroupCommand({ Name: group })),
  );
  if (!exists || exists.State === 'DELETING') return;
  await ignoreNotFound(ctx.clients.scheduler.send(new DeleteScheduleGroupCommand({ Name: group })));
}

/** Delete the group if no schedule is left in it. */
export async function deleteScheduleGroupIfEmpty(ctx: EngineContext, group: string): Promise<void> {
  const exists = await ignoreNotFound(
    ctx.clients.scheduler.send(new GetScheduleGroupCommand({ Name: group })),
  );
  if (!exists || exists.State === 'DELETING' || (await listSchedules(ctx, group)).length) return;
  await ignoreNotFound(ctx.clients.scheduler.send(new DeleteScheduleGroupCommand({ Name: group })));
}
