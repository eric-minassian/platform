/**
 * App secrets as SSM SecureStrings. Stage values live under
 * `names.secretsPath(app, stage)`; app-wide values under `names.sharedSecretsPath(app)`
 * (the SDK prefers the stage value). Values are write-only through the API.
 */
import { DeleteParameterCommand, GetParametersByPathCommand, PutParameterCommand } from '@aws-sdk/client-ssm';
import { ENV_NAME_PATTERN, names, type SecretInfo, TAGS } from '@eric-minassian/platform-core';
import { aws } from './aws.ts';

export function secretPath(app: string, name: string, stage?: string): string {
  if (!ENV_NAME_PATTERN.test(name)) throw new Error(`secret name ${name} must match ${ENV_NAME_PATTERN}`);
  return `${stage ? names.secretsPath(app, stage) : names.sharedSecretsPath(app)}${name}`;
}

async function listPath(path: string): Promise<Array<{ name: string; updatedAt?: string }>> {
  const out: Array<{ name: string; updatedAt?: string }> = [];
  let NextToken: string | undefined;
  do {
    const res = await aws
      .ssm()
      .send(new GetParametersByPathCommand({ Path: path, WithDecryption: false, NextToken }));
    for (const p of res.Parameters ?? []) {
      if (!p.Name) continue;
      out.push({
        name: p.Name.slice(path.length),
        ...(p.LastModifiedDate ? { updatedAt: p.LastModifiedDate.toISOString() } : {}),
      });
    }
    NextToken = res.NextToken;
  } while (NextToken);
  return out;
}

/** Shared secrets plus the given stage's overrides. */
export async function listSecrets(app: string, stage?: string): Promise<SecretInfo[]> {
  const shared = (await listPath(names.sharedSecretsPath(app))).map((s) => ({
    ...s,
    scope: 'shared' as const,
  }));
  const staged = stage
    ? (await listPath(names.secretsPath(app, stage))).map((s) => ({ ...s, scope: 'stage' as const, stage }))
    : [];
  return [...staged, ...shared].sort((a, b) => a.name.localeCompare(b.name));
}

export async function putSecret(app: string, name: string, value: string, stage?: string): Promise<void> {
  const Name = secretPath(app, name, stage);
  // SSM accepts tags only on create (not together with Overwrite), so create first, then overwrite.
  try {
    await aws.ssm().send(
      new PutParameterCommand({
        Name,
        Value: value,
        Type: 'SecureString',
        Tags: [
          { Key: TAGS.managed, Value: 'true' },
          { Key: TAGS.app, Value: app },
          ...(stage ? [{ Key: TAGS.stage, Value: stage }] : []),
        ],
      }),
    );
  } catch (err) {
    if ((err as { name?: string }).name !== 'ParameterAlreadyExists') throw err;
    await aws
      .ssm()
      .send(new PutParameterCommand({ Name, Value: value, Type: 'SecureString', Overwrite: true }));
  }
}

export async function deleteSecret(app: string, name: string, stage?: string): Promise<void> {
  await aws
    .ssm()
    .send(new DeleteParameterCommand({ Name: secretPath(app, name, stage) }))
    .catch((err: { name?: string }) => {
      if (err.name !== 'ParameterNotFound') throw err;
    });
}
