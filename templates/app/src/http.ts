import { AppInfo, Auth, CurrentUser } from '@ericminassian/platform/effect';
import { Effect, Layer, Option } from 'effect';
import { HttpApiBuilder } from 'effect/http-api';
import { Api } from './api.ts';
import { Todos } from './todos.ts';

const SystemHandlers = HttpApiBuilder.group(
  Api,
  'system',
  Effect.fn(function* (handlers) {
    const app = yield* AppInfo;
    const auth = yield* Auth;
    return handlers
      .handle('health', () => Effect.succeed({ ok: true as const, app: app.name, stage: app.stage }))
      .handle('me', () => Effect.map(auth.currentUser, Option.getOrNull));
  }),
);

const TodosHandlers = HttpApiBuilder.group(
  Api,
  'todos',
  Effect.fn(function* (handlers) {
    const todos = yield* Todos;
    return handlers.handleAll({
      list: () => Effect.flatMap(CurrentUser, (user) => todos.list(user.id)),
      create: ({ payload }) => Effect.flatMap(CurrentUser, (user) => todos.create(user, payload)),
      update: ({ params, payload }) =>
        Effect.flatMap(CurrentUser, (user) => todos.update(user.id, params.id, payload)),
      remove: ({ params }) => Effect.flatMap(CurrentUser, (user) => todos.remove(user.id, params.id)),
    });
  }),
);

/**
 * The API's routes with their handlers, still needing the platform's services:
 * `src/server.ts` provides the real ones, tests the in-memory ones.
 * The OpenAPI document is served at `/api/openapi.json`.
 */
export const HttpLive = HttpApiBuilder.layer(Api, { openapiPath: '/api/openapi.json' }).pipe(
  Layer.provide([SystemHandlers, TodosHandlers]),
  Layer.provide(Todos.layer),
);
