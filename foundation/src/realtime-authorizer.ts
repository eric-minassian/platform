/**
 * The Event API's Lambda authorizer: checks the subscribe tokens a signed-in
 * stage's server issues (`REALTIME_TOKEN_PATH`). Public stages subscribe with
 * the API key and never reach it.
 *
 * A token names its app and stage, so the authorizer reads that stage's key
 * from SSM, verifies the signature, then lets `authorizeRealtime` decide:
 * connect with any valid token; subscribe only in the token's own namespace,
 * with `user/<id>` channels kept to that user; never publish.
 *
 * AppSync caches each answer per token, operation and channel for
 * `ttlOverride` seconds, so a busy channel costs one invocation per token.
 */
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
// Subpaths, not the package root: the root pulls in Effect, which would triple
// this function's bundle and slow its cold starts on the connect path.
import { APP_NAME_PATTERN, names, STAGE_NAME_PATTERN } from '@ericminassian/platform-core/naming';
import {
  authorizeRealtime,
  peekRealtimeToken,
  type RealtimeOperation,
  verifyRealtimeToken,
} from '@ericminassian/platform-core/realtime';

/** What AppSync sends (the spike logged it; the docs list the same fields). */
export interface AuthorizerEvent {
  authorizationToken?: string;
  requestContext?: {
    apiId?: string;
    operation?: RealtimeOperation;
    channelNamespaceName?: string | null;
    channel?: string | null;
  };
}

export interface AuthorizerResult {
  isAuthorized: boolean;
  /** Seconds AppSync caches this answer (per token, operation and channel). */
  ttlOverride: number;
}

export interface AuthorizerDeps {
  /** The stage's key (base64url), or undefined when the stage has none (destroyed, or never deployed). */
  stageKey(app: string, stage: string): Promise<string | undefined>;
  nowSeconds(): number;
}

/** AppSync accepts at most an hour. */
const MAX_TTL = 3600;
/**
 * Refusals of malformed, forged or expired tokens are cached briefly: long
 * enough to absorb a client retrying in a loop, short enough not to matter.
 */
const REFUSED_TTL = 60;

export function createAuthorizer(
  deps: AuthorizerDeps,
): (event: AuthorizerEvent) => Promise<AuthorizerResult> {
  return async (event) => {
    const refuse = { isAuthorized: false, ttlOverride: REFUSED_TTL };
    const token = event.authorizationToken ?? '';
    const claimed = peekRealtimeToken(token);
    // Validated before the app and stage reach an SSM parameter name.
    if (!claimed || !APP_NAME_PATTERN.test(claimed.a) || !STAGE_NAME_PATTERN.test(claimed.s)) return refuse;
    const key = await deps.stageKey(claimed.a, claimed.s);
    if (!key) return refuse;
    const now = deps.nowSeconds();
    const claims = await verifyRealtimeToken(key, token, now);
    if (!claims) return refuse;
    const ctx = event.requestContext ?? {};
    const isAuthorized = authorizeRealtime({
      operation: ctx.operation ?? 'EVENT_PUBLISH',
      claims,
      namespace: names.realtimeNamespace(claims.a, claims.s),
      channelNamespace: ctx.channelNamespaceName ?? null,
      channel: ctx.channel ?? null,
    });
    // The answer holds for the token's whole life: its claims can't change.
    return { isAuthorized, ttlOverride: Math.max(0, Math.min(MAX_TTL, claims.e - now)) };
  };
}

/** How long a stage key (or its absence) is remembered by a warm environment. */
const KEY_CACHE_MS = 5 * 60_000;

/** Stage keys from SSM, cached per environment. */
export function ssmStageKeys(
  ssm: Pick<SSMClient, 'send'>,
  now = () => Date.now(),
): AuthorizerDeps['stageKey'] {
  const cache = new Map<string, { value: string | undefined; at: number }>();
  return async (app, stage) => {
    const name = names.stageKeyParameter(app, stage);
    const hit = cache.get(name);
    if (hit && now() - hit.at < KEY_CACHE_MS) return hit.value;
    let value: string | undefined;
    try {
      const res = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
      value = res.Parameter?.Value;
    } catch (e) {
      // A missing key means no such stage: refuse (and remember that). Anything else is
      // AppSync's to treat as unauthorized without caching, so let it throw.
      if ((e as { name?: string }).name !== 'ParameterNotFound') throw e;
    }
    cache.set(name, { value, at: now() });
    return value;
  };
}

// Created on first use, so importing this module (tests) needs no AWS configuration.
let stageKeys: AuthorizerDeps['stageKey'] | undefined;

export const handler = createAuthorizer({
  stageKey: (app, stage) => {
    stageKeys ??= ssmStageKeys(new SSMClient({}));
    return stageKeys(app, stage);
  },
  nowSeconds: () => Math.floor(Date.now() / 1000),
});
