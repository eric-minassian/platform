import {
  APP_CONFIG_FILE,
  channelPath,
  declaredChannel,
  isChannel,
  REALTIME_MAX_EVENT_BYTES,
  REALTIME_PUBLISH_BATCH,
  REALTIME_TOKEN_PATH,
  REALTIME_TOKEN_TTL_SECONDS,
  type RealtimeBindings,
  type RealtimeToken,
  signRealtimeToken,
} from '@ericminassian/platform-core';
import type { ChannelEvent, ChannelName } from '../register.ts';
import { getUser, unauthorized } from './auth/index.ts';
import { getBindings } from './bindings.ts';
import { span, uninstrumentedFetch } from './telemetry.ts';

export interface Realtime {
  /**
   * Push `event` to every browser subscribed to `channel` (or to a wildcard
   * above it). Delivery is at most once and nothing is stored: a browser that
   * wasn't connected doesn't get it later.
   */
  publish<C extends ChannelName>(channel: C, event: ChannelEvent<C>): Promise<void>;
  /** Several events to one channel, in order (sent five per request, AppSync's limit). */
  publishMany<C extends ChannelName>(channel: C, events: Iterable<ChannelEvent<C>>): Promise<void>;
}

/**
 * Why `channel` can't be published to, or undefined if it can. `declared` is
 * `realtime.channels` from `plat.config.ts`. Shared with the in-memory platform.
 */
export function realtimeChannelError(channel: string, declared: readonly string[]): string | undefined {
  if (!isChannel(channel))
    return `Invalid realtime channel "${channel}": use 1-4 segments of a-z, 0-9 and hyphens separated by "/" (no wildcards when publishing).`;
  if (!declaredChannel(declared, channel))
    return `Realtime channel "${channel}" isn't declared under realtime.channels in ${APP_CONFIG_FILE} (declared: ${declared.join(', ') || 'none'}).`;
  return undefined;
}

/** Each event as the JSON string AppSync carries; throws on what can't be sent. */
export function encodeRealtimeEvents(channel: string, events: readonly unknown[]): string[] {
  return events.map((event) => {
    const json = JSON.stringify(event);
    if (json === undefined)
      throw new Error(`realtime.publish("${channel}"): the event must be JSON (got ${typeof event})`);
    const bytes = new TextEncoder().encode(json).byteLength;
    if (bytes > REALTIME_MAX_EVENT_BYTES)
      throw new Error(
        `realtime.publish("${channel}"): the event is ${bytes} bytes; AppSync's limit is ${REALTIME_MAX_EVENT_BYTES}. Publish an id and let browsers fetch the rest.`,
      );
    return json;
  });
}

function realtimeBindings(): RealtimeBindings {
  const r = getBindings().realtime;
  if (!r)
    throw new Error(
      `Realtime is not enabled for this app. Add a \`realtime\` block with its channels to ${APP_CONFIG_FILE}.`,
    );
  return r;
}

/** Sends one AppSync publish request (`events` are JSON strings, at most five). */
type Transport = (r: RealtimeBindings, path: string, events: string[]) => Promise<void>;

let transport: Transport | undefined;

/** Replace how events are sent (tests: `captureRealtime` in the testing module). `undefined` restores AppSync. */
export function setRealtimeTransport(t: Transport | undefined): void {
  transport = t;
}

type Signer = { sign(request: unknown): Promise<{ headers: Record<string, string> }> };
const signers = new Map<string, Promise<Signer>>();

/**
 * SigV4 signer for AppSync in `region`, created on first publish. The imports
 * are lazy so apps that never publish don't load them at cold start.
 */
function signer(region: string): Promise<Signer> {
  let s = signers.get(region);
  if (!s) {
    s = (async () => {
      const [{ SignatureV4 }, { Hash }, { defaultProvider }] = await Promise.all([
        import('@smithy/signature-v4'),
        import('@smithy/hash-node'),
        import('@aws-sdk/credential-provider-node'),
      ]);
      return new SignatureV4({
        service: 'appsync',
        region,
        // Memoized: refreshes the role's credentials before they expire.
        credentials: defaultProvider(),
        sha256: Hash.bind(null, 'sha256'),
      });
    })();
    signers.set(region, s);
  }
  return s;
}

