/** Saved queries: named explorer, log and trace views of an app, shared by everyone who can see the app. */
import { MAX_SAVED_QUERIES_PER_APP, newId, type SavedQuery } from '@ericminassian/platform-core';
import { BadRequest, LimitReached, NotFound, PlatformApi } from '@ericminassian/platform-core/platform-api';
import { DateTime, Effect, Option } from 'effect';
import { HttpApiBuilder } from 'effect/http-api';
import { checkSavedQuery, Library } from '../library.ts';
import { Access } from './access.ts';

export const QueriesLive = HttpApiBuilder.group(
  PlatformApi,
  'queries',
  Effect.fn(function* (handlers) {
    const access = yield* Access;
    const library = yield* Library;
    const now = Effect.map(DateTime.now, DateTime.formatIso);

    const checked = <A extends Parameters<typeof checkSavedQuery>[0]>(payload: A) => {
      const problem = checkSavedQuery(payload);
      return problem ? Effect.fail(BadRequest.of(problem)) : Effect.succeed(payload);
    };

    return handlers.handleAll({
      list: ({ params }) =>
        Effect.gen(function* () {
          const { app } = yield* access.memberApp(params.app);
          return yield* library.listQueries(app.name);
        }),

      create: ({ params, payload }) =>
        Effect.gen(function* () {
          const { app, member } = yield* access.memberApp(params.app);
          yield* checked(payload);
          if ((yield* library.listQueries(app.name)).length >= MAX_SAVED_QUERIES_PER_APP)
            return yield* LimitReached.of(`an app keeps up to ${MAX_SAVED_QUERIES_PER_APP} saved queries`);
          const at = yield* now;
          const query: SavedQuery = {
            id: newId('q'),
            app: app.name,
            ...payload,
            createdBy: member.github,
            createdAt: at,
            updatedAt: at,
          };
          yield* library.putQuery(query);
          return query;
        }),

      // Replaces the query (the last write wins).
      update: ({ params, payload }) =>
        Effect.gen(function* () {
          const { app } = yield* access.memberApp(params.app);
          yield* checked(payload);
          const current = yield* library.getQuery(app.name, params.id);
          if (Option.isNone(current)) return yield* NotFound.of(`saved query ${params.id}`);
          const { id, createdBy, createdAt } = current.value;
          const query: SavedQuery = {
            id,
            app: app.name,
            ...payload,
            createdBy,
            createdAt,
            updatedAt: yield* now,
          };
          yield* library.putQuery(query);
          return query;
        }),

      remove: ({ params }) =>
        Effect.gen(function* () {
          const { app } = yield* access.memberApp(params.app);
          if (Option.isNone(yield* library.getQuery(app.name, params.id)))
            return yield* NotFound.of(`saved query ${params.id}`);
          return yield* library.deleteQuery(app.name, params.id);
        }),
    });
  }),
);
