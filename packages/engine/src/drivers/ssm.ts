import {
  DeleteParameterCommand,
  DeleteParametersCommand,
  GetParameterCommand,
  GetParametersByPathCommand,
  PutParameterCommand,
} from '@aws-sdk/client-ssm';
import { type EngineContext, errorName, ignoreNotFound } from '../util.ts';

export async function getParameter(
  ctx: EngineContext,
  name: string,
  decrypt = true,
): Promise<string | undefined> {
  const res = await ignoreNotFound(
    ctx.clients.ssm.send(new GetParameterCommand({ Name: name, WithDecryption: decrypt })),
  );
  return res?.Parameter?.Value;
}

export async function putParameter(
  ctx: EngineContext,
  spec: { name: string; value: string; secure?: boolean; description?: string },
): Promise<void> {
  await ctx.clients.ssm.send(
    new PutParameterCommand({
      Name: spec.name,
      Value: spec.value,
      Type: spec.secure ? 'SecureString' : 'String',
      Description: spec.description,
      Overwrite: true,
      Tier: Buffer.byteLength(spec.value) > 4096 ? 'Advanced' : 'Standard',
    }),
  );
}

/** Create the parameter only if it doesn't exist (e.g. a generated key). Returns the current value. */
export async function ensureParameterOnce(
  ctx: EngineContext,
  spec: { name: string; secure?: boolean; description?: string; generate: () => string },
): Promise<string> {
  const current = await getParameter(ctx, spec.name);
  if (current !== undefined) return current;
  const value = spec.generate();
  try {
    await ctx.clients.ssm.send(
      new PutParameterCommand({
        Name: spec.name,
        Value: value,
        Type: spec.secure ? 'SecureString' : 'String',
        Description: spec.description,
        // Never overwrite: a concurrent creator may have won, and its value is the one in use.
        Overwrite: false,
      }),
    );
  } catch (e) {
    if (errorName(e) !== 'ParameterAlreadyExists') throw e;
    const winner = await getParameter(ctx, spec.name);
    if (winner === undefined) throw e;
    return winner;
  }
  ctx.log('info', 'created parameter', `parameter ${spec.name}`);
  return value;
}

export async function deleteParameter(ctx: EngineContext, name: string): Promise<void> {
  await ignoreNotFound(ctx.clients.ssm.send(new DeleteParameterCommand({ Name: name })));
}

export async function deleteParametersByPath(ctx: EngineContext, path: string): Promise<number> {
  const ssm = ctx.clients.ssm;
  const names: string[] = [];
  let NextToken: string | undefined;
  do {
    const res = await ignoreNotFound(
      ssm.send(new GetParametersByPathCommand({ Path: path, Recursive: true, NextToken })),
    );
    if (!res) break;
    for (const p of res.Parameters ?? []) if (p.Name) names.push(p.Name);
    NextToken = res.NextToken;
  } while (NextToken);
  for (let i = 0; i < names.length; i += 10) {
    await ssm.send(new DeleteParametersCommand({ Names: names.slice(i, i + 10) }));
  }
  return names.length;
}
