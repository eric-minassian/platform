/**
 * The browser's realtime connection (behind `@ericminassian/platform/client`).
 * Browser-safe: no Node, AWS SDK or core-root imports. Everything it touches
 * in the page comes through `RealtimeEnv`, so tests drive it with fakes.
 *
 * One WebSocket per page carries every subscription:
 *
 *   GET REALTIME_PATH        → RealtimeClientConfig (from the edge router)
 *   GET REALTIME_TOKEN_PATH  → RealtimeToken (signed-in stages, from the app's server)
 *   WS  REALTIME_PATH        → AppSync Events (passed through by the router)
 *     → connection_init, ← connection_ack, → subscribe…, ← data / ka …
 */
import {
  APPSYNC_SUBPROTOCOL,
  channelPath,
  isSubscription,
  REALTIME_PATH,
  REALTIME_TOKEN_PATH,
  type RealtimeClientConfig,
  type RealtimeToken,
} from '@ericminassian/platform-core/realtime';
import type { ChannelEvent, ChannelSubscription } from './register.ts';

/**
 * - `idle`: no connection (nothing subscribed, or the tab has been hidden a while).
 * - `connecting` / `reconnecting`: on the way (again) to `connected`.
 * - `connected`: subscriptions are live. Events aren't stored, so re-read what
 *   the page shows every time the status becomes `connected`.
 * - `unauthorized`: a `signed-in` app and nobody is signed in. It retries on
 *   the next `subscribe` and when the tab becomes visible.
 */
export type RealtimeStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'unauthorized';

export interface RealtimeClient {
  /**
   * Call `onEvent` with every event published to `channel` (or, for a
   * declared `prefix/*` pattern, to any channel below it) while subscribed.
   * Returns the unsubscribe function.
   */
  subscribe<C extends ChannelSubscription>(channel: C, onEvent: (event: ChannelEvent<C>) => void): () => void;
  readonly status: RealtimeStatus;
  /** Called on every status change; returns the function that stops it. */
  onStatus(listener: (status: RealtimeStatus) => void): () => void;
}

