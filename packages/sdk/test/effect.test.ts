import { gzipSync } from 'node:zlib';
import { UNAUTHORIZED_BODY } from '@ericminassian/platform-core';
import { Effect, Layer, Option, Redacted, Schema } from 'effect';
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from 'effect/http-api';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  Authentication,
  CurrentUser,
  Db,
  defineWorker,
  Jobs,
  Platform,
  type QueueMessage,
  Queues,
  Secrets,
  Storage,
  toFetchHandler,
  Unauthorized,
  type User,
} from '../src/index.ts';
import {
  captureTelemetry,
  createPlatformFetch,
  createWorkerHandler,
  resetPlatform,
  useTestBindings,
} from '../src/testing.ts';
import { dbContract } from './effect-db-contract.ts';

let telemetry: ReturnType<typeof captureTelemetry>;
beforeEach(() => {
  telemetry = captureTelemetry();
});
afterEach(() => {
  telemetry.stop();
  resetPlatform();
});
const ofType = (t: string) => telemetry.events.filter((e) => e.t === t);

describe('Db in memory', () => {
  it('behaves like DynamoDB', () =>
    Effect.runPromise(dbContract('notes').pipe(Effect.provide(Db.layerMemory()))));
});

describe('toFetchHandler', () => {
  class Gone extends Schema.TaggedError<Gone, { readonly brand: unique symbol }>()(
    'Gone',
    {},
    { httpApiStatus: 410 },
  ) {}

  const Api = HttpApi.make('test')
    .add(
      HttpApiGroup.make('public', { topLevel: true }).add(
        HttpApiEndpoint.get('hello', '/hello/:name', {
          params: { name: Schema.String },
          success: Schema.String,
        }),
        HttpApiEndpoint.get('crash', '/crash', { success: Schema.String }),
        HttpApiEndpoint.get('gone', '/gone', { success: Schema.String, error: Gone }),
        HttpApiEndpoint.post('echo', '/echo', {
          payload: Schema.Struct({ n: Schema.Finite }),
          success: Schema.Finite,
        }),
      ),
    )
    .add(
      HttpApiGroup.make('private', { topLevel: true })
        .add(HttpApiEndpoint.get('me', '/me', { success: Schema.String }))
        .middleware(Authentication),
    )
    .prefix('/api');

  const Handlers = Layer.mergeAll(
    HttpApiBuilder.group(Api, 'public', (handlers) =>
      handlers
        .handle('hello', ({ params }) =>
          Effect.logInfo('greeting').pipe(
            Effect.annotateLogs({ name: params.name }),
            Effect.as(`hi ${params.name}`),
          ),
        )
        .handle('crash', () => Effect.die(new Error('kaboom 42')))
        .handle('gone', () => Effect.fail(new Gone()))
        .handle('echo', ({ payload }) => Effect.succeed(payload.n)),
    ),
    HttpApiBuilder.group(Api, 'private', (handlers) =>
      handlers.handle('me', () => Effect.map(CurrentUser, (u) => u.id)),
    ),
  );

  const alice: User = { id: 'alice', groups: [] };
  const app = () =>
    createPlatformFetch(
      toFetchHandler(
        HttpApiBuilder.layer(Api).pipe(
          Layer.provide(Handlers),
          Layer.provide(Platform.layerMemory({ users: [alice] })),
        ),
      ),
    );
  const get = (path: string, init?: RequestInit) => app()(new Request(`http://localhost${path}`, init));

  beforeEach(() => {
    useTestBindings({ app: 'todo' });
  });

  it('records route patterns and writes Effect logs as platform log lines', async () => {
    const res = await get('/api/hello/ada');
    expect(await res.json()).toBe('hi ada');
    expect(ofType('req')).toMatchObject([{ route: '/api/hello/:name', status: 200 }]);
    const [log] = ofType('log');
    expect(log).toMatchObject({
      level: 'info',
      msg: 'greeting',
      name: 'ada',
      trace: ofType('req')[0]!.trace,
    });
  });

  it('reports a defect once, with its own stack, and answers 500', async () => {
    const res = await get('/api/crash');
    expect(res.status).toBe(500);
    const errors = ofType('err');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      source: 'http',
      name: 'Error',
      message: 'kaboom 42',
      route: '/api/crash',
    });
    expect((errors[0] as { stack?: string }).stack).toContain('effect.test.ts');
  });

  it('answers declared errors and bad requests without recording errors', async () => {
    expect((await get('/api/gone')).status).toBe(410);
    const bad = await get('/api/echo', {
      method: 'POST',
      body: '{bad',
      headers: { 'content-type': 'application/json' },
    });
    expect(bad.status).toBe(400);
    const wrong = await get('/api/echo', {
      method: 'POST',
      body: '{"n":"x"}',
      headers: { 'content-type': 'application/json' },
    });
    expect(wrong.status).toBe(400);
    expect(ofType('err')).toEqual([]);
  });

  it('requires sign-in behind Authentication, with the platform 401 body', async () => {
    const signedOut = await get('/api/me');
    expect(signedOut.status).toBe(401);
    const body = await signedOut.json();
    expect(body).toEqual(UNAUTHORIZED_BODY);
    expect(Schema.decodeUnknownSync(Unauthorized)(body)).toBeInstanceOf(Unauthorized);

    const signedIn = await get('/api/me', { headers: { authorization: 'Bearer alice' } });
    expect(await signedIn.json()).toBe('alice');
  });
});

