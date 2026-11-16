import {
  AddPermissionCommand,
  CreateEventSourceMappingCommand,
  CreateFunctionCommand,
  DeleteEventSourceMappingCommand,
  DeleteFunctionCommand,
  GetFunctionConfigurationCommand,
  GetPolicyCommand,
  ListEventSourceMappingsCommand,
  ListFunctionsCommand,
  RemovePermissionCommand,
  TagResourceCommand,
  UpdateEventSourceMappingCommand,
  UpdateFunctionCodeCommand,
  UpdateFunctionConfigurationCommand,
} from '@aws-sdk/client-lambda';
import type { S3Location } from '../index.ts';
import { type EngineContext, errorMessage, errorName, ignoreNotFound, retry, waitFor } from '../util.ts';

export interface FunctionSpec {
  name: string;
  roleArn: string;
  runtime: string;
  handler: string;
  architecture: 'arm64' | 'x86_64';
  memoryMb: number;
  timeoutSeconds: number;
  code: S3Location;
  env: Record<string, string>;
  logGroup?: string;
  description?: string;
  tags?: Record<string, string>;
}

export interface FunctionState {
  name: string;
  arn: string;
  created: boolean;
}

/** IAM is eventually consistent: a new role can take seconds to be assumable by Lambda. */
const isRolePropagation = (e: unknown) =>
  errorName(e) === 'InvalidParameterValueException' && /role|assume/i.test(errorMessage(e));
const isUpdateInProgress = (e: unknown) => errorName(e) === 'ResourceConflictException';

export async function ensureFunction(ctx: EngineContext, spec: FunctionSpec): Promise<FunctionState> {
  const lambda = ctx.clients.lambda;
  const existing = await ignoreNotFound(
    lambda.send(new GetFunctionConfigurationCommand({ FunctionName: spec.name })),
  );
  const config = {
    Role: spec.roleArn,
    Runtime: spec.runtime as never,
    Handler: spec.handler,
    MemorySize: spec.memoryMb,
    Timeout: spec.timeoutSeconds,
    Description: spec.description,
    Environment: { Variables: spec.env },
    LoggingConfig: spec.logGroup ? { LogFormat: 'JSON' as const, LogGroup: spec.logGroup } : undefined,
  };

  if (!existing) {
    const res = await retry(
      () =>
        lambda.send(
          new CreateFunctionCommand({
            FunctionName: spec.name,
            ...config,
            Architectures: [spec.architecture],
            Code: { S3Bucket: spec.code.bucket, S3Key: spec.code.key, S3ObjectVersion: spec.code.versionId },
            Tags: spec.tags,
          }),
        ),
      { when: isRolePropagation, attempts: 15, delayMs: 2_000 },
    );
    ctx.log('info', 'created function', `function ${spec.name}`);
    await waitReady(ctx, spec.name);
    return { name: spec.name, arn: res.FunctionArn!, created: true };
  }

  await waitReady(ctx, spec.name);
  await retry(
    () =>
      lambda.send(
        new UpdateFunctionCodeCommand({
          FunctionName: spec.name,
          S3Bucket: spec.code.bucket,
          S3Key: spec.code.key,
          S3ObjectVersion: spec.code.versionId,
          Architectures: [spec.architecture],
        }),
      ),
    { when: isUpdateInProgress },
  );
  await waitReady(ctx, spec.name);
  await retry(
    () => lambda.send(new UpdateFunctionConfigurationCommand({ FunctionName: spec.name, ...config })),
    {
      when: (e) => isUpdateInProgress(e) || isRolePropagation(e),
    },
  );
  await waitReady(ctx, spec.name);
  if (spec.tags)
    await lambda.send(new TagResourceCommand({ Resource: existing.FunctionArn, Tags: spec.tags }));
  ctx.log('info', 'updated function', `function ${spec.name}`);
  return { name: spec.name, arn: existing.FunctionArn!, created: false };
}

/** Wait until the function is Active and no update is in progress. */
export async function waitReady(ctx: EngineContext, name: string): Promise<void> {
  await waitFor(
    `function ${name} ready`,
    async () => {
      const c = await ctx.clients.lambda.send(new GetFunctionConfigurationCommand({ FunctionName: name }));
      if (c.State === 'Failed') throw new Error(`function ${name} failed: ${c.StateReason}`);
      if (c.LastUpdateStatus === 'Failed')
        throw new Error(`function ${name} update failed: ${c.LastUpdateStatusReason}`);
      return c.State === 'Active' && c.LastUpdateStatus !== 'InProgress';
    },
    { timeoutMs: 300_000 },
  );
}

export async function deleteFunction(ctx: EngineContext, name: string): Promise<boolean> {
  const res = await ignoreNotFound(
    ctx.clients.lambda.send(new DeleteFunctionCommand({ FunctionName: name })),
  );
  if (res) ctx.log('info', 'deleted function', `function ${name}`);
  return res !== undefined;
}

/** Functions whose names start with `prefix`. Lambda can't filter by name, so this pages through all of them. */
export async function listFunctions(
  ctx: EngineContext,
  prefix: string,
): Promise<Array<{ name: string; arn: string }>> {
  const out: Array<{ name: string; arn: string }> = [];
  let Marker: string | undefined;
  do {
    const res = await ctx.clients.lambda.send(new ListFunctionsCommand({ Marker }));
    for (const f of res.Functions ?? []) {
      if (f.FunctionName?.startsWith(prefix) && f.FunctionArn)
        out.push({ name: f.FunctionName, arn: f.FunctionArn });
    }
    Marker = res.NextMarker;
  } while (Marker);
  return out;
}

