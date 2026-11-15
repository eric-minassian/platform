import {
  REALTIME_TOKEN_PATH,
  type RealtimeBindings,
  type RealtimeToken,
  verifyRealtimeToken,
} from '@ericminassian/platform-core';
import { Effect } from 'effect';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Platform, Realtime } from '../src/index.ts';
import { realtime } from '../src/runtime/realtime.ts';
import {
  captureRealtime,
  captureTelemetry,
  createPlatformFetch,
  resetPlatform,
  useTestBindings,
} from '../src/testing.ts';

const PUBLISH_URL = 'https://abc.appsync-api.us-east-1.amazonaws.com/event';
const realtimeBindings: RealtimeBindings = {
  namespace: 'draw--prod',
  publishUrl: PUBLISH_URL,
  subscribe: 'public',
  channels: ['board', 'boards/*'],
};

const realFetch = globalThis.fetch;
const savedEnv = { ...process.env };
interface Call {
  url: string;
  headers: Record<string, string>;
  body: { channel: string; events: string[] };
}
let calls: Call[] = [];
let answer: () => Response;

beforeAll(() => {
  // The default credential chain reads these first; the signer is memoized per region.
  process.env.AWS_ACCESS_KEY_ID = 'AKIDTESTONLY';
  process.env.AWS_SECRET_ACCESS_KEY = 'test-secret';
  process.env.AWS_SESSION_TOKEN = 'test-session';
});
afterAll(() => {
  process.env = savedEnv;
  globalThis.fetch = realFetch;
});

describe('realtime.publish', () => {
  let tel: ReturnType<typeof captureTelemetry>;
  beforeEach(() => {
    calls = [];
    answer = () => Response.json({ successful: [{ identifier: 'x', index: 0 }], failed: [] });
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(input),
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body: JSON.parse(String(init?.body)),
      });
      return answer();
    }) as typeof fetch;
    tel = captureTelemetry();
    useTestBindings({ realtime: realtimeBindings });
  });
  afterEach(() => {
    tel.stop();
    resetPlatform();
    globalThis.fetch = realFetch;
  });

  it('posts a SigV4-signed request for the namespaced channel', async () => {
    await realtime.publish('boards/b1', { stroke: [1, 2, 3] });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.url).toBe(PUBLISH_URL);
    expect(call!.body).toEqual({ channel: '/draw--prod/boards/b1', events: ['{"stroke":[1,2,3]}'] });
    expect(call!.headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDTESTONLY\/\d{8}\/us-east-1\/appsync\/aws4_request, SignedHeaders=[^,]*host[^,]*, Signature=[0-9a-f]{64}$/,
    );
    expect(call!.headers['x-amz-date']).toMatch(/^\d{8}T\d{6}Z$/);
    expect(call!.headers['x-amz-security-token']).toBe('test-session');
    expect(call!.headers['content-type']).toBe('application/json');
    expect(call!.headers.host).toBeUndefined();
  });

  it('sends five events per request, in order', async () => {
    await realtime.publishMany(
      'board',
      Array.from({ length: 12 }, (_, i) => ({ i })),
    );
    expect(calls.map((c) => c.body.events.length)).toEqual([5, 5, 2]);
    expect(calls.flatMap((c) => c.body.events.map((e) => JSON.parse(e).i))).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
    ]);
    await realtime.publishMany('board', []);
    expect(calls).toHaveLength(3);
  });

  it('records one span named by the declared pattern', async () => {
    const { runWithContext, newContext } = await import('../src/runtime/context.ts');
    await runWithContext(newContext(undefined), () => realtime.publish('boards/b42', { x: 1 }));
    const spans = tel.events.filter((e) => e.t === 'span');
    expect(spans).toEqual([
      expect.objectContaining({ op: 'realtime.publish', name: 'boards/*', status: 'ok' }),
    ]);
  });

  it('refuses channels the app did not declare, or malformed ones', async () => {
    await expect(realtime.publish('other', {})).rejects.toThrow(/isn't declared under realtime\.channels/);
    await expect(realtime.publish('boards/*', {})).rejects.toThrow(/no wildcards when publishing/);
    await expect(realtime.publish('Boards/x', {})).rejects.toThrow(/Invalid realtime channel/);
    await expect(realtime.publish('board', undefined)).rejects.toThrow(/must be JSON/);
    await expect(realtime.publish('board', 'x'.repeat(240 * 1024))).rejects.toThrow(/AppSync's limit/);
    expect(calls).toHaveLength(0);
  });

  it('says how to enable realtime when the app has none', async () => {
    useTestBindings();
    await expect(realtime.publish('board', {})).rejects.toThrow(/Add a `realtime` block/);
  });

  it('reports what AppSync refused', async () => {
    answer = () =>
      Response.json(
        { errors: [{ errorType: 'UnauthorizedException', message: 'You are not authorized' }] },
        { status: 401 },
      );
    await expect(realtime.publish('board', {})).rejects.toThrow(
      /AppSync answered 401 UnauthorizedException: You are not authorized/,
    );
    answer = () => Response.json({ successful: [], failed: [{ identifier: 'x', index: 0 }] });
    await expect(realtime.publish('board', {})).rejects.toThrow(/rejected 1 of 1 events/);
    answer = () => new Response('upstream broke', { status: 502 });
    await expect(realtime.publish('board', {})).rejects.toThrow(/502 upstream broke/);
  });
});

