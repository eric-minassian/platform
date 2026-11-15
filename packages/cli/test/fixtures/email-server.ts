// A web server that sends mail the way an app's does: the SDK's Email service
// on Platform.layer, run by the SDK's server wrapper with the stage's bindings.
// POST a message: 200 { id }, or 409 { reason, message } when it wasn't sent.
import { Email, Platform } from '@ericminassian/platform';
import { Effect } from 'effect';

export default {
  fetch: async (req: Request): Promise<Response> => {
    const message = await req.json();
    return Effect.runPromise(
      Effect.gen(function* () {
        const { id } = yield* (yield* Email).send(message);
        return Response.json({ id });
      }).pipe(
        Effect.catchTag('EmailNotSent', (e) =>
          Effect.succeed(Response.json({ reason: e.reason, message: e.message }, { status: 409 })),
        ),
        Effect.provide(Platform.layer),
      ),
    );
  },
};
