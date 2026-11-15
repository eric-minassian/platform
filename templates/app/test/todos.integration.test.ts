import { assert, layer } from '@effect/vitest';
import { Platform, type User } from '@ericminassian/platform';
import { createPlatformFetch } from '@ericminassian/platform/server';
import { waitForEmail } from '@ericminassian/platform/testing';
import { Effect, Layer } from 'effect';
import app from '../src/server.ts';
import { Todos } from '../src/todos.ts';

// Runs under `plat test`: the real platform services against the AWS Emulator
// (DynamoDB, SQS, EventBridge), with the bindings a deployed stage gets. The
// worker runs too, and the mail it sends lands in `plat test`'s inbox.
const user: User = { id: `it-${Date.now()}`, email: `it-${Date.now()}@example.com`, groups: [] };

// `excludeTestServices`: the real clock, which ids and timestamps come from.
layer(Todos.layer.pipe(Layer.provide(Platform.layer)), { excludeTestServices: true })('integration', (it) => {
  it.effect('serves health through the platform wrapper', () =>
    Effect.gen(function* () {
      const fetch = createPlatformFetch(app);
      const res = yield* Effect.promise(() => fetch(new Request('http://localhost/api/health')));
      assert.strictEqual(res.status, 200);
    }),
  );

  it.effect('stores, lists, updates and removes a todo', () =>
    Effect.gen(function* () {
      const todos = yield* Todos;
      const todo = yield* todos.create(user, { title: 'from a test' });
      assert.deepStrictEqual(yield* todos.list(user.id), [todo]);

      const done = yield* todos.update(user.id, todo.id, { done: true });
      assert.isTrue(done.done);

      yield* todos.remove(user.id, todo.id);
      assert.deepStrictEqual(yield* todos.list(user.id), []);
    }),
  );

  it.effect('emails the user about a new todo, through the queue and the worker', () =>
    Effect.gen(function* () {
      const todos = yield* Todos;
      const todo = yield* todos.create(user, { title: 'mail me' });
      const mail = yield* Effect.promise(() =>
        waitForEmail((m) => m.to.includes(user.email!) && m.text === 'mail me'),
      );
      assert.strictEqual(mail.subject, 'New todo');
      assert.match(mail.from, /^"Todo" <template-app--test@/);
      yield* todos.remove(user.id, todo.id);
    }),
  );
});
