/**
 * App secrets as SSM SecureStrings. Stage values live under
 * `names.secretsPath(app, stage)`; app-wide values under `names.sharedSecretsPath(app)`
 * (the SDK prefers the stage value). Values are write-only through the API.
 */
import { DeleteParameterCommand, GetParametersByPathCommand, PutParameterCommand } from '@aws-sdk/client-ssm';
import { ENV_NAME_PATTERN, names, type SecretInfo, TAGS } from '@ericminassian/platform-core';
import { Context, Effect, Layer } from 'effect';
import { Aws, AwsError, tryAws } from './aws.ts';

/** SSM parameter name of a secret: the stage's value, or the app-wide one without `stage`. */
export function secretPath(app: string, name: string, stage?: string): string {
  if (!ENV_NAME_PATTERN.test(name)) throw new Error(`secret name ${name} must match ${ENV_NAME_PATTERN}`);
  return `${stage ? names.secretsPath(app, stage) : names.sharedSecretsPath(app)}${name}`;
}

export class AppSecrets extends Context.Service<
  AppSecrets,
  {
    /** Shared secrets plus the stage's overrides (names and dates, never values). */
    list(app: string, stage?: string): Effect.Effect<ReadonlyArray<SecretInfo>>;
    /** Sets the stage's value, or the app-wide one without `stage`. */
    put(app: string, name: string, value: string, stage?: string): Effect.Effect<void>;
    /** Deleting a secret that isn't set succeeds. */
    remove(app: string, name: string, stage?: string): Effect.Effect<void>;
  }
>()('@ericminassian/platform-control-plane/AppSecrets') {
  static readonly layer: Layer.Layer<AppSecrets, never, Aws> = Layer.effect(
    AppSecrets,
    Effect.gen(function* () {
      const aws = yield* Aws;

      const listPath = Effect.fnUntraced(function* (path: string) {
        const out: Array<{ name: string; updatedAt?: string }> = [];
        let NextToken: string | undefined;
        do {
          const res = yield* tryAws(() =>
            aws.ssm().send(new GetParametersByPathCommand({ Path: path, WithDecryption: false, NextToken })),
          );
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
      });

      const list = Effect.fn('AppSecrets.list')(function* (app: string, stage?: string) {
        const shared = (yield* listPath(names.sharedSecretsPath(app))).map(
          (s): SecretInfo => ({ ...s, scope: 'shared' }),
        );
        const staged = stage
          ? (yield* listPath(names.secretsPath(app, stage))).map(
              (s): SecretInfo => ({ ...s, scope: 'stage', stage }),
            )
          : [];
        return [...staged, ...shared].sort((a, b) => a.name.localeCompare(b.name));
      }, Effect.orDie);

      const put = Effect.fn('AppSecrets.put')(function* (
        app: string,
        name: string,
        value: string,
        stage?: string,
      ) {
        const Name = secretPath(app, name, stage);
        // SSM accepts tags only on create (not together with Overwrite), so create first, then overwrite.
        yield* tryAws(() =>
          aws.ssm().send(
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
          ),
        ).pipe(
          Effect.catchIf(AwsError.is('ParameterAlreadyExists'), () =>
            tryAws(() =>
              aws
                .ssm()
                .send(new PutParameterCommand({ Name, Value: value, Type: 'SecureString', Overwrite: true })),
            ),
          ),
        );
      }, Effect.orDie);

      const remove = Effect.fn('AppSecrets.remove')(function* (app: string, name: string, stage?: string) {
        yield* tryAws(() =>
          aws.ssm().send(new DeleteParameterCommand({ Name: secretPath(app, name, stage) })),
        ).pipe(Effect.catchIf(AwsError.is('ParameterNotFound'), () => Effect.void));
      }, Effect.orDie);

      return AppSecrets.of({ list, put, remove });
    }),
  );
}
