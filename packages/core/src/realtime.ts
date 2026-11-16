/**
 * Realtime: server-to-browser pub/sub on AWS AppSync Events.
 *
 * - One Event API serves the platform; each stage that declares `realtime`
 *   gets a channel namespace (`names.realtimeNamespace`).
 * - Browsers connect to `wss://<app host>/__platform/realtime`, which the edge
 *   router passes to AppSync, and subscribe there. They never publish: the
 *   stage's server and worker publish with its IAM role.
 * - `subscribe: 'public'` stages subscribe with the platform's API key;
 *   `'signed-in'` stages with a short-lived token from the app's server
 *   (`REALTIME_TOKEN_PATH`), checked by the platform's Lambda authorizer.
 *
 * Everything here is isomorphic (WebCrypto, no Node imports): the SDK, the
 * authorizer and the browser client share it.
 */
import { base64url, fromBase64url } from './base64url.ts';

/** Where browsers connect (WebSocket) and read their `RealtimeClientConfig` (GET). The router answers both. */
export const REALTIME_PATH = '/__platform/realtime';
/** Where signed-in browsers get a `RealtimeToken`; served by the SDK on the app's server. */
export const REALTIME_TOKEN_PATH = '/__platform/realtime/token';
/**
 * Key of the platform's realtime entry (`RealtimeEdgeEntry`) in the route
 * store. Not a hostname, so it can never collide with a route record.
 */
export const REALTIME_KVS_KEY = '__platform/realtime';
/** AppSync's paths on its HTTP and realtime domains. */
export const APPSYNC_PUBLISH_PATH = '/event';
export const APPSYNC_REALTIME_PATH = '/event/realtime';
/** Subprotocol every AppSync Events WebSocket offers (the auth header rides in a second one). */
export const APPSYNC_SUBPROTOCOL = 'aws-appsync-event-ws';
/** AppSync accepts at most this many events per publish request. */
export const REALTIME_PUBLISH_BATCH = 5;
/** AppSync rejects a single event larger than this many bytes. */
export const REALTIME_MAX_EVENT_BYTES = 240 * 1024;

export type RealtimeSubscribe = 'public' | 'signed-in';

// ---------------------------------------------------------------- channels

/**
 * One segment of a channel: what AppSync allows, lowercased (a-z, 0-9,
 * hyphens; starts and ends with a letter or digit; at most 50 chars).
 */
const SEGMENT = '[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?';
/**
 * A channel as app code names it: 1-4 segments (`board`, `boards/b1`). The
 * stage's namespace is AppSync's first segment and AppSync allows five.
 */
export const CHANNEL_PATTERN = new RegExp(`^${SEGMENT}(?:/${SEGMENT}){0,3}$`);
/** A declared channel in `plat.config.ts`: a channel, or a prefix of 1-3 segments ending in `/*`. */
export const CHANNEL_DECLARATION_PATTERN = new RegExp(
  `^${SEGMENT}(?:/${SEGMENT}){0,3}$|^${SEGMENT}(?:/${SEGMENT}){0,2}/\\*$`,
);
export const CHANNEL_MESSAGE =
  'must be 1-4 segments of a-z, 0-9 and hyphens separated by "/", optionally ending in "/*"';
/**
 * Channels under `user/<id>` are private to the signed-in user with that id;
 * they can only be declared as `user/*`, and only with `subscribe: 'signed-in'`.
 */
export const USER_CHANNEL_PREFIX = 'user';

/** Whether `channel` (or a wildcard subscription like `boards/*`) falls under the declared `pattern`. */
export function channelMatches(pattern: string, channel: string): boolean {
  if (!pattern.endsWith('/*')) return pattern === channel;
  const prefix = pattern.slice(0, -1); // keeps the trailing "/"
  return channel.startsWith(prefix) && channel.length > prefix.length;
}

/** The declared pattern a channel (or wildcard subscription) belongs to, if any. */
export function declaredChannel(patterns: readonly string[], channel: string): string | undefined {
  return patterns.find((p) => channelMatches(p, channel));
}

/** A channel app code may publish to: concrete (no wildcard) and well formed. */
export function isChannel(channel: string): boolean {
  return CHANNEL_PATTERN.test(channel);
}

