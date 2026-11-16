import {
  EDGE_RATE_LIMITED_BODY,
  EDGE_RETRY_AFTER_SECONDS,
  RATE_LIMIT_PK_PREFIX,
} from '@ericminassian/platform-core';
import { Cause, Duration, Effect, Exit, Layer, Schema } from 'effect';
import { FetchHttpClient, HttpServerRequest } from 'effect/http';
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiClient,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
} from 'effect/http-api';
import { TestClock } from 'effect/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Platform, RateLimited, type RateLimitOptions, RateLimits, toFetchHandler } from '../src/index.ts';
import { retryAfterMs } from '../src/rate-limit.ts';
import {
  captureTelemetry,
  clientHeaders,
  createPlatformFetch,
  mockClient,
  resetPlatform,
  useTestBindings,
} from '../src/testing.ts';
import { rateLimitContract } from './rate-limit-contract.ts';

let telemetry: ReturnType<typeof captureTelemetry>;
beforeEach(() => {
  telemetry = captureTelemetry();
});
afterEach(() => {
  telemetry.stop();
  resetPlatform();
});

const MINUTE = 60_000;

/** Runs `effect` on a fresh in-memory `RateLimits`, on a test clock starting at 0. */
const run = <A, E>(effect: Effect.Effect<A, E, RateLimits>) =>
  Effect.runPromise(effect.pipe(Effect.provide([RateLimits.layerMemory(), TestClock.layer()])));

const runExit = <A, E>(effect: Effect.Effect<A, E, RateLimits>) =>
  Effect.runPromiseExit(effect.pipe(Effect.provide([RateLimits.layerMemory(), TestClock.layer()])));

const defect = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) && Exit.hasDies(exit) ? String(Cause.squash(exit.cause)) : 'no defect';

describe('retryAfterMs', () => {
  const at = (elapsed: number) => ({ index: 7, elapsed, length: MINUTE });

  it('waits for the previous window to shrink when this one has room', () => {
    // 10 × 0.5 + 5 + 1 > 10 now; 6 s later, 10 × 0.4 + 5 + 1 = 10.
    expect(retryAfterMs(at(30_000), 10, 5, 1, 10)).toBeCloseTo(6000);
  });

  it('waits into the next window when this one is full', () => {
    // This window's 10 become the previous window: 10 × 0.9 + 1 = 10, 6 s into it.
    expect(retryAfterMs(at(30_000), 0, 10, 1, 10)).toBeCloseTo(36_000);
  });

  it('is zero when nothing stands in the way', () => {
    expect(retryAfterMs(at(1000), 0, 0, 5, 10)).toBe(0);
  });
});

