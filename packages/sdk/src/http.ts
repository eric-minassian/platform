import { Effect, Layer, Option } from 'effect';
import { HttpRouter, HttpServer } from 'effect/http';
import { Authentication, CurrentUser, Unauthorized } from './api.ts';
import { observability } from './observability.ts';
import { setRoute } from './runtime/context.ts';
import { Auth } from './services.ts';

/** Server side of `Authentication`: `Auth.currentUser`, or `Unauthorized`. */
export const AuthenticationLayer: Layer.Layer<Authentication, never, Auth> = Layer.effect(
  Authentication,
  Effect.gen(function* () {
    const auth = yield* Auth;
    return Authentication.of((httpEffect) =>
      Effect.gen(function* () {
        const user = yield* auth.currentUser;
        if (Option.isNone(user)) return yield* Unauthorized.signedOut();
        return yield* Effect.provideService(httpEffect, CurrentUser, user.value);
      }),
    );
  }),
);

/** Records the matched route pattern (`/api/todos/:id`) for the request's telemetry. */
const routePatterns = HttpRouter.middleware((httpEffect) =>
  Effect.flatMap(HttpRouter.RouteContext, ({ route }) => {
    setRoute(route.path);
    return httpEffect;
  }),
);

/** What `HttpServer.layerServices` provides to the routes (platform, file system, etags). */
type ServerServices = Layer.Success<typeof HttpServer.layerServices>;

/**
 * The web server's entry: `export default toFetchHandler(layer)` in the app's
 * `web.server` file, where `layer` registers routes (usually
 * `HttpApiBuilder.layer(Api)` with its handlers and `Platform.layer`).
 *
 * The platform's server wrapper already logs every request (`req` lines), so
 * Effect's request logger is off. Route patterns and the error behind a 500
 * reach the platform's telemetry, and `Effect.log*` writes platform log lines.
 * Services are built on the first request and live as long as the instance.
 */
export function toFetchHandler<E>(layer: Layer.Layer<never, E, HttpRouter.HttpRouter | ServerServices>): {
  readonly fetch: (request: Request) => Promise<Response>;
  readonly dispose: () => Promise<void>;
} {
  const { handler, dispose } = HttpRouter.toWebHandler(
    layer.pipe(
      Layer.provide(routePatterns.layer),
      Layer.provideMerge(observability),
      Layer.provide(HttpServer.layerServices),
    ),
    { disableLogger: true },
  );
  return { fetch: (request) => handler(request), dispose };
}
