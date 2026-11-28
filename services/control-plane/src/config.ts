/**
 * What the control plane is configured with: `platform.config.ts` (bundled at
 * build time), and the values the foundation keeps in SSM (shared resources,
 * the session key, the GitHub App). SSM reads are cached for five minutes, and
 * a failed read is retried on the next use.
 */
import { GetParameterCommand, GetParametersByPathCommand } from '@aws-sdk/client-ssm';
import { type PlatformConfig, type PlatformRuntimeConfig, platformNames } from '@ericminassian/platform-core';
import { Config, Context, Effect, Exit, Layer, Option, Redacted } from 'effect';
import platformConfig from '../../../platform.config.ts';
import { Aws, tryAws } from './aws.ts';

/** GitHub App used for console sign-in and (optionally) error issues. */
export interface GithubAppSettings {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly appId?: string | undefined;
  readonly privateKey?: string | undefined;
}

export class Settings extends Context.Service<
  Settings,
  {
    /** `platform.config.ts`: members, limits, reserved names. */
    readonly platform: PlatformConfig;
    /** Public origin of the console (`https://platform.ericminassian.com`). */
    readonly consoleUrl: string;
    /** Shared resources the foundation created (buckets, tables, KVS, distribution, user pool). */
    readonly runtime: Effect.Effect<PlatformRuntimeConfig>;
    /** HS256 key for platform tokens and console sessions. */
    readonly sessionKey: Effect.Effect<Uint8Array>;
    /** None until the GitHub App is configured (see docs/SETUP.md). */
    readonly githubApp: Effect.Effect<Option.Option<GithubAppSettings>>;
  }
>()('@ericminassian/platform-control-plane/Settings') {
  /**
   * `PLATFORM_RUNTIME_CONFIG` (JSON) and `PLATFORM_SESSION_KEY` override SSM,
   * and `PLATFORM_CONSOLE_URL` the console origin, for local work.
   */
  static readonly layer: Layer.Layer<Settings, never, Aws> = Layer.effect(
    Settings,
    Effect.gen(function* () {
      const aws = yield* Aws;
      const env = yield* Config.all({
        consoleUrl: Config.String('PLATFORM_CONSOLE_URL').pipe(
          Config.withDefault(`https://${platformConfig.consoleHost}`),
        ),
        runtimeConfig: Config.option(Config.String('PLATFORM_RUNTIME_CONFIG')),
        sessionKey: Config.option(Config.Redacted('PLATFORM_SESSION_KEY')),
      }).pipe(Effect.orDie);

      /** A parameter's value; dies when it's missing or empty, as the foundation always writes them. */
      const parameter = (Name: string) =>
        tryAws(() => aws.ssm().send(new GetParameterCommand({ Name, WithDecryption: true }))).pipe(
          Effect.map((res) => res.Parameter?.Value ?? ''),
          Effect.filterOrElse(
            (value) => value !== '',
            () => Effect.die(new Error(`${Name} is empty`)),
          ),
          Effect.orDie,
        );

      const runtime: Effect.Effect<PlatformRuntimeConfig> = Option.match(env.runtimeConfig, {
        onSome: Effect.succeed,
        onNone: () => parameter(platformNames.runtimeConfigParameter),
      }).pipe(
        // Written by the foundation deploy (and `plat dev`), which share the
        // `PlatformRuntimeConfig` type with this code.
        Effect.map((json) => JSON.parse(json) as PlatformRuntimeConfig),
      );

      const sessionKey: Effect.Effect<Uint8Array> = Option.match(env.sessionKey, {
        onSome: (key) => Effect.succeed(Redacted.value(key)),
        onNone: () => parameter(platformNames.sessionKeyParameter),
      }).pipe(
        Effect.filterOrElse(
          (value) => value.length >= 32,
          () => Effect.die(new Error('the session key is shorter than 32 chars')),
        ),
        Effect.map((value): Uint8Array => new TextEncoder().encode(value)),
      );

      const githubApp = Effect.gen(function* () {
        const prefix = platformNames.githubAppParameterPrefix;
        const values: Record<string, string> = {};
        let NextToken: string | undefined;
        do {
          const res = yield* tryAws(() =>
            aws.ssm().send(new GetParametersByPathCommand({ Path: prefix, WithDecryption: true, NextToken })),
          );
          for (const p of res.Parameters ?? []) {
            if (p.Name && p.Value) values[p.Name.slice(prefix.length)] = p.Value;
          }
          NextToken = res.NextToken;
        } while (NextToken);
        if (!values.client_id || !values.client_secret) return Option.none<GithubAppSettings>();
        return Option.some<GithubAppSettings>({
          clientId: values.client_id,
          clientSecret: values.client_secret,
          appId: values.app_id,
          privateKey: values.private_key,
        });
      }).pipe(Effect.orDie);

      const cached = <A>(load: Effect.Effect<A>) =>
        Effect.cachedWithTTL(load, (exit) => (Exit.isSuccess(exit) ? '5 minutes' : 0));

      return Settings.of({
        platform: platformConfig,
        consoleUrl: env.consoleUrl,
        runtime: yield* cached(runtime),
        sessionKey: yield* cached(sessionKey),
        githubApp: yield* cached(githubApp),
      });
    }),
  );
}

/** CloudWatch log retention for a stage's log groups. */
export function logRetentionDays(platform: PlatformConfig, stage: string): number {
  return stage === 'prod'
    ? platform.telemetry.logRetentionDays.prod
    : platform.telemetry.logRetentionDays.other;
}