describe('RateLimits in memory', () => {
  it('passes the shared scenarios', () => run(rateLimitContract('mem')));

  it('lets `max` through per window and says when the next one fits', () =>
    run(
      Effect.gen(function* () {
        const limits = yield* RateLimits;
        const take = limits.check('signups', { key: 'k', max: 3, per: '1 minute' });
        const results = [yield* take, yield* take, yield* take];
        expect(results.map((r) => [r.ok, r.remaining])).toEqual([
          [true, 2],
          [true, 1],
          [true, 0],
        ]);
        expect(results.every((r) => Duration.isZero(r.retryAfter))).toBe(true);

        // All 3 become the previous window: one more fits once 3 × share + 1 <= 3,
        // 20 s into the next window.
        const over = yield* take;
        expect(over).toMatchObject({ ok: false, remaining: 0 });
        expect(Duration.toMillis(over.retryAfter)).toBe(80_000);

        yield* TestClock.adjust('79 seconds');
        expect((yield* take).ok).toBe(false);
        yield* TestClock.adjust('1 second');
        expect(yield* take).toMatchObject({ ok: true, remaining: 0 });
      }),
    ));

  it('has no burst at a window boundary, unlike a fixed window', () =>
    run(
      Effect.gen(function* () {
        const limits = yield* RateLimits;
        const take = limits.check('writes', { key: 'k', max: 5, per: '1 minute' });
        yield* TestClock.adjust('59 seconds');
        for (let i = 0; i < 5; i++) expect((yield* take).ok).toBe(true);
        yield* TestClock.adjust('2 seconds');
        // A new window, but 5 × 59/60 of the last one still counts.
        expect((yield* take).ok).toBe(false);
        yield* TestClock.adjust('12 seconds');
        expect((yield* take).ok).toBe(true);
      }),
    ));

  it('never counts a use that did not fit, so a client that backs off gets back in', () =>
    run(
      Effect.gen(function* () {
        const limits = yield* RateLimits;
        const take = limits.check('posts', { key: 'k', max: 2, per: '1 minute' });
        yield* take;
        yield* take;
        for (let i = 0; i < 100; i++) expect((yield* take).ok).toBe(false);
        yield* TestClock.adjust('1 minute');
        // Only the 2 that fit count against the next window: 2 × 1 + 1 > 2 at its start.
        expect((yield* take).ok).toBe(false);
        yield* TestClock.adjust('30 seconds');
        expect((yield* take).ok).toBe(true);
      }),
    ));

  it('keeps names, keys and spans apart', () =>
    run(
      Effect.gen(function* () {
        const limits = yield* RateLimits;
        const once = (name: string, key: string, per: Duration.Input) =>
          Effect.map(limits.check(name, { key, max: 1, per }), (r) => r.ok);
        expect(yield* once('a', 'k1', '1 minute')).toBe(true);
        expect(yield* once('a', 'k1', '1 minute')).toBe(false);
        expect(yield* once('a', 'k2', '1 minute')).toBe(true);
        expect(yield* once('b', 'k1', '1 minute')).toBe(true);
        expect(yield* once('a', 'k1', '1 hour')).toBe(true);
      }),
    ));

  it('enforce fails with RateLimited, rounded up to whole seconds', () =>
    run(
      Effect.gen(function* () {
        const limits = yield* RateLimits;
        const take = limits.enforce('votes', { key: 'k', max: 1, per: '1 minute' });
        expect((yield* take).ok).toBe(true);
        yield* TestClock.adjust('0.5 seconds');
        const error = yield* Effect.flip(take);
        expect(error).toBeInstanceOf(RateLimited);
        // 120 s from 0, 0.5 s in: 119.5 s, so 120.
        expect(error.retryAfter).toBe(120);
        expect(error.message).toBe('Too many requests. Try again in 120 seconds.');
      }),
    ));

  it('keys by the client network by default', async () => {
    const check = (ip: string) =>
      Effect.gen(function* () {
        const limits = yield* RateLimits;
        return (yield* limits.check('uploads', { max: 1, per: '1 hour' })).ok;
      }).pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(new Request('http://x/', { headers: clientHeaders(ip) })),
        ),
      );
    const [results, checks] = await Effect.runPromise(
      Effect.gen(function* () {
        const fits = [
          yield* check('2001:db8:1:2::7'),
          // Another address in the same /64 is the same client.
          yield* check('2001:db8:1:2::8'),
          yield* check('203.0.113.7'),
        ];
        return [fits, yield* (yield* Platform.Memory).rateLimits] as const;
      }).pipe(Effect.provide(Platform.layerMemory())),
    );
    expect(results).toEqual([true, false, true]);
    expect(checks).toEqual([
      { name: 'uploads', key: '2001:db8:1:2::/64', ok: true },
      { name: 'uploads', key: '2001:db8:1:2::/64', ok: false },
      { name: 'uploads', key: '203.0.113.7', ok: true },
    ]);
  });

  it('refuses limits that could never work, as defects', async () => {
    const bad = async (name: string, options: Partial<RateLimitOptions>) =>
      defect(
        await runExit(
          RateLimits.use((limits) => limits.check(name, { key: 'k', max: 10, per: '1 minute', ...options })),
        ),
      );
    expect(await bad('has space', {})).toMatch(/not a valid limit name/);
    expect(await bad('a#b', {})).toMatch(/not a valid limit name/);
    expect(await bad('x', { max: 0 })).toMatch(/max must be a positive integer/);
    expect(await bad('x', { max: 1.5 })).toMatch(/max must be a positive integer/);
    expect(await bad('x', { cost: 0 })).toMatch(/cost must be a positive integer/);
    expect(await bad('x', { cost: 11 })).toMatch(/can never fit under max 10/);
    expect(await bad('x', { per: '500 millis' })).toMatch(/from 1 second to 30 days/);
    expect(await bad('x', { per: '31 days' })).toMatch(/from 1 second to 30 days/);
    expect(await bad('x', { key: '' })).toMatch(/key must not be empty/);
    expect(await bad('x', { key: 'k'.repeat(1025) })).toMatch(/at most 1024 bytes/);
  });

  it('lets exactly max through when checks race', () =>
    run(
      Effect.gen(function* () {
        const limits = yield* RateLimits;
        const results = yield* Effect.all(
          Array.from({ length: 64 }, () => limits.check('race', { key: 'k', max: 10, per: '1 minute' })),
          { concurrency: 'unbounded' },
        );
        expect(results.filter((r) => r.ok)).toHaveLength(10);
      }),
    ));
});

