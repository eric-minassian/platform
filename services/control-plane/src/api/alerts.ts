/** Placeholder handlers for the `alerts` group until alert rules lands (this branch is being built in parts). */
import { PlatformApi } from '@ericminassian/platform-core/platform-api';
import { Effect } from 'effect';
import { HttpApiBuilder } from 'effect/http-api';

const pending = (what: string) => () => Effect.die(new Error(`${what}: not implemented yet`));

export const AlertsLive = HttpApiBuilder.group(PlatformApi, 'alerts', (handlers) =>
  Effect.succeed(
    handlers.handleAll({
      list: pending('alerts.list'),
      create: pending('alerts.create'),
      update: pending('alerts.update'),
      remove: pending('alerts.remove'),
      history: pending('alerts.history'),
    }),
  ),
);
