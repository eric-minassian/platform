import { Cause, type Effect, Exit, Layer, ManagedRuntime } from 'effect';
import type { AnyPayload } from '../register.ts';
import type { AppWorkerHandlers, JobContext, LogsBatch, WorkerDefinition } from '../worker.ts';
import { observability } from './observability.ts';

type Job<R> = Effect.Effect<unknown, unknown, R>;

export type EffectWorkerDefinition<R, E> = {
  /** Services the handlers use (usually `Platform.layer` and the app's own), built once per instance. */
  readonly layer: Layer.Layer<R, E>;
  /** Direct invocations by name (`invokeJob`); the result is the invoke's result. */
  readonly invoke?: Readonly<Record<string, (payload: AnyPayload, ctx: JobContext) => Job<NoInfer<R>>>>;
  /**
   * CloudWatch Logs subscription deliveries (system use: the platform's
   * telemetry processor). A failure fails the delivery, which Lambda retries.
   */
  readonly logs?: (batch: LogsBatch, ctx: JobContext) => Job<NoInfer<R>>;
} & AppWorkerHandlers<Job<NoInfer<R>>>;

type Handlers<R> = Readonly<Record<string, (...args: never[]) => Job<R>>>;

/**
 * The worker's entry: `export default defineWorker({ layer, queues, events, crons })`.
 * It must handle exactly the queues, events and crons in `plat.config.ts`, and
 * handlers get the declared payload types. A handler that fails (an error or a
 * defect) fails the job: queues retry it and then dead-letter it, events and
 * crons retry it. `Effect.log*` writes platform log lines.
 */
export function defineWorker<R, E>(definition: EffectWorkerDefinition<R, E>): WorkerDefinition {
  const runtime = ManagedRuntime.make(definition.layer.pipe(Layer.provideMerge(observability)));

  const run = (job: Job<R>): Promise<unknown> =>
    runtime.runPromiseExit(job).then((exit) => {
      if (Exit.isSuccess(exit)) return exit.value;
      throw Cause.prettyErrors(exit.cause)[0] ?? Cause.squash(exit.cause);
    });

  const wrap = (handlers: Handlers<R> | undefined) =>
    handlers &&
    Object.fromEntries(
      Object.entries(handlers).map(([name, handler]) => [
        name,
        (...args: never[]) => run((handler as (...a: never[]) => Job<R>)(...args)),
      ]),
    );

  const d = definition as unknown as Record<
    'queues' | 'events' | 'crons' | 'invoke',
    Handlers<R> | undefined
  >;
  const logs = definition.logs;
  return {
    ...(d.queues ? { queues: wrap(d.queues) } : {}),
    ...(d.events ? { events: wrap(d.events) } : {}),
    ...(d.crons ? { crons: wrap(d.crons) } : {}),
    ...(d.invoke ? { invoke: wrap(d.invoke) } : {}),
    ...(logs ? { logs: (batch: LogsBatch, ctx: JobContext) => run(logs(batch, ctx)) } : {}),
  } as WorkerDefinition;
}
