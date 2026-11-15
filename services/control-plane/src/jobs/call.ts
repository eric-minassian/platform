/**
 * Jobs on the control plane's own worker.
 *
 * Engine operations that write the CloudFront KeyValueStore run in the worker
 * (an Event Function), never in the API (a Web Function): KVS PutKey is
 * SigV4A-signed, and from the Web Function runtime it failed with
 * "Authentication failed" while the same call from the worker succeeds. So
 * the API runs rollbacks with `call` and waits for the result.
 */
import { InvokeCommand } from '@aws-sdk/client-lambda';
import { invokeJob } from '@ericminassian/platform/worker';
import { decodeBindings } from '@ericminassian/platform-core';
import { Config, Context, Effect, Layer, Option, Schema } from 'effect';
import { HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/http';
import { Aws, tryAws } from '../aws.ts';

/** The job ran and failed; `message` is its error's. */
export class WorkerJobFailed extends Schema.TaggedError<WorkerJobFailed, { readonly brand: unique symbol }>()(
  'WorkerJobFailed',
  { message: Schema.String },
) {}

/** What `plat dev`'s local worker answers for an invoke. */
const LocalReply = Schema.Struct({
  ok: Schema.Boolean,
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Struct({ message: Schema.optional(Schema.String) })),
});

const LambdaError = Schema.fromJsonString(Schema.Struct({ errorMessage: Schema.optional(Schema.String) }));

export class WorkerJobs extends Context.Service<
  WorkerJobs,
  {
    /** Queues `name` on the worker and returns without waiting (Lambda async invoke, retried on failure). */
    invoke(name: string, payload: unknown): Effect.Effect<void>;
    /** Runs `name` on the worker and answers its result. */
    call(name: string, payload: unknown): Effect.Effect<unknown, WorkerJobFailed>;
  }
>()('@ericminassian/platform-control-plane/WorkerJobs') {
  static readonly layer: Layer.Layer<WorkerJobs, never, Aws | HttpClient.HttpClient> = Layer.effect(
    WorkerJobs,
    Effect.gen(function* () {
      const aws = yield* Aws;
      const http = yield* HttpClient.HttpClient;
      // `plat dev` runs the worker as a local process that answers { ok, result | error }.
      const localWorker = yield* Config.option(Config.String('PLATFORM_LOCAL_WORKER_URL')).pipe(Effect.orDie);

      const invoke = Effect.fn('WorkerJobs.invoke')(function* (name: string, payload: unknown) {
        yield* Effect.tryPromise(() => invokeJob(name, payload));
      }, Effect.orDie);

      const callLocal = Effect.fnUntraced(function* (url: string, body: string, name: string) {
        const res = yield* HttpClientRequest.post(url).pipe(HttpClientRequest.bodyText(body), http.execute);
        const reply = yield* HttpClientResponse.schemaBodyJson(LocalReply)(res);
        if (!reply.ok)
          return yield* new WorkerJobFailed({ message: reply.error?.message ?? `worker job ${name} failed` });
        return reply.result;
      });

      const callLambda = Effect.fnUntraced(function* (body: string, name: string) {
        const worker = decodeBindings(process.env.PLATFORM_BINDINGS).worker;
        if (!worker) return yield* Effect.die(new Error('the control plane has no worker binding'));
        const out = yield* tryAws(() =>
          aws.lambda().send(
            new InvokeCommand({
              FunctionName: worker,
              InvocationType: 'RequestResponse',
              Payload: new TextEncoder().encode(body),
            }),
          ),
        );
        const text = out.Payload ? new TextDecoder().decode(out.Payload) : 'null';
        if (out.FunctionError) {
          const err = yield* Schema.decodeEffect(LambdaError)(text);
          return yield* new WorkerJobFailed({
            message: err.errorMessage ?? `worker job ${name} failed (${out.FunctionError})`,
          });
        }
        return JSON.parse(text) as unknown;
      });

      const call = Effect.fn('WorkerJobs.call')(
        function* (name: string, payload: unknown) {
          const body = JSON.stringify({ __platform: 'invoke', name, payload });
          return yield* Option.match(localWorker, {
            onSome: (url) => callLocal(url, body, name),
            onNone: () => callLambda(body, name),
          });
        },
        Effect.catchTags({
          AwsError: Effect.die,
          HttpClientError: Effect.die,
          SchemaError: Effect.die,
        }),
      );

      return WorkerJobs.of({ invoke, call });
    }),
  );
}
