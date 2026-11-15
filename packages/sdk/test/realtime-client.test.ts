import {
  APPSYNC_SUBPROTOCOL,
  REALTIME_PATH,
  REALTIME_TOKEN_PATH,
  type RealtimeClientConfig,
} from '@ericminassian/platform-core/realtime';
import { Effect, Fiber, Stream } from 'effect';
import { describe, expect, it } from 'vitest';
import {
  createRealtimeClient,
  type FetchResponseLike,
  type RealtimeEnv,
  type RealtimeStatus,
  type SocketLike,
} from '../src/realtime-client.ts';

const PUBLIC: RealtimeClientConfig = {
  v: 1,
  host: 'abc.appsync-api.us-east-1.amazonaws.com',
  namespace: 'draw--prod',
  subscribe: 'public',
  apiKey: 'da2-key',
};
const SIGNED: RealtimeClientConfig = {
  v: 1,
  host: PUBLIC.host,
  namespace: 'notes--prod',
  subscribe: 'signed-in',
};

type Message = Record<string, unknown>;

class FakeSocket implements SocketLike {
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;
  sent: Message[] = [];
  closed = false;
  readonly url: string;
  readonly protocols: string[];
  constructor(url: string, protocols: string[]) {
    this.url = url;
    this.protocols = protocols;
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.closed = true;
  }
  /** The server side: open, ack, push frames, hang up. */
  open() {
    this.onopen?.({});
  }
  receive(message: Message | string) {
    this.onmessage?.({ data: typeof message === 'string' ? message : JSON.stringify(message) });
  }
  ack(connectionTimeoutMs = 300_000) {
    this.receive({ type: 'connection_ack', connectionTimeoutMs });
  }
  hangUp() {
    this.closed = true;
    this.onclose?.({ code: 1000 });
  }
  /** The decoded `header-…` subprotocol. */
  header(): Record<string, string> {
    const h = this.protocols[1]!.slice('header-'.length);
    return JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
  }
}

/** A page with fake timers, sockets, fetch and visibility. */
function page(options: { config?: RealtimeClientConfig; random?: number } = {}) {
  let now = 1_000_000;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const sockets: FakeSocket[] = [];
  const reports: string[] = [];
  const fetched: string[] = [];
  const visibility = { state: 'visible', listeners: [] as Array<() => void> };
  let config: RealtimeClientConfig | 'missing' = options.config ?? PUBLIC;
  let tokens: Array<{ token: string; expiresAt: number } | 401> = [];

  const respond = (status: number, body?: unknown): FetchResponseLike => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });

  const env: RealtimeEnv = {
    WebSocket: class extends FakeSocket {
      constructor(url: string, protocols: string[]) {
        super(url, protocols);
        sockets.push(this);
      }
    },
    fetch: async (url) => {
      fetched.push(url);
      if (url === REALTIME_PATH) return config === 'missing' ? respond(404) : respond(200, config);
      if (url === REALTIME_TOKEN_PATH) {
        const next = tokens.shift() ?? 401;
        return next === 401 ? respond(401, {}) : respond(200, next);
      }
      return respond(404);
    },
    location: { protocol: 'https:', host: 'draw.example.com' },
    document: {
      get visibilityState() {
        return visibility.state;
      },
      addEventListener: (_type, listener) => void visibility.listeners.push(listener),
    },
    setTimeout: (fn, ms) => {
      const id = ++seq;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (id) => void timers.delete(id as number),
    now: () => now,
    random: () => options.random ?? 1,
    report: (message) => void reports.push(message),
  };

  const client = createRealtimeClient(env);
  const statuses: RealtimeStatus[] = [];
  client.onStatus((s) => statuses.push(s));

  /** Let pending promises (fetches) settle. */
  const settle = async () => {
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
  };
  /** Advance the fake clock, firing due timers in order. */
  const advance = async (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].fn();
      await settle();
    }
    now = end;
    await settle();
  };
  /** Let time pass on a healthy connection: AppSync's keep-alive every minute. */
  const alive = async (socket: FakeSocket, ms: number) => {
    for (let left = ms; left > 0; left -= 60_000) {
      await advance(Math.min(60_000, left));
      socket.receive({ type: 'ka' });
    }
  };
  /** Delays of the pending timers, shortest first. */
  const pendingDelays = () => [...timers.values()].map((t) => t.at - now).sort((a, b) => a - b);
  const setVisibility = async (state: 'visible' | 'hidden') => {
    visibility.state = state;
    for (const l of visibility.listeners) l();
    await settle();
  };
  /** The live socket, opened and acknowledged. */
  const connect = async () => {
    await settle();
    const s = sockets.at(-1)!;
    s.open();
    s.ack();
    return s;
  };

  return {
    client,
    env,
    sockets,
    reports,
    fetched,
    statuses,
    settle,
    advance,
    alive,
    pendingDelays,
    setVisibility,
    connect,
    setConfig: (c: RealtimeClientConfig | 'missing') => {
      config = c;
    },
    setTokens: (t: typeof tokens) => {
      tokens = t;
    },
    get now() {
      return now;
    },
  };
}

