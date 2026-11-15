/**
 * After the route flip, CloudFront edges pick up the new KeyValueStore entry
 * within seconds, not instantly. A deployment is reported live only once the
 * public URL serves it to the control plane. Edges near other viewers can lag
 * a few seconds more, so `plat deploy` repeats the check from the machine it
 * runs on (`packages/cli/src/edge.ts`) before it returns.
 */
import { HEALTH_PATH } from '@ericminassian/platform-core';
import { type Duration, Effect, Option, Schedule, Schema } from 'effect';
import { HttpClient, HttpClientResponse } from 'effect/http';

const Health = Schema.Struct({ revision: Schema.optional(Schema.String) });

/** Route changes have taken 5–55 s to reach a given edge (docs/DESIGN.md, "Risks"). */
export const EDGE_TIMEOUT_SECONDS = 180;

/** Whether `url` served `deploymentId` before the deadline. Never fails. */
export const waitForEdge = Effect.fn('waitForEdge')(function* (
  url: string,
  deploymentId: string,
  options: { readonly timeout?: Duration.Input; readonly interval?: Duration.Input } = {},
) {
  const http = yield* HttpClient.HttpClient;
  const serving = http.get(`${url}${HEALTH_PATH}`, { headers: { 'cache-control': 'no-cache' } }).pipe(
    Effect.flatMap((res) =>
      res.status >= 200 && res.status < 300
        ? Effect.map(HttpClientResponse.schemaBodyJson(Health)(res), (h) => h.revision === deploymentId)
        : Effect.as(Effect.ignore(res.text), false),
    ),
    Effect.timeout('10 seconds'),
    // DNS, TLS or edge errors while propagating: keep polling until the deadline.
    Effect.orElseSucceed(() => false),
  );
  const served = yield* serving.pipe(
    Effect.repeat({ until: (ok) => ok, schedule: Schedule.spaced(options.interval ?? '3 seconds') }),
    Effect.timeoutOption(options.timeout ?? `${EDGE_TIMEOUT_SECONDS} seconds`),
  );
  return Option.getOrElse(served, () => false);
});
