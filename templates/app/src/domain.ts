/**
 * The app's data, as Effect schemas. Shared by the server, the worker, the web
 * client (through `src/api.ts`) and `plat.config.ts` (types only).
 */
import { Schema } from 'effect';

/** Time-sortable todo id (see `Todos.create`), so a user's todos list oldest first. */
export const TodoId = Schema.String.pipe(Schema.brand('TodoId'));
export type TodoId = typeof TodoId.Type;

/** Trimmed, 1-200 characters. */
export const Title = Schema.Trim.check(Schema.isNonEmpty(), Schema.isMaxLength(200));

export const Todo = Schema.Struct({
  userId: Schema.String,
  id: TodoId,
  title: Title,
  done: Schema.Boolean,
  createdAt: Schema.DateTimeUtcFromString,
});
export type Todo = typeof Todo.Type;

export const NewTodo = Schema.Struct({ title: Title });
export type NewTodo = typeof NewTodo.Type;

export const TodoPatch = Schema.Struct({
  title: Schema.optionalKey(Title),
  done: Schema.optionalKey(Schema.Boolean),
});
export type TodoPatch = typeof TodoPatch.Type;

export class TodoNotFound extends Schema.TaggedError<TodoNotFound, { readonly brand: unique symbol }>()(
  'TodoNotFound',
  { id: TodoId },
  { httpApiStatus: 404 },
) {}

/** Body of the `emails` queue (`queue<EmailJob>()` in plat.config.ts). */
export const EmailJob = Schema.Struct({
  to: Schema.String,
  subject: Schema.String,
  body: Schema.String,
});
export type EmailJob = typeof EmailJob.Type;

/** Detail of the `todo.created` event (`event<TodoCreated>()` in plat.config.ts). */
export const TodoCreated = Schema.Struct({
  userId: Schema.String,
  id: TodoId,
  title: Schema.String,
});
export type TodoCreated = typeof TodoCreated.Type;
