import { GetParameterCommand, GetParametersByPathCommand } from '@aws-sdk/client-ssm';
import { type PlatformRuntimeConfig, platformNames } from '@eric-minassian/platform-core';
import platformConfig from '../../../platform.config.ts';
import { aws } from './aws.ts';

/** Repo-root `platform.config.ts` (members, limits, reserved names), bundled at build time. */
export const config = platformConfig;

const CACHE_MS = 5 * 60_000;

function cached<T>(load: () => Promise<T>): { get(): Promise<T>; reset(): void } {
  let entry: { value: Promise<T>; at: number } | undefined;
  return {
    get() {
      if (!entry || Date.now() - entry.at > CACHE_MS) {
        const value = load();
        entry = { value, at: Date.now() };
        value.catch(() => {
          entry = undefined;
        });
      }
      return entry.value;
    },
    reset() {
      entry = undefined;
    },
  };
}

/**
 * Shared resources the foundation created (buckets, tables, KVS, distribution, user pool).
 * `PLATFORM_RUNTIME_CONFIG` (JSON) overrides SSM for local work and tests.
 */
const runtimeConfig = cached(async (): Promise<PlatformRuntimeConfig> => {
  const override = process.env.PLATFORM_RUNTIME_CONFIG;
  if (override) return JSON.parse(override) as PlatformRuntimeConfig;
  const res = await aws.ssm().send(new GetParameterCommand({ Name: platformNames.runtimeConfigParameter }));
  if (!res.Parameter?.Value) throw new Error(`${platformNames.runtimeConfigParameter} is empty`);
  return JSON.parse(res.Parameter.Value) as PlatformRuntimeConfig;
});

export const getRuntimeConfig = (): Promise<PlatformRuntimeConfig> => runtimeConfig.get();

/** HS256 key for platform tokens and console sessions. `PLATFORM_SESSION_KEY` overrides SSM. */
const sessionKey = cached(async (): Promise<Uint8Array> => {
  const override = process.env.PLATFORM_SESSION_KEY;
  const value =
    override ??
    (
      await aws
        .ssm()
        .send(new GetParameterCommand({ Name: platformNames.sessionKeyParameter, WithDecryption: true }))
    ).Parameter?.Value;
  if (!value || value.length < 32) throw new Error('session key is missing or shorter than 32 chars');
  return new TextEncoder().encode(value);
});

export const getSessionKey = (): Promise<Uint8Array> => sessionKey.get();

export interface GithubAppSettings {
  clientId: string;
  clientSecret: string;
  appId?: string;
  privateKey?: string;
}

/** GitHub App used for console sign-in and (optionally) error issues. Null until configured. */
const githubApp = cached(async (): Promise<GithubAppSettings | null> => {
  const values: Record<string, string> = {};
  let NextToken: string | undefined;
  do {
    const res = await aws.ssm().send(
      new GetParametersByPathCommand({
        Path: platformNames.githubAppParameterPrefix,
        WithDecryption: true,
        NextToken,
      }),
    );
    for (const p of res.Parameters ?? []) {
      if (p.Name && p.Value) values[p.Name.slice(platformNames.githubAppParameterPrefix.length)] = p.Value;
    }
    NextToken = res.NextToken;
  } while (NextToken);
  if (!values.client_id || !values.client_secret) return null;
  return {
    clientId: values.client_id,
    clientSecret: values.client_secret,
    ...(values.app_id ? { appId: values.app_id } : {}),
    ...(values.private_key ? { privateKey: values.private_key } : {}),
  };
});

export const getGithubApp = (): Promise<GithubAppSettings | null> => githubApp.get();

/** Public origin of the console (`https://platform.ericminassian.com`). */
export function consoleUrl(): string {
  return process.env.PLATFORM_CONSOLE_URL ?? `https://${config.consoleHost}`;
}

export function logRetentionDays(stage: string): number {
  return stage === 'prod' ? config.telemetry.logRetentionDays.prod : config.telemetry.logRetentionDays.other;
}
