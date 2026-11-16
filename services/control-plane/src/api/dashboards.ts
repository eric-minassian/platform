/** Placeholder handlers for the `dashboards` group until dashboards lands (this branch is being built in parts). */
import { PlatformApi } from '@ericminassian/platform-core/platform-api';
import { Effect } from 'effect';
import { HttpApiBuilder } from 'effect/http-api';

const pending = (what: string) => () => Effect.die(new Error(`${what}: not implemented yet`));

export const DashboardsLive = HttpApiBuilder.group(PlatformApi, 'dashboards', (handlers) =>
  Effect.succeed(
    handlers.handleAll({
      list: pending('dashboards.list'),
      create: pending('dashboards.create'),
      get: pending('dashboards.get'),
      update: pending('dashboards.update'),
      remove: pending('dashboards.remove'),
    }),
  ),
);
