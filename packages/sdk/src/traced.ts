import { SERVICE_ENV } from '@ericminassian/platform-core';
import { Cause, Effect, Exit, Fiber } from 'effect';
import { currentContext, type RequestContext, runWithContext, startRoot } from './runtime/context.ts';
import { emitError, emitSpan, endRoot } from './runtime/telemetry.ts';

/**
 * Marks `self` as one unit of work, e.g. a batch a service writes:
 * `flush(batch).pipe(traced('flush'))`.
 *
 * Inside a request or a job it is a span of that trace (op `traced`). Outside
 * one, as in a service's `run`, it starts a trace of its own: the SDK calls it
 * makes are spans of that trace, and it is reported as a `service` job named
 * `<service>/<name>` with its outcome and duration (a failure also as an error
 * group), which the console and `plat metrics` count and time. Like a job's,
 * its spans are written when it fails, is slow or its trace is sampled, and
 * counted on its line otherwise. A unit that is interrupted (the service
 * stopping) isn't reported.
 *
 * The effect's result, failure and interruption pass through unchanged. A
 * trace of its own runs `self` on a fiber of its own, so fibers it forks with
 * `Effect.forkChild` end when it does.
 */
export const traced =
  (name: string) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.suspend(() => {
      const parent = currentContext();
      return parent ? childSpan(parent, name, self) : traceRoot(name, self);
    });

function childSpan<A, E, R>(
  ctx: RequestContext,
  name: string,
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return Effect.suspend(() => {
    const t0 = performance.now();
    return Effect.onExit(self, (exit) =>
      Effect.sync(() => emitSpan(ctx, 'traced', name, t0, Exit.isSuccess(exit) ? 'ok' : 'error')),
    );
  });
}

function traceRoot<A, E, R>(name: string, self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
  return Effect.suspend(() => {
    const service = process.env[SERVICE_ENV];
    const job = service ? `${service}/${name}` : name;
    const ctx = startRoot();
    ctx.job = `service:${job}`;
    return withContext(ctx, self).pipe(
      Effect.onExit((exit) =>
        Effect.sync(() =>
          runWithContext(ctx, () => {
            if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) return;
            const ok = Exit.isSuccess(exit);
            if (!ok) {
              const error = Cause.prettyErrors(exit.cause)[0] ?? Cause.squash(exit.cause);
              emitError(error, 'service', { job: ctx.job! });
            }
            const dur = Math.round((performance.now() - ctx.startedAt) * 10) / 10;
            endRoot(ctx, 'job', { kind: 'service', name: job, status: ok ? 'ok' : 'error', dur });
          }),
        ),
      ),
    );
  });
}

/**
 * Runs `self` with `ctx` as the SDK's async-local context. Effect pins every
 * fiber to the async context it started in and restores that context each
 * time the fiber resumes, so the current fiber can't switch to `ctx`: `self`
 * runs on a new fiber started inside `runWithContext`, with the current
 * fiber's services. Interrupting the current fiber interrupts that one and
 * waits for its finalizers.
 */
function withContext<A, E, R>(ctx: RequestContext, self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
  return Effect.flatMap(Effect.context<R>(), (services) =>
    Effect.callback<A, E>((resume) => {
      const fiber = runWithContext(ctx, () => Effect.runForkWith(services)(self));
      fiber.addObserver((exit) => resume(exit));
      return Fiber.interrupt(fiber);
    }),
  );
}
