/**
 * Dashboards. One with an `app` is seen and changed by whoever can see that
 * app; one without spans apps and is open to every member (each widget's data
 * still needs access to its own app when it's read).
 */
import { type Dashboard, newId } from '@ericminassian/platform-core';
import { BadRequest, NotFound, PlatformApi } from '@ericminassian/platform-core/platform-api';
import { DateTime, Effect, Option } from 'effect';
import { HttpApiBuilder } from 'effect/http-api';
import { canAccessApp } from '../authz.ts';
import { checkDashboard, Library } from '../library.ts';
import { Store } from '../store.ts';
import { Access } from './access.ts';

export const DashboardsLive = HttpApiBuilder.group(
  PlatformApi,
  'dashboards',
  Effect.fn(function* (handlers) {
    const access = yield* Access;
    const library = yield* Library;
    const store = yield* Store;
    const now = Effect.map(DateTime.now, DateTime.formatIso);

    /** The member, and the app the dashboard belongs to (its canonical name), if any. */
    const owner = Effect.fnUntraced(function* (app: string | undefined) {
      if (app === undefined) return { member: yield* access.member, app: undefined };
      const found = yield* access.memberApp(app);
      return { member: found.member, app: found.app.name };
    });

    /** A dashboard the member may see; one of an app they can't see is "not found" too. */
    const visible = Effect.fnUntraced(function* (id: string) {
      const notFound = () => NotFound.of(`dashboard ${id}`);
      const found = yield* library.getDashboard(id);
      if (Option.isNone(found)) return yield* notFound();
      const { member } = yield* owner(found.value.app).pipe(
        Effect.catchTag('NotFound', () => Effect.fail(notFound())),
      );
      return { dashboard: found.value, member };
    });

    const checked = (payload: Parameters<typeof checkDashboard>[0]) => {
      const problem = checkDashboard(payload);
      return problem ? Effect.fail(BadRequest.of(problem)) : Effect.void;
    };

    return handlers.handleAll({
      list: ({ query }) =>
        Effect.gen(function* () {
          if (query.app !== undefined) {
            const { app } = yield* access.memberApp(query.app);
            return yield* library.listDashboards(app.name);
          }
          const me = yield* access.member;
          const [dashboards, apps] = yield* Effect.all([library.listDashboards(), store.listApps], {
            concurrency: 'unbounded',
          });
          const seen = new Set(apps.filter((a) => canAccessApp(me, a)).map((a) => a.name));
          return dashboards.filter((d) => d.app === undefined || seen.has(d.app));
        }),

      create: ({ payload }) =>
        Effect.gen(function* () {
          const { member, app } = yield* owner(payload.app);
          yield* checked(payload);
          const at = yield* now;
          const { app: _, ...rest } = payload;
          const dashboard: Dashboard = {
            id: newId('db'),
            ...rest,
            ...(app ? { app } : {}),
            createdBy: member.github,
            createdAt: at,
            updatedAt: at,
            updatedBy: member.github,
          };
          yield* library.putDashboard(dashboard);
          return dashboard;
        }),

      get: ({ params }) => Effect.map(visible(params.id), ({ dashboard }) => dashboard),

      // Replaces the dashboard (the last write wins); moving it to another app needs access to both.
      update: ({ params, payload }) =>
        Effect.gen(function* () {
          const { dashboard: current } = yield* visible(params.id);
          const { member, app } = yield* owner(payload.app);
          yield* checked(payload);
          const { app: _, ...rest } = payload;
          const dashboard: Dashboard = {
            id: current.id,
            ...rest,
            ...(app ? { app } : {}),
            createdBy: current.createdBy,
            createdAt: current.createdAt,
            updatedAt: yield* now,
            updatedBy: member.github,
          };
          yield* library.putDashboard(dashboard);
          return dashboard;
        }),

      remove: ({ params }) =>
        Effect.gen(function* () {
          yield* visible(params.id);
          yield* library.deleteDashboard(params.id);
        }),
    });
  }),
);