/** The slice of the browser's WebSocket the client uses. */
export interface SocketLike {
  addEventListener(
    type: 'open' | 'close' | 'error',
    listener: (event: unknown) => void,
    options: { signal: AbortSignal },
  ): void;
  addEventListener(
    type: 'message',
    listener: (event: { data: unknown }) => void,
    options: { signal: AbortSignal },
  ): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface FetchResponseLike {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

/** What the client needs from the page; the browser's own by default. */
export interface RealtimeEnv {
  WebSocket: new (url: string, protocols: string[]) => SocketLike;
  fetch(
    url: string,
    init: { credentials: 'same-origin'; headers: Record<string, string> },
  ): Promise<FetchResponseLike>;
  location: { readonly protocol: string; readonly host: string };
  document?: {
    readonly visibilityState: string;
    addEventListener(type: 'visibilitychange', listener: () => void): void;
  };
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
  random(): number;
  /** Where listener errors and protocol problems go. */
  report(message: string, error?: unknown): void;
}

/** Reconnect backoff: doubles from 1 s up to 30 s, each wait randomized to 50-100% so pages don't reconnect in step. */
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
/** After the last unsubscribe, keep the socket briefly: a remount often subscribes again at once. */
const IDLE_CLOSE_MS = 1_000;
/** A tab hidden this long lets its socket go (connection-minutes are billed), and reconnects when shown. */
const HIDDEN_CLOSE_MS = 5 * 60_000;
/** Fetch a new token when the current one has less than this left. */
const TOKEN_REFRESH_MS = 60_000;
/** Until AppSync's connection_ack says otherwise (it sends 300 000; keep-alives come every 60 s). */
const DEFAULT_KA_TIMEOUT_MS = 300_000;
/** A connection with no connection_ack by then is given up on and retried. */
const CONNECT_TIMEOUT_MS = 15_000;

interface Subscription {
  readonly id: string;
  readonly channel: string;
  readonly listeners: Set<(event: unknown) => void>;
}

type Auth = Record<string, string>;

class Unauthorized extends Error {}

function base64url(text: string): string {
  let bin = '';
  for (const b of new TextEncoder().encode(text)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function createRealtimeClient(env: RealtimeEnv): RealtimeClient {
  const subscriptions = new Map<string, Subscription>();
  const byId = new Map<string, Subscription>();
  const statusListeners = new Set<(status: RealtimeStatus) => void>();
  let status: RealtimeStatus = 'idle';
  let config: RealtimeClientConfig | undefined;
  let token: RealtimeToken | undefined;
  let socket: SocketLike | undefined;
  /** Aborted to detach the client's listeners from `socket` when it's let go. */
  let socketListeners: AbortController | undefined;
  /** Subscriptions are sent only after connection_ack. */
  let acked = false;
  /** Bumped whenever a connection attempt is abandoned, so its late callbacks do nothing. */
  let generation = 0;
  let connecting = false;
  let attempts = 0;
  let nextId = 0;
  let kaTimeoutMs = DEFAULT_KA_TIMEOUT_MS;
  let kaTimer: unknown;
  let reconnectTimer: unknown;
  let idleTimer: unknown;
  let hiddenTimer: unknown;
  /** The socket was let go because the tab is hidden; reconnect when it's visible. */
  let parkedHidden = false;

  const clear = (t: unknown) => {
    if (t !== undefined) env.clearTimeout(t);
  };

  function setStatus(next: RealtimeStatus) {
    if (next === status) return;
    status = next;
    // A snapshot: listeners that (un)subscribe while being called don't change this round.
    for (const l of Array.from(statusListeners)) {
      try {
        l(next);
      } catch (e) {
        env.report('realtime: a status listener threw', e);
      }
    }
  }

  async function loadConfig(): Promise<RealtimeClientConfig> {
    if (config) return config;
    const res = await env.fetch(REALTIME_PATH, {
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    });
    if (!res.ok)
      throw new Error(
        res.status === 404
          ? `realtime: ${REALTIME_PATH} answered 404; is \`realtime\` declared in plat.config.ts and deployed?`
          : `realtime: ${REALTIME_PATH} answered ${res.status}`,
      );
    config = (await res.json()) as RealtimeClientConfig;
    return config;
  }

  /** The authorization object AppSync wants on the connection and on every subscribe. */
  async function authorization(cfg: RealtimeClientConfig): Promise<Auth> {
    if (cfg.subscribe === 'public') return publicAuth(cfg);
    if (!token || token.expiresAt - env.now() < TOKEN_REFRESH_MS) {
      const res = await env.fetch(REALTIME_TOKEN_PATH, {
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      });
      if (res.status === 401) {
        token = undefined;
        throw new Unauthorized();
      }
      if (!res.ok) throw new Error(`realtime: ${REALTIME_TOKEN_PATH} answered ${res.status}`);
      token = (await res.json()) as RealtimeToken;
    }
    return { host: cfg.host, Authorization: token.token };
  }

  function wantsConnection(): boolean {
    return subscriptions.size > 0 && !parkedHidden;
  }

  function resetKeepAlive() {
    clear(kaTimer);
    // No keep-alive (or anything else) in time means the connection is dead
    // even if the socket hasn't noticed: drop it and reconnect.
    kaTimer = env.setTimeout(() => {
      env.report('realtime: no keep-alive from AppSync; reconnecting');
      drop(true);
    }, kaTimeoutMs);
  }

  /** Let the current socket go (if any) and, if wanted and asked to, try again later. */
  function drop(reconnect: boolean) {
    generation++;
    connecting = false;
    clear(kaTimer);
    kaTimer = undefined;
    const s = socket;
    socket = undefined;
    acked = false;
    if (s) {
      socketListeners?.abort();
      socketListeners = undefined;
      try {
        s.close(1000);
      } catch {
        // Already closed.
      }
    }
    if (reconnect && wantsConnection()) scheduleReconnect();
    else if (!wantsConnection() && status !== 'unauthorized') setStatus('idle');
  }

  function scheduleReconnect() {
    clear(reconnectTimer);
    attempts++;
    const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (attempts - 1));
    const delay = ceiling * (0.5 + env.random() / 2);
    setStatus('reconnecting');
    reconnectTimer = env.setTimeout(() => {
      reconnectTimer = undefined;
      void connect();
    }, delay);
  }

  function ensureConnected() {
    if (socket || connecting || reconnectTimer !== undefined || !wantsConnection()) return;
    void connect();
  }

  async function connect() {
    if (!wantsConnection()) {
      setStatus('idle');
      return;
    }
    const gen = ++generation;
    connecting = true;
    setStatus(attempts === 0 ? 'connecting' : 'reconnecting');
    let cfg: RealtimeClientConfig;
    let auth: Auth;
    try {
      cfg = await loadConfig();
      auth = await authorization(cfg);
    } catch (e) {
      if (gen !== generation) return;
      connecting = false;
      if (e instanceof Unauthorized) {
        setStatus('unauthorized');
        return;
      }
      env.report('realtime: could not prepare the connection', e);
      scheduleReconnect();
      return;
    }
    if (gen !== generation) return;
    connecting = false;
    if (!wantsConnection()) {
      setStatus('idle');
      return;
    }
    const scheme = env.location.protocol === 'https:' ? 'wss' : 'ws';
    const s = new env.WebSocket(`${scheme}://${env.location.host}${REALTIME_PATH}`, [
      APPSYNC_SUBPROTOCOL,
      `header-${base64url(JSON.stringify(auth))}`,
    ]);
    socket = s;
    socketListeners = new AbortController();
    const { signal } = socketListeners;
    clear(kaTimer);
    kaTimer = env.setTimeout(() => {
      env.report('realtime: AppSync did not acknowledge the connection; retrying');
      drop(true);
    }, CONNECT_TIMEOUT_MS);
    s.addEventListener('open', () => s.send(JSON.stringify({ type: 'connection_init' })), { signal });
    s.addEventListener('message', (event) => onMessage(s, cfg, event.data), { signal });
    // The browser fires error then close; close is what matters.
    s.addEventListener('error', () => {}, { signal });
    s.addEventListener(
      'close',
      () => {
        if (socket === s) drop(true);
      },
      { signal },
    );
  }

  function onMessage(s: SocketLike, cfg: RealtimeClientConfig, data: unknown) {
    if (socket !== s) return;
    let msg: {
      type?: string;
      id?: string;
      event?: unknown;
      connectionTimeoutMs?: number;
      errors?: unknown;
    };
    try {
      msg = JSON.parse(String(data)) as typeof msg;
    } catch {
      env.report('realtime: ignored a message that is not JSON');
      return;
    }
    // Any traffic shows the connection is alive.
    if (acked) resetKeepAlive();
    switch (msg.type) {
      case 'connection_ack':
        acked = true;
        attempts = 0;
        if (typeof msg.connectionTimeoutMs === 'number' && msg.connectionTimeoutMs > 0)
          kaTimeoutMs = msg.connectionTimeoutMs;
        resetKeepAlive();
        for (const sub of subscriptions.values()) sendSubscribe(s, cfg, sub);
        setStatus('connected');
        return;
      case 'ka':
        return;
      case 'data': {
        const sub = msg.id === undefined ? undefined : byId.get(msg.id);
        if (!sub) return;
        // AppSync sends one JSON string per data message; accept an array too.
        const raw = Array.isArray(msg.event) ? msg.event : [msg.event];
        for (const item of raw) {
          let event: unknown;
          try {
            event = typeof item === 'string' ? JSON.parse(item) : item;
          } catch {
            env.report(`realtime: ignored an event on ${sub.channel} that is not JSON`);
            continue;
          }
          for (const listener of Array.from(sub.listeners)) {
            try {
              listener(event);
            } catch (e) {
              env.report(`realtime: a listener for ${sub.channel} threw`, e);
            }
          }
        }
        return;
      }
      case 'subscribe_success':
      case 'unsubscribe_success':
        return;
      case 'subscribe_error': {
        const sub = msg.id === undefined ? undefined : byId.get(msg.id);
        env.report(
          `realtime: subscribing to ${sub?.channel ?? msg.id} was refused (${JSON.stringify(msg.errors ?? [])})`,
        );
        return;
      }
      case 'connection_error':
      case 'error':
        env.report(
          `realtime: AppSync reported ${msg.type} (${JSON.stringify(msg.errors ?? [])}); reconnecting`,
        );
        // A refused token won't do better next time; fetch a new one.
        token = undefined;
        drop(true);
        return;
      case undefined:
      default:
        return;
    }
  }

  function sendSubscribe(s: SocketLike, cfg: RealtimeClientConfig, sub: Subscription) {
    const send = (auth: Auth) => {
      // Still the same live connection, and still wanted?
      if (socket !== s || !acked || subscriptions.get(sub.channel) !== sub) return;
      s.send(
        JSON.stringify({
          type: 'subscribe',
          id: sub.id,
          channel: channelPath(cfg.namespace, sub.channel),
          authorization: auth,
        }),
      );
    };
    // Send right away when the authorization is at hand; a long-lived
    // connection can outlast its token, and later subscribes need a fresh one.
    if (cfg.subscribe === 'public') return send(publicAuth(cfg));
    if (token && token.expiresAt - env.now() >= TOKEN_REFRESH_MS)
      return send({ host: cfg.host, Authorization: token.token });
    authorization(cfg).then(send, (e) => {
      if (e instanceof Unauthorized) {
        drop(false);
        setStatus('unauthorized');
      } else env.report(`realtime: could not subscribe to ${sub.channel}`, e);
    });
  }

  function onVisibility() {
    const doc = env.document;
    if (!doc) return;
    if (doc.visibilityState === 'hidden') {
      clear(hiddenTimer);
      hiddenTimer = env.setTimeout(() => {
        hiddenTimer = undefined;
        parkedHidden = true;
        clear(reconnectTimer);
        reconnectTimer = undefined;
        drop(false);
      }, HIDDEN_CLOSE_MS);
      return;
    }
    clear(hiddenTimer);
    hiddenTimer = undefined;
    const wasParked = parkedHidden;
    parkedHidden = false;
    if (wasParked || status === 'unauthorized') {
      attempts = 0;
      ensureConnected();
    }
  }
  env.document?.addEventListener('visibilitychange', onVisibility);

  return {
    get status() {
      return status;
    },
    onStatus(listener) {
      statusListeners.add(listener);
      return () => void statusListeners.delete(listener);
    },
    subscribe(channel, onEvent) {
      if (!isSubscription(channel))
        throw new Error(
          `realtime.subscribe("${channel}"): channels are 1-4 segments of a-z, 0-9 and hyphens separated by "/", optionally ending in "/*"`,
        );
      clear(idleTimer);
      idleTimer = undefined;
      const listener = onEvent as (event: unknown) => void;
      let sub = subscriptions.get(channel);
      if (!sub) {
        sub = { id: `s${++nextId}`, channel, listeners: new Set() };
        subscriptions.set(channel, sub);
        byId.set(sub.id, sub);
        if (socket && acked && config) sendSubscribe(socket, config, sub);
      }
      sub.listeners.add(listener);
      // A signed-out page tries again when the app subscribes again (e.g. after sign-in).
      if (status === 'unauthorized') attempts = 0;
      ensureConnected();

      const mine = sub;
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        // The channel may have been dropped and subscribed again since: that's not ours to touch.
        const current = subscriptions.get(channel);
        if (current !== mine) return;
        current.listeners.delete(listener);
        if (current.listeners.size > 0) return;
        subscriptions.delete(channel);
        byId.delete(current.id);
        if (socket && acked) socket.send(JSON.stringify({ type: 'unsubscribe', id: current.id }));
        if (subscriptions.size === 0) {
          clear(idleTimer);
          idleTimer = env.setTimeout(() => {
            idleTimer = undefined;
            if (subscriptions.size > 0) return;
            clear(reconnectTimer);
            reconnectTimer = undefined;
            attempts = 0;
            drop(false);
          }, IDLE_CLOSE_MS);
        }
      };
    },
  };
}

function publicAuth(cfg: RealtimeClientConfig): Auth {
  return { host: cfg.host, 'x-api-key': cfg.apiKey ?? '' };
}