describe('realtime client', () => {
  it('connects through the app host with the API key and subscribes after the ack', async () => {
    const p = page();
    const events: unknown[] = [];
    p.client.subscribe('board', (e) => events.push(e));
    expect(p.client.status).toBe('connecting');
    await p.settle();

    expect(p.fetched).toEqual([REALTIME_PATH]);
    const s = p.sockets[0]!;
    expect(s.url).toBe('wss://draw.example.com/__platform/realtime');
    expect(s.protocols[0]).toBe(APPSYNC_SUBPROTOCOL);
    expect(s.header()).toEqual({ host: PUBLIC.host, 'x-api-key': 'da2-key' });

    s.open();
    expect(s.sent).toEqual([{ type: 'connection_init' }]);
    s.ack();
    expect(p.client.status).toBe('connected');
    expect(s.sent[1]).toEqual({
      type: 'subscribe',
      id: 's1',
      channel: '/draw--prod/board',
      authorization: { host: PUBLIC.host, 'x-api-key': 'da2-key' },
    });

    s.receive({ type: 'data', id: 's1', event: JSON.stringify({ n: 1 }) });
    // AppSync sends one JSON string; an array is tolerated.
    s.receive({ type: 'data', id: 's1', event: [JSON.stringify({ n: 2 }), JSON.stringify({ n: 3 })] });
    expect(events).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    expect(p.statuses).toEqual(['connecting', 'connected']);
  });

  it('shares one subscription between listeners and unsubscribes with the last one', async () => {
    const p = page();
    const a: unknown[] = [];
    const b: unknown[] = [];
    const stopA = p.client.subscribe('board', (e) => a.push(e));
    const stopB = p.client.subscribe('board', (e) => {
      b.push(e);
      throw new Error('listener bug');
    });
    const s = await p.connect();
    expect(s.sent.filter((m) => m.type === 'subscribe')).toHaveLength(1);

    s.receive({ type: 'data', id: 's1', event: '"x"' });
    expect(a).toEqual(['x']);
    expect(b).toEqual(['x']);
    expect(p.reports).toEqual(['realtime: a listener for board threw']);

    // A channel added on a live connection subscribes at once, on the same socket.
    const stopC = p.client.subscribe('boards/*', () => {});
    expect(s.sent.at(-1)).toMatchObject({ type: 'subscribe', id: 's2', channel: '/draw--prod/boards/*' });

    stopA();
    stopA(); // idempotent
    expect(s.sent.filter((m) => m.type === 'unsubscribe')).toEqual([]);
    stopB();
    expect(s.sent.at(-1)).toEqual({ type: 'unsubscribe', id: 's1' });
    stopC();
    expect(s.sent.at(-1)).toEqual({ type: 'unsubscribe', id: 's2' });

    // The socket stays a moment (a remount often subscribes again), then closes.
    await p.advance(999);
    expect(s.closed).toBe(false);
    await p.advance(1);
    expect(s.closed).toBe(true);
    expect(p.client.status).toBe('idle');
  });

  it('reconnects with growing, capped, jittered backoff and resubscribes everything', async () => {
    const p = page({ random: 1 });
    p.client.subscribe('board', () => {});
    p.client.subscribe('boards/b1', () => {});
    const first = await p.connect();

    first.hangUp();
    expect(p.client.status).toBe('reconnecting');
    expect(p.pendingDelays()).toEqual([1_000]);
    // Each failure before an ack waits longer: 1, 2, 4, 8, 16, then 30 s at most.
    const waits: number[] = [];
    for (let i = 0; i < 7; i++) {
      waits.push(p.pendingDelays()[0]!);
      await p.advance(p.pendingDelays()[0]!);
      p.sockets.at(-1)!.hangUp();
    }
    expect(waits).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);

    await p.advance(p.pendingDelays()[0]!);
    const s = p.sockets.at(-1)!;
    s.open();
    s.ack();
    expect(p.client.status).toBe('connected');
    expect(s.sent.filter((m) => m.type === 'subscribe').map((m) => m.channel)).toEqual([
      '/draw--prod/board',
      '/draw--prod/boards/b1',
    ]);
    // A successful connection starts the backoff over; the config is fetched only once.
    s.hangUp();
    expect(p.pendingDelays()).toEqual([1_000]);
    expect(p.fetched).toEqual([REALTIME_PATH]);
    expect(p.statuses).toContain('reconnecting');
  });

  it('randomizes each wait to 50-100% so pages do not reconnect together', async () => {
    const p = page({ random: 0 });
    p.client.subscribe('board', () => {});
    (await p.connect()).hangUp();
    expect(p.pendingDelays()).toEqual([500]);
  });

  it('drops a connection whose keep-alives stop, and one that is never acknowledged', async () => {
    const p = page();
    p.client.subscribe('board', () => {});
    const s = await p.connect();
    await p.advance(299_000);
    s.receive({ type: 'ka' });
    await p.advance(299_000);
    expect(s.closed).toBe(false);
    await p.advance(1_000);
    expect(s.closed).toBe(true);
    expect(p.client.status).toBe('reconnecting');
    expect(p.reports).toEqual(['realtime: no keep-alive from AppSync; reconnecting']);

    await p.advance(p.pendingDelays()[0]!);
    const next = p.sockets.at(-1)!;
    next.open(); // ...but no connection_ack
    await p.advance(15_000);
    expect(next.closed).toBe(true);
    expect(p.reports.at(-1)).toBe('realtime: AppSync did not acknowledge the connection; retrying');
  });

  it('subscribes signed-in pages with a token from the app, refreshed before it expires', async () => {
    const p = page({ config: SIGNED });
    p.setTokens([
      { token: 'pt1.a.b', expiresAt: 1_000_000 + 15 * 60_000 },
      { token: 'pt1.c.d', expiresAt: 1_000_000 + 30 * 60_000 },
    ]);
    p.client.subscribe('user/u1', () => {});
    const s = await p.connect();
    expect(s.header()).toEqual({ host: SIGNED.host, Authorization: 'pt1.a.b' });
    expect(s.sent[1]).toMatchObject({
      channel: '/notes--prod/user/u1',
      authorization: { Authorization: 'pt1.a.b' },
    });

    // Within a minute of expiry, a new subscription fetches a fresh token first.
    await p.alive(s, 14 * 60_000 + 1);
    expect(s.closed).toBe(false);
    p.client.subscribe('board', () => {});
    await p.settle();
    expect(p.fetched.filter((u) => u === REALTIME_TOKEN_PATH)).toHaveLength(2);
    expect(s.sent.at(-1)).toMatchObject({
      channel: '/notes--prod/board',
      authorization: { Authorization: 'pt1.c.d' },
    });
  });

  it('waits for sign-in when the app answers 401, and tries again on the next subscribe', async () => {
    const p = page({ config: SIGNED });
    p.setTokens([401]);
    const stop = p.client.subscribe('board', () => {});
    await p.settle();
    expect(p.client.status).toBe('unauthorized');
    expect(p.sockets).toHaveLength(0);
    expect(p.pendingDelays()).toEqual([]);

    p.setTokens([{ token: 'pt1.a.b', expiresAt: p.now + 15 * 60_000 }]);
    stop();
    p.client.subscribe('board', () => {});
    await p.connect();
    expect(p.client.status).toBe('connected');
  });

  it('fetches a new token after AppSync refuses the connection', async () => {
    const p = page({ config: SIGNED });
    p.setTokens([
      { token: 'pt1.old.x', expiresAt: 1_000_000 + 15 * 60_000 },
      { token: 'pt1.new.y', expiresAt: 1_000_000 + 15 * 60_000 },
    ]);
    p.client.subscribe('board', () => {});
    await p.settle();
    p.sockets[0]!.receive({ type: 'connection_error', errors: [{ errorType: 'UnauthorizedException' }] });
    await p.advance(p.pendingDelays()[0]!);
    expect(p.sockets[1]!.header().Authorization).toBe('pt1.new.y');
  });

  it('lets the socket go after five hidden minutes and reconnects when shown', async () => {
    const p = page();
    p.client.subscribe('board', () => {});
    const s = await p.connect();

    // Briefly hidden: nothing changes.
    await p.setVisibility('hidden');
    await p.alive(s, 4 * 60_000);
    await p.setVisibility('visible');
    await p.alive(s, 10 * 60_000);
    expect(s.closed).toBe(false);

    await p.setVisibility('hidden');
    await p.alive(s, 5 * 60_000);
    expect(s.closed).toBe(true);
    expect(p.client.status).toBe('idle');
    expect(p.pendingDelays()).toEqual([]);

    await p.setVisibility('visible');
    const back = await p.connect();
    expect(back).not.toBe(s);
    expect(back.sent.filter((m) => m.type === 'subscribe')).toHaveLength(1);
    expect(p.client.status).toBe('connected');
  });

  it('retries a missing realtime config with backoff and says why', async () => {
    const p = page();
    p.setConfig('missing');
    p.client.subscribe('board', () => {});
    await p.settle();
    expect(p.client.status).toBe('reconnecting');
    expect(p.reports[0]).toBe('realtime: could not prepare the connection');
    p.setConfig(PUBLIC);
    await p.advance(p.pendingDelays()[0]!);
    await p.connect();
    expect(p.client.status).toBe('connected');
  });

  it('leaves a channel subscribed again alone when an old unsubscribe runs late', async () => {
    const p = page();
    const events: unknown[] = [];
    const listener = (e: unknown) => events.push(e);
    const stop1 = p.client.subscribe('board', listener);
    const stop2 = p.client.subscribe('board', listener); // the same function: one registration
    const s = await p.connect();
    stop1();
    p.client.subscribe('board', listener);
    stop2();
    s.receive({ type: 'data', id: 's2', event: '1' });
    expect(events).toEqual([1]);
  });

  it('refuses channels AppSync would refuse', () => {
    const p = page();
    expect(() => p.client.subscribe('Board', () => {})).toThrow(/1-4 segments/);
    expect(() => p.client.subscribe('*', () => {})).toThrow(/1-4 segments/);
  });
});

