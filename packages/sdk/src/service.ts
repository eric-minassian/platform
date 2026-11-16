import { Cause, Effect, Exit, Layer, ManagedRuntime } from 'effect';
import { observability } from './observability.ts';
import type { ServiceProgram } from './runtime/service.ts';

export interface ServiceDefinition<R, E> {
  /** Services `run` uses (usually `Platform.layer` and the app's own), built once per container. */
  readonly layer: Layer.Layer<R, E>;
  /** The service: it runs until the platform stops it. */
  readonly run: Effect.Effect<unknown, unknown, NoInfer<R>>;
}

/**
 * A long-running service's entry: `export default defineService({ layer, run })`
 * in the module a service's `entry` in `plat.config.ts` names. One instance
 * runs per stage, in a container of its own.
 *
 * `layer` is built once when the container starts. If that fails the
 * container exits and is replaced (a deploy whose service can't start fails).
 *
 * `run` should run until the platform stops it: hold the connection, write
 * what arrives to the db, storage, queues or realtime, and reconnect when the
 * source drops. If it fails, dies or returns anyway, that run is reported (a
 * `service` job line, and an error group for a failure) and `run` starts
 * again after a backoff: 1 s, doubling to 60 s, and back to 1 s once a run
 * lasted 5 minutes.
 *
 * A deploy, `plat services stop` or a Spot reclaim sends the container
 * SIGTERM: `run` is interrupted, so its finalizers run (flush a pending batch
 * in `Effect.ensuring` or `Effect.acquireRelease`), then the layer's. All of
 * that gets 25 seconds, after which the process exits anyway.
 *
 * `run` has no trace of its own: wrap each unit of work (a batch, a message)
 * in `traced(name)` to give it one, with its SDK calls as spans. `Effect.log*`
 * writes platform log lines.
 */
export function defineService<R, E>(definition: ServiceDefinition<R, E>): ServiceProgram {
  const runtime = ManagedRuntime.make(definition.layer.pipe(Layer.provideMerge(observability)));
  return {
    async start(signal) {
      const exit = await Effect.runPromiseExit(runtime.contextEffect, { signal });
      if (Exit.isFailure(exit)) throw toError(exit.cause);
    },
    async run(signal) {
      const exit = await runtime.runPromiseExit(definition.run, { signal });
      if (Exit.isFailure(exit)) throw toError(exit.cause);
      return exit.value;
    },
    dispose: () => runtime.dispose(),
  };
}

function toError(cause: Cause.Cause<unknown>): unknown {
  return Cause.prettyErrors(cause)[0] ?? Cause.squash(cause);
}
