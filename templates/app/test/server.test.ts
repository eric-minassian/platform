import { assert, describe, it } from '@effect/vitest';
import { Platform, toFetchHandler, type User } from '@ericminassian/platform';
import {
  captureTelemetry,
  createPlatformFetch,
  resetPlatform,
  useTestBindings,
} from '@ericminassian/platform/testing';
import { Context, Effect, Layer, Schema } from 'effect';
import { FetchHttpClient, HttpClient, HttpClientRequest } from 'effect/http';
import { HttpApiClient } from 'effect/http-api';
import { afterEach, beforeEach } from 'vitest';
import { Api } from '../src/api.ts';
import { HttpLive } from '../src/http.ts';

// Unit tests run the whole app (the platform's server wrapper, routing,
// validation, sign-in and handlers) on the in-memory platform: no emulator, no
// AWS. `plat test` runs `*.integration.test.ts` against the AWS Emulator instead.

const alice: User = { id: 'alice', email: 'alice@example.com', groups: [] };
const bob: User = { id: 'bob', groups: [] };

/** The app on a fresh in-memory platform, where `Authorization: Bearer <id>` signs in as that user. */
const setup = Effect.gen(function* () {
  const platform = yield* Layer.build(Platform.layerMemory({ users: [alice, bob] }));
  const app = toFetchHandler(HttpLive.pipe(Layer.provide(Layer.succeedContext(platform))));
  yield* Effect.addFinalizer(() => Effect.promise(app.dispose));
  const fetch = createPlatformFetch(app);

  /** A client generated from `Api`, sending requests through `fetch`. */
  const clientAs = (user?: User) =>
    HttpApiClient.make(Api, {
      baseUrl: 'http://test-app.localhost',
      ...(user && { transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(user.id)) }),
    }).pipe(
      Effect.provide(
        FetchHttpClient.layer.pipe(
          Layer.provide(
            Layer.succeed(FetchHttpClient.Fetch)((input, init) => fetch(new Request(input, init))),
          ),
        ),
      ),
    );

  return { fetch, clientAs, memory: Context.get(platform, Platform.Memory) };
});

const post = (body: string, user = alice) =>
  new Request('http://test-app.localhost/api/todos', {
    method: 'POST',
    headers: { authorization: `Bearer ${user.id}`, 'content-type': 'application/json' },
    body,
  });

describe('api', () => {
  let telemetry: ReturnType<typeof captureTelemetry>;
  beforeEach(() => {
    useTestBindings({ app: 'template-app' });
    telemetry = captureTelemetry();
  });
  afterEach(() => {
    telemetry.stop();
    resetPlatform();
  });
  const errors = () => telemetry.events.filter((e) => e.t === 'err');

  it.effect('reports health and the signed-in user', () =>
    Effect.gen(function* () {
      const { clientAs } = yield* setup;
      const anonymous = yield* clientAs();
      assert.deepStrictEqual(yield* anonymous.health(), { ok: true, app: 'test-app', stage: 'test' });
      assert.isNull(yield* anonymous.me());
      assert.deepStrictEqual(yield* (yield* clientAs(alice)).me(), alice);
    }),
  );

  it.effect('requires sign-in for todos', () =>
    Effect.gen(function* () {
      const { clientAs } = yield* setup;
      const error = yield* Effect.flip((yield* clientAs()).todos.list());
      assert.strictEqual(error._tag, 'Unauthorized');
    }),
  );

  it.effect('creates, lists, updates and removes todos', () =>
    Effect.gen(function* () {
      const { clientAs, memory } = yield* setup;
      const api = yield* clientAs(alice);

      const todo = yield* api.todos.create({ payload: { title: 'Buy milk' } });
      assert.isFalse(todo.done);
      assert.deepStrictEqual(yield* memory.published, [
        { type: 'todo.created', detail: { userId: 'alice', id: todo.id, title: 'Buy milk' } },
      ]);
      assert.deepStrictEqual(yield* memory.sent, [
        { queue: 'emails', body: { to: 'alice@example.com', subject: 'New todo', body: 'Buy milk' } },
      ]);

      assert.deepStrictEqual(yield* api.todos.list(), [todo]);
      assert.deepStrictEqual(yield* (yield* clientAs(bob)).todos.list(), []);

      const done = yield* api.todos.update({ params: { id: todo.id }, payload: { done: true } });
      assert.isTrue(done.done);
      assert.strictEqual(done.title, 'Buy milk');

      yield* api.todos.remove({ params: { id: todo.id } });
      assert.deepStrictEqual(yield* api.todos.list(), []);
    }),
  );

  it.effect("keeps users' todos apart, and each test starts empty", () =>
    Effect.gen(function* () {
      const { clientAs } = yield* setup;
      const api = yield* clientAs(alice);
      const todo = yield* api.todos.create({ payload: { title: 'Mine' } });
      assert.deepStrictEqual(yield* api.todos.list(), [todo]);
      const error = yield* Effect.flip(
        (yield* clientAs(bob)).todos.update({ params: { id: todo.id }, payload: { done: true } }),
      );
      assert.strictEqual(error._tag, 'TodoNotFound');
    }),
  );

  it.effect('trims titles', () =>
    Effect.gen(function* () {
      const { fetch } = yield* setup;
      const res = yield* Effect.promise(() => fetch(post(JSON.stringify({ title: '  Buy milk ' }))));
      assert.strictEqual(res.status, 201);
      // Decoded with a plain string, not `Todo`: its `Title` would trim the response again.
      const created = yield* Effect.promise(() => res.json()).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ title: Schema.String }))),
      );
      assert.strictEqual(created.title, 'Buy milk');
    }),
  );

  it.effect('rejects invalid bodies with a 400 and records no error', () =>
    Effect.gen(function* () {
      const { fetch } = yield* setup;
      for (const body of ['{"title":"   "}', JSON.stringify({ title: 'x'.repeat(201) }), '{bad']) {
        const res = yield* Effect.promise(() => fetch(post(body)));
        assert.strictEqual(res.status, 400, body);
      }
      assert.deepStrictEqual(errors(), []);
    }),
  );

  it.effect('records the route pattern of each request', () =>
    Effect.gen(function* () {
      const { clientAs } = yield* setup;
      const api = yield* clientAs(alice);
      const todo = yield* api.todos.create({ payload: { title: 'Route' } });
      yield* api.todos.update({ params: { id: todo.id }, payload: { done: true } });
      const routes = telemetry.events.flatMap((e) =>
        e.t === 'req' ? [`${e.method} ${e.route} ${e.status}`] : [],
      );
      assert.deepStrictEqual(routes, ['POST /api/todos 201', 'PATCH /api/todos/:id 200']);
    }),
  );
});