// ------------------------------------------------------------------ event source mappings

export interface EventSourceMappingSpec {
  functionName: string;
  sourceArn: string;
  batchSize: number;
  maxConcurrency?: number;
}

export async function ensureEventSourceMapping(
  ctx: EngineContext,
  spec: EventSourceMappingSpec,
): Promise<string> {
  const lambda = ctx.clients.lambda;
  const list = await lambda.send(
    new ListEventSourceMappingsCommand({ FunctionName: spec.functionName, EventSourceArn: spec.sourceArn }),
  );
  const existing = list.EventSourceMappings?.[0];
  const common = {
    BatchSize: spec.batchSize,
    FunctionResponseTypes: ['ReportBatchItemFailures' as const],
    ScalingConfig: spec.maxConcurrency ? { MaximumConcurrency: spec.maxConcurrency } : undefined,
    Enabled: true,
  };
  if (existing?.UUID) {
    await retry(() => lambda.send(new UpdateEventSourceMappingCommand({ UUID: existing.UUID, ...common })), {
      when: isUpdateInProgress,
    });
    return existing.UUID;
  }
  // The role's sqs:ReceiveMessage grant must be visible before Lambda accepts the mapping.
  const res = await retry(
    () =>
      lambda.send(
        new CreateEventSourceMappingCommand({
          FunctionName: spec.functionName,
          EventSourceArn: spec.sourceArn,
          ...common,
        }),
      ),
    {
      when: (e) =>
        errorName(e) === 'InvalidParameterValueException' && /permission|role/i.test(errorMessage(e)),
      attempts: 15,
      delayMs: 2_000,
    },
  );
  ctx.log('info', 'created event source mapping', `esm ${spec.sourceArn.split(':').pop()}`);
  return res.UUID!;
}

/** A function's mappings, except those already being deleted (deletion takes a while, and they still list). */
export async function listEventSourceMappings(
  ctx: EngineContext,
  functionName: string,
): Promise<Array<{ uuid: string; sourceArn: string }>> {
  const out: Array<{ uuid: string; sourceArn: string }> = [];
  let Marker: string | undefined;
  do {
    const res = await ignoreNotFound(
      ctx.clients.lambda.send(new ListEventSourceMappingsCommand({ FunctionName: functionName, Marker })),
    );
    if (!res) return out;
    for (const m of res.EventSourceMappings ?? []) {
      if (m.UUID && m.EventSourceArn && m.State !== 'Deleting')
        out.push({ uuid: m.UUID, sourceArn: m.EventSourceArn });
    }
    Marker = res.NextMarker;
  } while (Marker);
  return out;
}

export async function deleteEventSourceMapping(ctx: EngineContext, uuid: string): Promise<void> {
  // A mapping that is still Creating/Updating refuses deletion with ResourceInUseException.
  await ignoreNotFound(
    retry(() => ctx.clients.lambda.send(new DeleteEventSourceMappingCommand({ UUID: uuid })), {
      when: (e) => isUpdateInProgress(e) || errorName(e) === 'ResourceInUseException',
      attempts: 30,
      delayMs: 1_000,
    }),
  );
}

// ------------------------------------------------------------------ resource policy

export interface PermissionSpec {
  functionName: string;
  statementId: string;
  principal: string;
  action: string;
  sourceArn?: string;
}

/** Add a resource-policy statement; replaces a same-id statement that differs. */
export async function ensurePermission(ctx: EngineContext, spec: PermissionSpec): Promise<void> {
  const lambda = ctx.clients.lambda;
  const current = await ignoreNotFound(
    lambda.send(new GetPolicyCommand({ FunctionName: spec.functionName })),
  );
  if (current?.Policy) {
    const doc = JSON.parse(current.Policy) as {
      Statement: Array<{
        Sid: string;
        Principal?: { Service?: string };
        Action?: string;
        Condition?: { ArnLike?: { 'AWS:SourceArn'?: string } };
      }>;
    };
    const st = doc.Statement.find((s) => s.Sid === spec.statementId);
    if (st) {
      const same =
        st.Principal?.Service === spec.principal &&
        st.Action === spec.action &&
        (st.Condition?.ArnLike?.['AWS:SourceArn'] ?? undefined) === spec.sourceArn;
      if (same) return;
      await lambda.send(
        new RemovePermissionCommand({ FunctionName: spec.functionName, StatementId: spec.statementId }),
      );
    }
  }
  try {
    await lambda.send(
      new AddPermissionCommand({
        FunctionName: spec.functionName,
        StatementId: spec.statementId,
        Principal: spec.principal,
        Action: spec.action,
        SourceArn: spec.sourceArn,
      }),
    );
  } catch (e) {
    // Statement already present (e.g. GetPolicy returned a stale view).
    if (errorName(e) !== 'ResourceConflictException') throw e;
  }
}

export async function removePermission(
  ctx: EngineContext,
  functionName: string,
  statementId: string,
): Promise<void> {
  await ignoreNotFound(
    ctx.clients.lambda.send(
      new RemovePermissionCommand({ FunctionName: functionName, StatementId: statementId }),
    ),
  );
}

export async function listPermissionIds(ctx: EngineContext, functionName: string): Promise<string[]> {
  const current = await ignoreNotFound(
    ctx.clients.lambda.send(new GetPolicyCommand({ FunctionName: functionName })),
  );
  if (!current?.Policy) return [];
  return (JSON.parse(current.Policy) as { Statement: Array<{ Sid: string }> }).Statement.map((s) => s.Sid);
}