describe('RateLimits on DynamoDB', () => {
  type Command = { constructor: { name: string }; input: Record<string, unknown> };
  let sent: Command[];
  /** What the table holds: counts by `pk` and `sk`. */
  let counts: Map<string, number>;

  beforeEach(() => {
    useTestBindings({ table: 'todo--test' });
    sent = [];
    counts = new Map();
    mockClient('ddb', (command) => {
      sent.push(command);
      const key = command.input.Key as { pk: string; sk: string };
      const id = `${key.pk} ${key.sk}`;
      if (command.constructor.name === 'GetCommand') {
        const n = counts.get(id);
        return { Item: n === undefined ? undefined : { n } };
      }
      const values = command.input.ExpressionAttributeValues as Record<string, number>;
      const now = counts.get(id);
      if (now !== undefined && now > values[':room']!)
        // A failed condition's Item comes back marshalled: the document client leaves errors alone.
        throw Object.assign(new Error('The conditional request failed'), {
          name: 'ConditionalCheckFailedException',
          Item: { n: { N: String(now) } },
        });
      counts.set(id, (now ?? 0) + values[':cost']!);
      return { Attributes: { n: counts.get(id) } };
    });
  });

  const real = <A, E>(effect: Effect.Effect<A, E, RateLimits>) =>
    Effect.runPromise(effect.pipe(Effect.provide([RateLimits.layer, TestClock.layer()])));

  it('reads the previous window once, then writes one conditional ADD per check', () =>
    real(
      Effect.gen(function* () {
        const limits = yield* RateLimits;
        yield* TestClock.setTime(10 * MINUTE + 15_000);
        const take = limits.check('signups', { key: '203.0.113.7', max: 2, per: '1 minute' });
        expect(yield* take).toMatchObject({ ok: true, remaining: 1 });
        expect(yield* take).toMatchObject({ ok: true, remaining: 0 });

        const pk = `${RATE_LIMIT_PK_PREFIX}signups#203.0.113.7`;
        expect(sent.map((c) => c.constructor.name)).toEqual(['GetCommand', 'UpdateCommand', 'UpdateCommand']);
        expect(sent[0]!.input).toEqual({
          TableName: 'todo--test',
          Key: { pk, sk: '60000#9' },
          ConsistentRead: true,
          ProjectionExpression: '#n',
          ExpressionAttributeNames: { '#n': 'n' },
        });
        expect(sent[1]!.input).toEqual({
          TableName: 'todo--test',
          Key: { pk, sk: '60000#10' },
          UpdateExpression: 'SET #ttl = :ttl ADD #n :cost',
          ConditionExpression: 'attribute_not_exists(#n) OR #n <= :room',
          ExpressionAttributeNames: { '#n': 'n', '#ttl': '_ttl' },
          // Kept until window 11 ends, at 12 minutes.
          ExpressionAttributeValues: { ':cost': 1, ':room': 1, ':ttl': 720 },
          ReturnValues: 'UPDATED_NEW',
          ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
        });
      }),
    ));

  it('reads a refused count from the failed condition, then refuses without the table', () =>
    real(
      Effect.gen(function* () {
        const limits = yield* RateLimits;
        // Another instance already used the window up.
        counts.set(`${RATE_LIMIT_PK_PREFIX}posts#k 60000#0`, 3);
        const take = limits.check('posts', { key: 'k', max: 3, per: '1 minute' });
        const over = yield* take;
        expect(over).toMatchObject({ ok: false, remaining: 0 });
        expect(Duration.toMillis(over.retryAfter)).toBe(80_000);
        expect(sent).toHaveLength(2);

        for (let i = 0; i < 50; i++) expect((yield* take).ok).toBe(false);
        expect(sent).toHaveLength(2);

        // The next window starts from what this instance saw: still over, without a call.
        yield* TestClock.adjust('1 minute');
        expect((yield* take).ok).toBe(false);
        expect(sent).toHaveLength(2);
        yield* TestClock.adjust('20 seconds');
        expect((yield* take).ok).toBe(true);
        expect(sent.map((c) => c.constructor.name).slice(2)).toEqual(['GetCommand', 'UpdateCommand']);
      }),
    ));

  it('reads the current window when the previous one alone leaves no room', () =>
    real(
      Effect.gen(function* () {
        const limits = yield* RateLimits;
        counts.set(`${RATE_LIMIT_PK_PREFIX}posts#k 60000#-1`, 3);
        counts.set(`${RATE_LIMIT_PK_PREFIX}posts#k 60000#0`, 0);
        const over = yield* limits.check('posts', { key: 'k', max: 3, per: '1 minute' });
        expect(over.ok).toBe(false);
        expect(sent.map((c) => c.constructor.name)).toEqual(['GetCommand', 'GetCommand']);
        // 3 × share + 1 <= 3 once share is 2/3: 20 s in.
        expect(Duration.toMillis(over.retryAfter)).toBe(20_000);
      }),
    ));

  it('writes a limit telemetry line per check, without the key', () =>
    real(
      Effect.gen(function* () {
        const limits = yield* RateLimits;
        yield* limits.check('votes', { key: '203.0.113.7', max: 1, per: '1 hour' });
        yield* limits.check('votes', { key: '203.0.113.7', max: 1, per: '1 hour' });
        expect(telemetry.events.filter((e) => e.t === 'limit')).toMatchObject([
          { name: 'votes', ok: true },
          { name: 'votes', ok: false },
        ]);
        expect(JSON.stringify(telemetry.events)).not.toContain('203.0.113.7');
      }),
    ));

  it('names the fix when the app has no database', async () => {
    useTestBindings({});
    const exit = await Effect.runPromiseExit(
      RateLimits.use((limits) => limits.check('x', { key: 'k', max: 1, per: '1 minute' })).pipe(
        Effect.provide(RateLimits.layer),
      ),
    );
    expect(defect(exit)).toMatch(/Add `db: true` to plat.config.ts/);
  });
});