describe('defineWorker', () => {
  class Bounced extends Schema.TaggedError<Bounced, { readonly brand: unique symbol }>()('Bounced', {
    message: Schema.String,
  }) {}
  const ARN = 'arn:aws:sqs:us-east-1:000000000000:todo--test--emails';
  const record = (id: string, body: unknown) => ({
    messageId: id,
    body: JSON.stringify(body),
    eventSource: 'aws:sqs',
    eventSourceARN: ARN,
    attributes: { ApproximateReceiveCount: '3' },
  });

  beforeEach(() => {
    useTestBindings({ app: 'todo', queues: { emails: { url: 'https://sqs/emails', arn: ARN } } });
  });

  it('runs handlers on one runtime and fails the jobs whose effect fails', async () => {
    let builds = 0;
    const seen: unknown[] = [];
    const handler = createWorkerHandler(
      defineWorker({
        layer: Layer.effectDiscard(Effect.sync(() => void builds++)).pipe(
          Layer.provideMerge(Platform.layerMemory()),
        ),
        queues: {
          emails: (message: QueueMessage<{ to?: string; fail?: boolean }>, ctx) =>
            message.body.fail
              ? Effect.fail(new Bounced({ message: 'bounced' }))
              : Effect.sync(() => {
                  seen.push({ body: message.body, attempt: message.attempt, trace: ctx.trace.length });
                }),
        },
        invoke: { double: (payload: number) => Effect.succeed(payload * 2) },
      }),
    );

    expect(await handler({ Records: [record('a', { to: 'x' }), record('b', { fail: true })] }, {})).toEqual({
      batchItemFailures: [{ itemIdentifier: 'b' }],
    });
    expect(await handler({ __platform: 'invoke', name: 'double', payload: 21 }, {})).toBe(42);
    expect(seen).toEqual([{ body: { to: 'x' }, attempt: 3, trace: 32 }]);
    expect(builds).toBe(1);
    expect(ofType('err')).toMatchObject([{ source: 'job', message: 'bounced', job: 'queue:emails' }]);
  });

  it('hands CloudWatch Logs batches to the logs handler, failing the delivery when it fails', async () => {
    const messages: string[] = [];
    const handler = createWorkerHandler(
      defineWorker({
        layer: Platform.layerMemory(),
        logs: (batch) =>
          batch.logGroup.endsWith('/broken')
            ? Effect.fail(new Bounced({ message: 'unreadable' }))
            : Effect.sync(() => {
                messages.push(...batch.logEvents.map((e) => `${batch.logGroup} ${e.message}`));
              }),
      }),
    );
    const delivery = (logGroup: string) => ({
      awslogs: {
        data: gzipSync(
          JSON.stringify({
            messageType: 'DATA_MESSAGE',
            logGroup,
            logStream: 's',
            logEvents: [{ id: '1', timestamp: 1, message: 'hello' }],
          }),
        ).toString('base64'),
      },
    });

    await handler(delivery('/platform/apps/todo/prod/web'), {});
    expect(messages).toEqual(['/platform/apps/todo/prod/web hello']);
    await expect(handler(delivery('/platform/apps/todo/prod/broken'), {})).rejects.toThrow('unreadable');
  });
});

describe('Platform.layerMemory', () => {
  it('records sends and serves secrets, stores and users', () =>
    Effect.gen(function* () {
      const memory = yield* Platform.Memory;
      yield* (yield* Queues).send('emails', { to: 'a' }, { delay: '1 minute' });
      expect(yield* memory.sent).toEqual([{ queue: 'emails', body: { to: 'a' }, delaySeconds: 60 }]);
      yield* (yield* Jobs).invoke('reindex', { id: 1 });
      expect(yield* memory.invoked).toEqual([{ name: 'reindex', payload: { id: 1 } }]);

      const secrets = yield* Secrets;
      expect(Option.map(yield* secrets.getOptional('KEY'), Redacted.value)).toEqual(Option.some('v'));
      expect(yield* secrets.getOptional('OTHER')).toEqual(Option.none());

      const uploads = (yield* Storage).store('uploads');
      for (const k of ['a/1.txt', 'a/2.txt', 'b/3.txt']) yield* uploads.put(k, k);
      expect(yield* uploads.getText('a/2.txt')).toEqual(Option.some('a/2.txt'));
      const first = yield* uploads.list('a/', { limit: 1 });
      expect(first.objects.map((o) => o.key)).toEqual(['a/1.txt']);
      const rest = yield* uploads.list('a/', { cursor: first.cursor! });
      expect(rest.objects.map((o) => o.key)).toEqual(['a/2.txt']);
      expect((yield* Effect.exit(uploads.put('../escape', 'x')))._tag).toBe('Failure');
    }).pipe(Effect.provide(Platform.layerMemory({ secrets: { KEY: 'v' } })), Effect.runPromise));
});