describe('RealtimeClient (Effect)', () => {
  it('streams events and status from the page connection', async () => {
    const sockets: FakeSocket[] = [];
    const g = globalThis as unknown as Record<string, unknown>;
    const saved = { WebSocket: g.WebSocket, location: g.location, fetch: g.fetch };
    g.WebSocket = class extends FakeSocket {
      constructor(url: string, protocols: string[]) {
        super(url, protocols);
        sockets.push(this);
      }
    };
    g.location = { protocol: 'http:', host: 'draw.localhost:3000' };
    g.fetch = async () => ({ ok: true, status: 200, json: async () => PUBLIC });
    try {
      const { RealtimeClient } = await import('../src/client.ts');
      const events = Effect.runFork(Stream.runCollect(Stream.take(RealtimeClient.subscribe('board'), 2)));
      const statuses = Effect.runFork(
        Stream.runCollect(RealtimeClient.status.pipe(Stream.takeUntil((status) => status === 'connected'))),
      );
      for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
      const s = sockets[0]!;
      expect(s.url).toBe('ws://draw.localhost:3000/__platform/realtime');
      s.open();
      s.ack();
      s.receive({ type: 'data', id: 's1', event: '{"n":1}' });
      s.receive({ type: 'data', id: 's1', event: '{"n":2}' });
      expect(await Effect.runPromise(Fiber.join(events))).toEqual([{ n: 1 }, { n: 2 }]);
      const seen = await Effect.runPromise(Fiber.join(statuses));
      expect(seen.at(-1)).toBe('connected');
      expect(seen.every((status) => ['idle', 'connecting', 'connected'].includes(status))).toBe(true);
      // The stream unsubscribed when it ended.
      expect(s.sent.at(-1)).toEqual({ type: 'unsubscribe', id: 's1' });
    } finally {
      Object.assign(g, saved);
    }
  });
});
