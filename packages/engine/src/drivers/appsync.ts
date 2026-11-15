import {
  type Api,
  type ApiKey,
  type AuthMode,
  type ChannelNamespace,
  CreateApiKeyCommand,
  CreateChannelNamespaceCommand,
  DeleteChannelNamespaceCommand,
  GetChannelNamespaceCommand,
  ListApiKeysCommand,
  ListApisCommand,
  UpdateApiKeyCommand,
  UpdateChannelNamespaceCommand,
} from '@aws-sdk/client-appsync';
import {
  type PlatformRuntimeConfig,
  platformNames,
  REALTIME_KVS_KEY,
  type RealtimeEdgeEntry,
  type RealtimeSubscribe,
} from '@ericminassian/platform-core';
import { type EngineContext, errorName, ignoreNotFound } from '../util.ts';
import { getKey, putKey } from './kvs.ts';

/**
 * AppSync Events: each stage with `realtime` gets a channel namespace in the
 * platform's one Event API (the foundation stack creates the API; the
 * emulator's is created by `ensureLocal`). Namespaces are named, not tagged
 * state, like everything else the engine owns.
 */

/**
 * How a namespace authorizes. Browsers never publish: only the stage role
 * (IAM, `appsync:EventPublish` on this namespace) can. Public stages
 * subscribe with the platform's API key; signed-in stages with a token the
 * platform's Lambda authorizer checks.
 */
export function namespaceAuthModes(subscribe: RealtimeSubscribe): {
  publishAuthModes: AuthMode[];
  subscribeAuthModes: AuthMode[];
} {
  return {
    publishAuthModes: [{ authType: 'AWS_IAM' }],
    subscribeAuthModes: [{ authType: subscribe === 'public' ? 'API_KEY' : 'AWS_LAMBDA' }],
  };
}

const QUOTA_NAME = 'Event APIs - Channel namespaces per API';

/** The Event API with this name (the platform's is `platformNames.realtimeApi`), if it exists. */
export async function findEventApi(ctx: EngineContext, name: string): Promise<Api | undefined> {
  let nextToken: string | undefined;
  do {
    const res = await ctx.clients.appsync.send(new ListApisCommand(nextToken ? { nextToken } : {}));
    const found = (res.apis ?? []).find((a) => a.name === name && a.eventConfig);
    if (found) return found;
    nextToken = res.nextToken;
  } while (nextToken);
  return undefined;
}

export async function getChannelNamespace(
  ctx: EngineContext,
  apiId: string,
  name: string,
): Promise<ChannelNamespace | undefined> {
  const res = await ignoreNotFound(ctx.clients.appsync.send(new GetChannelNamespaceCommand({ apiId, name })));
  return res?.channelNamespace;
}

/** Create the stage's namespace, or bring an existing one's auth modes in line. */
export async function ensureChannelNamespace(
  ctx: EngineContext,
  spec: { apiId: string; name: string; subscribe: RealtimeSubscribe; tags: Record<string, string> },
): Promise<{ name: string; arn?: string }> {
  const modes = namespaceAuthModes(spec.subscribe);
  const existing = await getChannelNamespace(ctx, spec.apiId, spec.name);
  if (existing) {
    if (
      !sameModes(existing.subscribeAuthModes, modes.subscribeAuthModes) ||
      !sameModes(existing.publishAuthModes, modes.publishAuthModes)
    ) {
      await ctx.clients.appsync.send(
        new UpdateChannelNamespaceCommand({ apiId: spec.apiId, name: spec.name, ...modes }),
      );
      ctx.log('info', `subscribers now ${spec.subscribe}`, `channel-namespace ${spec.name}`);
    }
    return {
      name: spec.name,
      ...(existing.channelNamespaceArn ? { arn: existing.channelNamespaceArn } : {}),
    };
  }
  try {
    const res = await ctx.clients.appsync.send(
      new CreateChannelNamespaceCommand({ apiId: spec.apiId, name: spec.name, ...modes, tags: spec.tags }),
    );
    ctx.log('info', 'created channel namespace', `channel-namespace ${spec.name}`);
    const arn = res.channelNamespace?.channelNamespaceArn;
    return { name: spec.name, ...(arn ? { arn } : {}) };
  } catch (e) {
    if (errorName(e) === 'ServiceQuotaExceededException') {
      throw new Error(
        `The platform's realtime API has no room for another channel namespace. Every stage with ` +
          `realtime (preview stages too) has one; destroy unused previews or raise the "${QUOTA_NAME}" ` +
          'quota (default 50, adjustable) in Service Quotas.',
        { cause: e },
      );
    }
    throw e;
  }
}