describe('RateLimits.middleware', () => {
  class WriteLimit extends HttpApiMiddleware.Service<WriteLimit>()('WriteLimit', { error: RateLimited }) {}

  const Api = HttpApi.make('test')
    .add(
      HttpApiGroup.make('boards', { topLevel: true })
        .add(
          HttpApiEndpoint.post('draw', '/strokes', { success: Schema.String }),
          // Declaring the middleware's error again changes nothing.
          HttpApiEndpoint.post('erase', '/erase', { success: Schema.String, error: RateLimited }),
        )
        .middleware(WriteLimit),
    )
    .add(
      HttpApiGroup.make('uploads', { topLevel: true }).add(
        HttpApiEndpoint.post('upload', '/upload', {
          payload: Schema.Struct({ bytes: Schema.Int }),
          success: Schema.Int,
          error: RateLimited,
        }),
      ),
    )
    .prefix('/api');

  const Handlers = Layer.mergeAll(
    HttpApiBuilder.group(Api, 'boards', (handlers) =>
      handlers.handle('draw', () => Effect.succeed('drawn')).handle('erase', () => Effect.succeed('erased')),
    ),
    HttpApiBuilder.group(
      Api,
      'uploads',
      Effect.fn(function* (handlers) {
        const limits = yield* RateLimits;
        return handlers.handle('upload', ({ payload }) =>
          Effect.map(
            limits.enforce('bytes', { max: 1000, per: '1 hour', cost: payload.bytes }),
            (r) => r.remaining,
          ),
        );
      }),
    ),
  );

  const app = (policy = { max: 2, per: '1 minute' as const }) =>
    createPlatformFetch(
      toFetchHandler(
        HttpApiBuilder.layer(Api).pipe(
          Layer.provide(Handlers),
          Layer.provide(RateLimits.middleware(WriteLimit, policy)),
          Layer.provide(Platform.layerMemory()),
        ),
      ),
    );

  beforeEach(() => {
    useTestBindings({ app: 'draw' });
  });

  it('answers 429 with Retry-After once a client is over, and counts each client apart', async () => {
    const fetch = app();
    const post = (path: string, ip: string) =>
      fetch(new Request(`http://localhost${path}`, { method: 'POST', headers: clientHeaders(ip) }));

    expect((await post('/api/strokes', '203.0.113.7')).status).toBe(200);
    // Endpoints behind one middleware share its count.
    expect((await post('/api/erase', '203.0.113.7')).status).toBe(200);
    const over = await post('/api/strokes', '203.0.113.7');
    expect(over.status).toBe(429);
    const body = (await over.json()) as RateLimited;
    expect(body).toEqual({
      _tag: 'RateLimited',
      message: `Too many requests. Try again in ${body.retryAfter} seconds.`,
      retryAfter: body.retryAfter,
    });
    expect(over.headers.get('retry-after')).toBe(String(body.retryAfter));
    // Both uses become the previous window; one more fits halfway into the next.
    expect(body.retryAfter).toBeGreaterThanOrEqual(30);
    expect(body.retryAfter).toBeLessThanOrEqual(90);
    expect((await post('/api/erase', '203.0.113.7')).status).toBe(429);
    expect((await post('/api/strokes', '198.51.100.1')).status).toBe(200);

    // A 429 is an answer, not an error.
    expect(telemetry.events.filter((e) => e.t === 'err')).toEqual([]);
    expect(
      telemetry.events.filter((e) => e.t === 'req').map((e) => (e as { status: number }).status),
    ).toEqual([200, 200, 429, 429, 200]);
  });

  it('reaches the typed client as RateLimited', async () => {
    const fetch = app({ max: 1, per: '1 minute' });
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* HttpApiClient.make(Api, { baseUrl: 'http://localhost' });
        yield* client.draw();
        return yield* Effect.flip(client.draw());
      }).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, (input, init) => {
          const request = new Request(input, init);
          for (const [k, v] of Object.entries(clientHeaders('203.0.113.7'))) request.headers.set(k, v);
          return fetch(request);
        }),
      ),
    );
    expect(error).toBeInstanceOf(RateLimited);
    // The one use becomes the previous window and must shrink to nothing: 60–120 s.
    expect((error as RateLimited).retryAfter).toBeGreaterThan(60);
    expect((error as RateLimited).retryAfter).toBeLessThanOrEqual(120);
  });

  it('carries the header when a handler enforces a limit itself', async () => {
    const fetch = app();
    const upload = (bytes: number) =>
      fetch(
        new Request('http://localhost/api/upload', {
          method: 'POST',
          headers: { ...clientHeaders('203.0.113.7'), 'content-type': 'application/json' },
          body: JSON.stringify({ bytes }),
        }),
      );
    expect(await (await upload(600)).json()).toBe(400);
    const over = await upload(600);
    expect(over.status).toBe(429);
    expect(Number(over.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await (await upload(400)).json()).toBe(0);
  });

  it("decodes the edge floor's 429 as the same RateLimited", () => {
    const edge = Schema.decodeUnknownSync(RateLimited)(EDGE_RATE_LIMITED_BODY);
    expect(edge).toBeInstanceOf(RateLimited);
    expect(edge).toEqual(RateLimited.after(`${EDGE_RETRY_AFTER_SECONDS} seconds`));
  });

  it('refuses a bad policy when the server starts', async () => {
    const res = await app({ max: 0, per: '1 minute' })(
      new Request('http://localhost/api/strokes', { method: 'POST', headers: clientHeaders('203.0.113.7') }),
    );
    expect(res.status).toBe(500);
    const error = telemetry.events.find((e) => e.t === 'err');
    expect(error?.t === 'err' && error.message).toMatch(
      /RateLimits "WriteLimit": max must be a positive integer/,
    );
  });
});