describe('captureRealtime', () => {
  afterEach(() => resetPlatform());
  it('records what would be published, still checking channels', async () => {
    useTestBindings({ realtime: realtimeBindings });
    const captured = captureRealtime();
    await realtime.publish('board', { at: new Date(0) });
    await expect(realtime.publish('nope', {})).rejects.toThrow(/isn't declared/);
    expect(captured.published).toEqual([{ channel: 'board', event: { at: '1970-01-01T00:00:00.000Z' } }]);
  });
});

describe(REALTIME_TOKEN_PATH, () => {
  const ISSUER = 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_rt';
  const JWKS = `${ISSUER}/.well-known/jwks.json`;
  let privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
  let jwk: Record<string, unknown>;
  const fetchPlatform = createPlatformFetch(() => new Response('app'));
  const idToken = () =>
    new SignJWT({ token_use: 'id', email: 'a@example.com' })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(ISSUER)
      .setAudience('client-rt')
      .setSubject('user-7')
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 600)
      .sign(privateKey);
  const bindings = (subscribe: 'public' | 'signed-in' | undefined) =>
    useTestBindings({
      url: 'https://notes.example.com',
      app: 'notes',
      stage: 'prod',
      auth: {
        mode: 'cognito',
        userPoolId: 'us-east-1_rt',
        clientId: 'client-rt',
        issuer: ISSUER,
        jwksUri: JWKS,
        loginUrl: 'https://login.example.com',
        required: false,
      },
      ...(subscribe ? { realtime: { ...realtimeBindings, namespace: 'notes--prod', subscribe } } : {}),
    });
  const get = async (token?: string, method = 'GET') =>
    fetchPlatform(
      new Request(`https://notes.example.com${REALTIME_TOKEN_PATH}`, {
        method,
        headers: token ? { authorization: `Bearer ${token}` } : {},
      }),
    );

  let tel: ReturnType<typeof captureTelemetry>;
  beforeAll(async () => {
    const pair = await generateKeyPair('RS256');
    privateKey = pair.privateKey;
    jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  });
  beforeEach(() => {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) =>
      String(input) === JWKS ? Response.json({ keys: [jwk] }) : realFetch(input, init)) as typeof fetch;
    tel = captureTelemetry();
  });
  afterEach(() => {
    tel.stop();
    resetPlatform();
    globalThis.fetch = realFetch;
  });

  it('issues a short-lived token for the signed-in user', async () => {
    const b = bindings('signed-in');
    const before = Math.floor(Date.now() / 1000);
    const res = await get(await idToken());
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as RealtimeToken;
    const claims = await verifyRealtimeToken(b.stageKey!, body.token, before);
    expect(claims).toMatchObject({ a: 'notes', s: 'prod', u: 'user-7' });
    expect(body.expiresAt).toBe(claims!.e * 1000);
    expect(claims!.e - before).toBeGreaterThanOrEqual(15 * 60);
    expect(claims!.e - before).toBeLessThanOrEqual(15 * 60 + 2);
  });

  it('answers 401 signed out, 405 for other methods, 404 without signed-in realtime', async () => {
    bindings('signed-in');
    expect((await get()).status).toBe(401);
    expect((await get(await idToken(), 'POST')).status).toBe(405);
    bindings('public');
    expect((await get(await idToken())).status).toBe(404);
    bindings(undefined);
    expect((await get(await idToken())).status).toBe(404);
  });
});

describe('Realtime (Effect)', () => {
  it('records publishes in memory as subscribers would receive them', () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const rt = yield* Realtime;
        yield* rt.publish('board', { at: new Date(0) });
        yield* rt.publishMany('boards/b1', [{ n: 1 }, { n: 2 }]);
        const memory = yield* Platform.Memory;
        expect(yield* memory.realtime).toEqual([
          { channel: 'board', event: { at: '1970-01-01T00:00:00.000Z' } },
          { channel: 'boards/b1', event: { n: 1 } },
          { channel: 'boards/b1', event: { n: 2 } },
        ]);
      }).pipe(Effect.provide(Platform.layerMemory({ realtime: { channels: ['board', 'boards/*'] } }))),
    ));

  it('treats an undeclared or malformed channel as a defect, like the deployed app', async () => {
    const publish = (channel: string, layer: ReturnType<typeof Platform.layerMemory>) =>
      Effect.runPromiseExit(
        Effect.gen(function* () {
          yield* (yield* Realtime).publish(channel, {});
        }).pipe(Effect.provide(layer)),
      );
    const declared = Platform.layerMemory({ realtime: { channels: ['board'] } });
    expect(String(await publish('elsewhere', declared))).toMatch(/isn't declared under realtime\.channels/);
    // Without the declared channels it can only check the name.
    expect((await publish('anything', Platform.layerMemory()))._tag).toBe('Success');
    expect(String(await publish('Bad Channel', Platform.layerMemory()))).toMatch(/Invalid realtime channel/);
  });
});
