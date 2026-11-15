/**
 * The HTTP API, defined once as schemas. The server implements it
 * (`src/http.ts`) and the web app calls it through a client generated from it
 * (`web/src/client.ts`), so both sides always agree on paths, payloads and
 * errors. The web app imports this file: keep it free of server-only imports.
 */
import { Authentication, User } from '@ericminassian/platform/api';
import { Schema } from 'effect';
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from 'effect/http-api';
import { NewTodo, Todo, TodoId, TodoNotFound, TodoPatch } from './domain.ts';

export class SystemApi extends HttpApiGroup.make('system', { topLevel: true }).add(
  HttpApiEndpoint.get('health', '/health', {
    success: Schema.Struct({ ok: Schema.Literal(true), app: Schema.String, stage: Schema.String }),
  }),
  /** The signed-in user, or null. */
  HttpApiEndpoint.get('me', '/me', { success: Schema.NullOr(User) }),
) {}

/** A user's own todos. Every endpoint requires sign-in (`Authentication` provides `CurrentUser`). */
export class TodosApi extends HttpApiGroup.make('todos')
  .add(
    HttpApiEndpoint.get('list', '/', { success: Schema.Array(Todo) }),
    HttpApiEndpoint.post('create', '/', { payload: NewTodo, success: Todo.pipe(HttpApiSchema.status(201)) }),
    HttpApiEndpoint.patch('update', '/:id', {
      params: { id: TodoId },
      payload: TodoPatch,
      success: Todo,
      error: TodoNotFound,
    }),
    HttpApiEndpoint.delete('remove', '/:id', { params: { id: TodoId }, success: HttpApiSchema.NoContent }),
  )
  .middleware(Authentication)
  .prefix('/todos') {}

export class Api extends HttpApi.make('template-app')
  .add(SystemApi)
  .add(TodosApi)
  .prefix('/api')
  .annotateMerge(OpenApi.annotations({ title: 'template-app' })) {}
