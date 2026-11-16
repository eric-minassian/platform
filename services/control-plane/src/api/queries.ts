/** Placeholder handlers for the `queries` group until saved queries lands (this branch is being built in parts). */
import { PlatformApi } from '@ericminassian/platform-core/platform-api';
import { Effect } from 'effect';
import { HttpApiBuilder } from 'effect/http-api';

const pending = (what: string) => () => Effect.die(new Error(`${what}: not implemented yet`));

export const QueriesLive = HttpApiBuilder.group(PlatformApi, 'queries', (handlers) =>
  Effect.succeed(
    handlers.handleAll({
      list: pending('queries.list'),
      create: pending('queries.create'),
      update: pending('queries.update'),
      remove: pending('queries.remove'),
    }),
  ),
);