const appsync: Transport = async (r, path, events) => {
  const url = new URL(r.publishUrl);
  const body = JSON.stringify({ channel: path, events });
  const sigv4 = await signer(getBindings().region);
  const signed = await sigv4.sign({
    method: 'POST',
    protocol: url.protocol,
    hostname: url.hostname,
    ...(url.port ? { port: Number(url.port) } : {}),
    path: url.pathname,
    query: {},
    headers: { host: url.host, 'content-type': 'application/json' },
    body,
  });
  // fetch sets Host from the URL (the same value that was signed).
  const { host: _host, ...headers } = signed.headers;
  const res = await uninstrumentedFetch()(url, { method: 'POST', headers, body });
  const text = await res.text();
  let parsed: { failed?: unknown[]; errors?: Array<{ errorType?: string; message?: string }> } = {};
  try {
    parsed = text ? (JSON.parse(text) as typeof parsed) : {};
  } catch {
    // Not JSON: report the status and the start of the body below.
  }
  if (!res.ok) {
    const e = parsed.errors?.[0];
    throw new Error(
      `realtime.publish to ${path} failed: AppSync answered ${res.status}${e ? ` ${e.errorType ?? ''}: ${e.message ?? ''}` : ` ${text.slice(0, 200)}`}`.trim(),
    );
  }
  if (parsed.failed?.length)
    throw new Error(
      `realtime.publish to ${path}: AppSync rejected ${parsed.failed.length} of ${events.length} events: ${JSON.stringify(parsed.failed).slice(0, 300)}`,
    );
};

async function send(channel: string, events: readonly unknown[]): Promise<void> {
  const r = realtimeBindings();
  const problem = realtimeChannelError(channel, r.channels);
  if (problem) throw new Error(problem);
  const encoded = encodeRealtimeEvents(channel, events);
  if (encoded.length === 0) return;
  const path = channelPath(r.namespace, channel);
  // The declared pattern names the span: channel ids would make every span unique.
  await span('realtime.publish', declaredChannel(r.channels, channel), async () => {
    for (let i = 0; i < encoded.length; i += REALTIME_PUBLISH_BATCH)
      await (transport ?? appsync)(r, path, encoded.slice(i, i + REALTIME_PUBLISH_BATCH));
  });
}

export const realtime: Realtime = {
  publish: (channel, event) => send(channel, [event]),
  publishMany: (channel, events) => send(channel, [...events]),
};

// ---------------------------------------------------------------- /__platform/realtime/token

/**
 * `REALTIME_TOKEN_PATH`: a subscribe token for the signed-in user of a
 * `signed-in` stage (the browser can't present its session cookie to AppSync).
 * Null for other paths.
 */
export async function handleRealtimeRoute(request: Request): Promise<Response | null> {
  if (new URL(request.url).pathname !== REALTIME_TOKEN_PATH) return null;
  const b = getBindings();
  if (b.realtime?.subscribe !== 'signed-in')
    return Response.json(
      { error: { code: 'not_found', message: 'This app has no signed-in realtime channels' } },
      { status: 404 },
    );
  if (request.method !== 'GET')
    return Response.json(
      { error: { code: 'method_not_allowed', message: 'Use GET' } },
      { status: 405, headers: { allow: 'GET' } },
    );
  const user = await getUser(request);
  if (!user) return unauthorized();
  if (!b.stageKey)
    throw new Error('This stage has no stage key, so it cannot issue realtime tokens. Redeploy it.');
  const expires = Math.floor(Date.now() / 1000) + REALTIME_TOKEN_TTL_SECONDS;
  const body: RealtimeToken = {
    token: await signRealtimeToken(b.stageKey, { a: b.app, s: b.stage, u: user.id, e: expires }),
    expiresAt: expires * 1000,
  };
  return Response.json(body, { headers: { 'cache-control': 'no-store' } });
}
