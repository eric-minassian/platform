import { Effect, Exit } from 'effect';
import { currentContext } from './runtime/context.ts';
import { emitSpan } from './runtime/telemetry.ts';

/**
 * Marks `self` as one unit of work, e.g. a batch a job writes:
 * `flush(batch).pipe(traced('flush'))`. Inside a request or a job it is a span
 * of that trace (op `traced`) with its outcome and duration; outside one there
 * is no trace for it to join, and it runs `self` as it is.
 *
 * The effect's result, failure and interruption pass through unchanged.
 */
export const traced =
  (name: string) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.suspend(() => {
      const ctx = currentContext();
      if (!ctx) return self;
      const t0 = performance.now();
      return Effect.onExit(self, (exit) =>
        Effect.sync(() => emitSpan(ctx, 'traced', name, t0, Exit.isSuccess(exit) ? 'ok' : 'error')),
      );
    });
