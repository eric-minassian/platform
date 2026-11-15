import { Db, Events, Metrics, Queues, type User } from '@ericminassian/platform';
import { Context, DateTime, Effect, Layer, Random } from 'effect';
import { type NewTodo, Todo, TodoId, TodoNotFound, type TodoPatch } from './domain.ts';

/** Todo rules, independent of HTTP. Tests run it on `Platform.layerMemory()`. */
export class Todos extends Context.Service<
  Todos,
  {
    list(userId: string): Effect.Effect<ReadonlyArray<Todo>>;
    create(user: User, input: NewTodo): Effect.Effect<Todo>;
    update(userId: string, id: TodoId, patch: TodoPatch): Effect.Effect<Todo, TodoNotFound>;
    remove(userId: string, id: TodoId): Effect.Effect<void>;
  }
>()('template-app/Todos') {
  static readonly layer = Layer.effect(
    Todos,
    Effect.gen(function* () {
      const db = yield* Db;
      const events = yield* Events;
      const queues = yield* Queues;
      const metrics = yield* Metrics;

      // One collection per entity, partitioned by user so each user's todos are one query.
      // Sort keys are time-ordered ids, so queries return oldest first.
      const todos = db.collection('todos', { schema: Todo, partition: 'userId', sort: 'id' });

      /** 9 chars of base36 milliseconds + 8 random hex chars: sorts by creation time. */
      const newId = Effect.gen(function* () {
        const now = yield* DateTime.now;
        const random = yield* Random.nextIntBetween(0, 2 ** 32);
        const id =
          DateTime.toEpochMillis(now).toString(36).padStart(9, '0') + random.toString(16).padStart(8, '0');
        return { id: TodoId.make(id), now };
      });

      const list = Effect.fn('Todos.list')(function* (userId: string) {
        return yield* todos.queryAll({ userId });
      });

      const create = Effect.fn('Todos.create')(function* (user: User, input: NewTodo) {
        const { id, now } = yield* newId;
        const todo: Todo = { userId: user.id, id, title: input.title, done: false, createdAt: now };
        // Ids are unique per millisecond and user, so a clash is a bug.
        yield* Effect.orDie(todos.insert(todo));
        yield* events.publish('todo.created', { userId: user.id, id, title: todo.title });
        if (user.email)
          yield* queues.send('emails', { to: user.email, subject: 'New todo', body: todo.title });
        yield* metrics.count('todos.created');
        return todo;
      });

      const update = Effect.fn('Todos.update')(function* (userId: string, id: TodoId, patch: TodoPatch) {
        return yield* todos
          .update({ userId, id }, patch)
          .pipe(Effect.catchTag('DocumentNotFound', () => Effect.fail(new TodoNotFound({ id }))));
      });

      const remove = Effect.fn('Todos.remove')(function* (userId: string, id: TodoId) {
        yield* todos.delete({ userId, id });
      });

      return Todos.of({ list, create, update, remove });
    }),
  );
}