/** A channel a browser may subscribe to: a channel, or a declared-style `prefix/*` wildcard. */
export function isSubscription(channel: string): boolean {
  return CHANNEL_DECLARATION_PATTERN.test(channel);
}

/** AppSync's channel path for an app channel: `/<namespace>/<channel>`. */
export function channelPath(namespace: string, channel: string): string {
  return `/${namespace}/${channel}`;
}

/** The app channel inside an AppSync channel path, or undefined if it's in another namespace. */
export function appChannel(namespace: string, path: string): string | undefined {
  const prefix = `/${namespace}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : undefined;
}

/**
 * Problems with a stage's realtime declaration, as messages for the
 * `realtime` path of `plat.config.ts`. Shared by manifest validation and tests.
 */
export function realtimeIssues(r: {
  subscribe: RealtimeSubscribe;
  channels: readonly string[];
  auth: boolean;
  server: boolean;
}): Array<{ path: string[]; message: string }> {
  const issues: Array<{ path: string[]; message: string }> = [];
  if (r.channels.length === 0)
    issues.push({ path: ['channels'], message: 'declare at least one channel, e.g. `board: channel<T>()`' });
  if (r.subscribe === 'signed-in' && !r.auth)
    issues.push({ path: ['subscribe'], message: "'signed-in' needs `auth: true`" });
  if (r.subscribe === 'signed-in' && !r.server)
    issues.push({
      path: ['subscribe'],
      message: "'signed-in' needs `web.server`: it issues the subscribe tokens",
    });
  for (const c of r.channels) {
    const first = c.split('/')[0];
    if (first !== USER_CHANNEL_PREFIX) continue;
    if (c !== `${USER_CHANNEL_PREFIX}/*`)
      issues.push({
        path: ['channels', c],
        message: `"${USER_CHANNEL_PREFIX}" channels are private to one user: declare them as "${USER_CHANNEL_PREFIX}/*"`,
      });
    else if (r.subscribe !== 'signed-in')
      issues.push({
        path: ['channels', c],
        message: `"${USER_CHANNEL_PREFIX}/*" channels are private to one user, so they need subscribe: 'signed-in'`,
      });
  }
  return issues;
}

/**
 * Whether a signed-in user may subscribe to an app channel (or wildcard).
 * Channels under `user/<id>` belong to that user alone; a wildcard that could
 * reach another user's channels (`*`, `user/*`) is refused. Every other
 * channel is open to any signed-in user of the app.
 */
export function canSubscribe(userId: string, channel: string): boolean {
  if (!isSubscription(channel)) return false;
  const [first, second] = channel.split('/');
  if (first !== USER_CHANNEL_PREFIX) return true;
  return second === userId;
}

// ---------------------------------------------------------------- wire formats

/** What the router answers at `REALTIME_PATH` (GET): how a browser connects and subscribes. */
export interface RealtimeClientConfig {
  v: 1;
  /** AppSync's HTTP domain. Every connection and subscription must name it as `host`. */
  host: string;
  /** The stage's channel namespace; AppSync channels are `/<namespace>/<channel>`. */
  namespace: string;
  subscribe: RealtimeSubscribe;
  /** For `public`: the platform's subscribe-only API key. */
  apiKey?: string;
}

/** What the SDK answers at `REALTIME_TOKEN_PATH` for a signed-in user. */
export interface RealtimeToken {
  token: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

/**
 * The platform entry in the route store (`REALTIME_KVS_KEY`), written by the
 * control plane: where AppSync is, and the public API key. One entry for every
 * stage, so a replaced key reaches every app at once.
 */
export interface RealtimeEdgeEntry {
  v: 1;
  /** Realtime domain (the WebSocket origin). */
  o: string;
  /** HTTP domain (the `host` browsers name). */
  h: string;
  /** Subscribe-only API key for `public` stages. */
  k: string;
}

// ---------------------------------------------------------------- tokens

/**
 * Claims of a subscribe token. Short keys: the token rides in the WebSocket
 * subprotocol header and in every subscribe message.
 */
export interface RealtimeClaims {
  /** App and stage: the authorizer finds the stage key and namespace from them. */
  a: string;
  s: string;
  /** User id. */
  u: string;
  /** Expiry, epoch seconds. */
  e: number;
}

const TOKEN_PREFIX = 'pt1';
/** Lets AppSync refuse malformed tokens before invoking the authorizer (`identityValidationExpression`). */
export const REALTIME_TOKEN_PATTERN = '^pt1\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$';
/** How long a subscribe token lasts. Open subscriptions outlive it; new ones need a fresh token. */
export const REALTIME_TOKEN_TTL_SECONDS = 15 * 60;
const HKDF_INFO = 'platform:realtime-token:v1';

const encoder = new TextEncoder();

/** The HMAC key for a stage's tokens, derived from its stage key (base64url) with HKDF. */
async function tokenKey(stageKey: string) {
  const raw = await crypto.subtle.importKey('raw', fromBase64url(stageKey), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: encoder.encode(HKDF_INFO) },
    raw,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign', 'verify'],
  );
}

/** A signed subscribe token: `pt1.<claims>.<HMAC-SHA256>`, all base64url. */
export async function signRealtimeToken(stageKey: string, claims: RealtimeClaims): Promise<string> {
  const body = `${TOKEN_PREFIX}.${base64url(encoder.encode(JSON.stringify(claims)))}`;
  const sig = await crypto.subtle.sign('HMAC', await tokenKey(stageKey), encoder.encode(body));
  return `${body}.${base64url(new Uint8Array(sig))}`;
}

/**
 * The claims of a token, unverified: the authorizer needs `a` and `s` to find
 * the stage key it then verifies with. Undefined when malformed.
 */
export function peekRealtimeToken(token: string): RealtimeClaims | undefined {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) return undefined;
  try {
    const c = JSON.parse(new TextDecoder().decode(fromBase64url(parts[1]!))) as Partial<RealtimeClaims>;
    if (
      typeof c.a !== 'string' ||
      typeof c.s !== 'string' ||
      typeof c.u !== 'string' ||
      typeof c.e !== 'number'
    )
      return undefined;
    return { a: c.a, s: c.s, u: c.u, e: c.e };
  } catch {
    return undefined;
  }
}