export async function deleteChannelNamespace(
  ctx: EngineContext,
  apiId: string,
  name: string,
): Promise<boolean> {
  const res = await ignoreNotFound(
    ctx.clients.appsync.send(new DeleteChannelNamespaceCommand({ apiId, name })),
  );
  if (res === undefined) return false;
  ctx.log('info', 'deleted channel namespace', `channel-namespace ${name}`);
  return true;
}

function sameModes(a: AuthMode[] | undefined, b: AuthMode[]): boolean {
  const key = (m: AuthMode[] | undefined) =>
    (m ?? [])
      .map((x) => x.authType ?? '')
      .toSorted((p, q) => (p < q ? -1 : p > q ? 1 : 0))
      .join(',');
  return key(a) === key(b);
}

// ---------------------------------------------------------------- public API key

const DAY = 86_400;
/**
 * AppSync caps a key's life at 365 days from now (rounded down to the hour);
 * a day less keeps clear of that edge. The key is extended, never replaced,
 * so its value (what public browsers subscribe with) stays the same.
 */
const KEY_LIFETIME = 364 * DAY;
/** Extend once fewer days than this remain: about monthly with a daily caller. */
const KEY_RENEW_BELOW = 335 * DAY;

/**
 * The API's subscribe-only key for `public` stages, found by its description.
 * Created when missing (or expired); extended when it has under 335 days
 * left. The control plane calls this nightly and on every realtime deploy.
 * Returns the key (its id is the value browsers send).
 */
export async function ensurePublicApiKey(
  ctx: EngineContext,
  apiId: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<string> {
  const keys: ApiKey[] = [];
  let nextToken: string | undefined;
  do {
    const res = await ctx.clients.appsync.send(
      new ListApiKeysCommand({ apiId, ...(nextToken ? { nextToken } : {}) }),
    );
    keys.push(...(res.apiKeys ?? []));
    nextToken = res.nextToken;
  } while (nextToken);
  const live = keys
    .filter((k) => k.description === platformNames.realtimePublicKey && k.id && (k.expires ?? 0) > nowSeconds)
    .toSorted((a, b) => (b.expires ?? 0) - (a.expires ?? 0))[0];
  if (live?.id) {
    if ((live.expires ?? 0) - nowSeconds < KEY_RENEW_BELOW) {
      await ctx.clients.appsync.send(
        new UpdateApiKeyCommand({ apiId, id: live.id, expires: nowSeconds + KEY_LIFETIME }),
      );
      ctx.log('info', 'extended the public subscribe key', `api-key ${platformNames.realtimePublicKey}`);
    }
    return live.id;
  }
  const created = await ctx.clients.appsync.send(
    new CreateApiKeyCommand({
      apiId,
      description: platformNames.realtimePublicKey,
      expires: nowSeconds + KEY_LIFETIME,
    }),
  );
  const id = created.apiKey?.id;
  if (!id) throw new Error('AppSync created an API key without an id');
  // A new value only reaches browsers through the route-store entry; public
  // stages' open connections keep working, new ones pick up the new key.
  ctx.log('warn', 'created a new public subscribe key', `api-key ${platformNames.realtimePublicKey}`);
  return id;
}

// ---------------------------------------------------------------- platform entry

/**
 * Make the platform's realtime usable: the public key exists and is far from
 * expiry, and the router's entry (`REALTIME_KVS_KEY`) names AppSync's domains
 * and that key. Written only when it changed, so the nightly call is a read.
 * Returns the entry (what `plat dev`'s local router serves), or undefined on
 * a platform without realtime. Without a route store (the emulator) nothing
 * is written.
 */
export async function ensureRealtimePlatform(
  ctx: EngineContext,
  platform: PlatformRuntimeConfig,
): Promise<RealtimeEdgeEntry | undefined> {
  const rt = platform.realtime;
  if (!rt) return undefined;
  const key = await ensurePublicApiKey(ctx, rt.apiId);
  const entry: RealtimeEdgeEntry = { v: 1, o: rt.realtimeDomain, h: rt.httpDomain, k: key };
  if (platform.kvsArn) {
    const value = JSON.stringify(entry);
    if ((await getKey(ctx, platform.kvsArn, REALTIME_KVS_KEY)) !== value) {
      await putKey(ctx, platform.kvsArn, REALTIME_KVS_KEY, value);
      ctx.log('info', 'updated the realtime route entry', `route ${REALTIME_KVS_KEY}`);
    }
  }
  return entry;
}
