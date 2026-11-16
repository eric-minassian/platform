/** Admin-only: members, app/stage counts, platform-wide cost, and the edge's request floor. */
import { PlatformApi } from '@ericminassian/platform-core/platform-api';
import { Clock, Effect, Option } from 'effect';
import { HttpApiBuilder } from 'effect/http-api';
import { Settings } from '../config.ts';
import { EdgeFloor } from '../edge-floor.ts';
import { PLATFORM_COST_KEY, TOTAL_COST_KEY } from '../jobs/cost.ts';
import { Store } from '../store.ts';
import { parseRange, TelemetryQuery } from '../telemetry/query.ts';
import { Access } from './access.ts';
import { ifAvailable } from './apps.ts';

export const AdminLive = HttpApiBuilder.group(
  PlatformApi,
  'admin',
  Effect.fn(function* (handlers) {
    const access = yield* Access;
    const edge = yield* EdgeFloor;
    const settings = yield* Settings;
    const store = yield* Store;
    const telemetry = yield* TelemetryQuery;

    const cost = (key: string) => Effect.map(ifAvailable('cost', telemetry.cost(key)), Option.getOrNull);

    return handlers.handleAll({
      overview: () =>
        Effect.gen(function* () {
          yield* access.admin;
          const [apps, stages, total, shared] = yield* Effect.all(
            [store.listApps, store.listAllStages, cost(TOTAL_COST_KEY), cost(PLATFORM_COST_KEY)],
            { concurrency: 'unbounded' },
          );
          const live = stages.filter((s) => s.status !== 'destroyed');
          return {
            members: settings.platform.members,
            limits: settings.platform.limits,
            apps: apps.length,
            stages: live.length,
            previews: live.filter((s) => s.preview).length,
            down: live.filter((s) => s.up === false).map((s) => s.app),
            cost: { total, shared },
          };
        }),

      edge: ({ query }) =>
        Effect.gen(function* () {
          yield* access.admin;
          const now = yield* Clock.currentTimeMillis;
          return yield* edge.stats(parseRange({ ...query, range: query.range ?? '24h' }, now));
        }),
    });
  }),
);