/** The claims, if the signature is the stage key's and the token hasn't expired. */
export async function verifyRealtimeToken(
  stageKey: string,
  token: string,
  nowSeconds: number,
): Promise<RealtimeClaims | undefined> {
  const claims = peekRealtimeToken(token);
  if (!claims || claims.e <= nowSeconds) return undefined;
  const dot = token.lastIndexOf('.');
  let sig: Uint8Array<ArrayBuffer>;
  try {
    sig = fromBase64url(token.slice(dot + 1));
  } catch {
    return undefined;
  }
  const ok = await crypto.subtle.verify(
    'HMAC',
    await tokenKey(stageKey),
    sig,
    encoder.encode(token.slice(0, dot)),
  );
  return ok ? claims : undefined;
}

// ---------------------------------------------------------------- authorizer

export type RealtimeOperation = 'EVENT_CONNECT' | 'EVENT_SUBSCRIBE' | 'EVENT_PUBLISH';

/**
 * The authorizer's decision for a verified token (pure, so it's unit-tested
 * here and the Lambda only adds SSM and AppSync plumbing).
 *
 * - Connect: any valid token.
 * - Subscribe: the stage's own namespace, and `canSubscribe`.
 * - Publish: never; browsers only subscribe (servers publish with IAM).
 */
export function authorizeRealtime(input: {
  operation: RealtimeOperation;
  claims: RealtimeClaims;
  /** The namespace the token's stage owns (`names.realtimeNamespace(a, s)`). */
  namespace: string;
  /** AppSync's request: namespace name and channel path (null on connect). */
  channelNamespace: string | null;
  channel: string | null;
}): boolean {
  if (input.operation === 'EVENT_CONNECT') return true;
  if (input.operation !== 'EVENT_SUBSCRIBE') return false;
  if (input.channelNamespace !== input.namespace || !input.channel) return false;
  const channel = appChannel(input.namespace, input.channel);
  return channel !== undefined && canSubscribe(input.claims.u, channel);
}
