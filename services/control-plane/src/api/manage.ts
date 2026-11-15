/** Data browser, storage, secrets, and job controls (run cron, redrive DLQ). */
import { ENV_NAME_PATTERN } from '@ericminassian/platform-core';
import { BadRequest, Conflict, NotFound, PlatformApi } from '@ericminassian/platform-core/platform-api';
import { Effect, Option } from 'effect';
import { HttpApiBuilder } from 'effect/http-api';
import { DataBrowser } from '../data.ts';
import { AppQueues } from '../jobs/queues.ts';
import { AppSecrets } from '../secrets.ts';
import { Access, stageParam } from './access.ts';

/** `?scope=shared` targets the app-wide value (no stage); otherwise the stage (`?stage=`, default prod). */
const secretStage = (query: {
  readonly scope?: 'shared' | 'stage' | undefined;
  readonly stage?: string | undefined;
}) => (query.scope === 'shared' ? Effect.undefined : stageParam(query.stage));

const secretName = (name: string) =>
  ENV_NAME_PATTERN.test(name)
    ? Effect.succeed(name)
    : Effect.fail(BadRequest.of(`secret names must match ${ENV_NAME_PATTERN}`));

export const ManageLive = HttpApiBuilder.group(
  PlatformApi,
  'manage',
  Effect.fn(function* (handlers) {
    const access = yield* Access;
    const data = yield* DataBrowser;
    const queues = yield* AppQueues;
    const secrets = yield* AppSecrets;

    const scope = Effect.fnUntraced(function* (app: string, stage: string | undefined) {
      const found = yield* access.memberApp(app);
      return { app: found.app.name, stage: yield* stageParam(stage) };
    });

    return handlers.handleAll({
      collections: ({ params, query }) =>
        Effect.gen(function* () {
          const { app, stage } = yield* scope(params.app, query.stage);
          return yield* data.collections(app, stage);
        }),

      items: ({ params, query }) =>
        Effect.gen(function* () {
          const { app, stage } = yield* scope(params.app, query.stage);
          return yield* data.items({
            app,
            stage,
            collection: query.collection,
            partition: query.partition,
            cursor: query.cursor,
            limit: query.limit,
          });
        }),

      storage: ({ params, query }) =>
        Effect.gen(function* () {
          const { app, stage } = yield* scope(params.app, query.stage);
          if (!query.store) {
            const manifest = yield* access.liveManifest(app, stage);
            return { stores: Option.match(manifest, { onNone: () => [], onSome: (m) => m.storage }) };
          }
          return yield* data.storage({
            app,
            stage,
            store: query.store,
            prefix: query.prefix,
            cursor: query.cursor,
          });
        }),

      storageUrl: ({ params, query }) =>
        Effect.gen(function* () {
          const { app, stage } = yield* scope(params.app, query.stage);
          if (query.key.includes('..')) return yield* BadRequest.of('invalid key');
          return { url: yield* data.downloadUrl({ app, stage, store: query.store, key: query.key }) };
        }),

      secrets: ({ params, query }) =>
        Effect.gen(function* () {
          const { app, stage } = yield* scope(params.app, query.stage);
          const [set, manifest] = yield* Effect.all(
            [secrets.list(app, stage), access.liveManifest(app, stage)],
            {
              concurrency: 'unbounded',
            },
          );
          const declared = Option.match(manifest, { onNone: () => [], onSome: (m) => m.secrets });
          return { secrets: set, declared, missing: declared.filter((n) => !set.some((s) => s.name === n)) };
        }),

      putSecret: ({ params, query, payload }) =>
        Effect.gen(function* () {
          const { app } = yield* access.memberApp(params.app);
          const name = yield* secretName(params.name);
          yield* secrets.put(app.name, name, payload.value, yield* secretStage(query));
        }),

      deleteSecret: ({ params, query }) =>
        Effect.gen(function* () {
          const { app } = yield* access.memberApp(params.app);
          const name = yield* secretName(params.name);
          yield* secrets.remove(app.name, name, yield* secretStage(query));
        }),

      runCron: ({ params, query }) =>
        Effect.gen(function* () {
          const { app, stage } = yield* scope(params.app, query.stage);
          const manifest = yield* access.liveManifest(app, stage);
          if (Option.isNone(manifest) || !manifest.value.crons[params.name])
            return yield* NotFound.of(`cron ${params.name} on ${stage}`);
          yield* queues.runCron(app, stage, params.name);
          return { started: params.name };
        }),

      redrive: ({ params, query }) =>
        Effect.gen(function* () {
          const { app, stage } = yield* scope(params.app, query.stage);
          const manifest = yield* access.liveManifest(app, stage);
          if (Option.isNone(manifest) || !manifest.value.queues[params.name])
            return yield* NotFound.of(`queue ${params.name} on ${stage}`);
          const taskHandle = yield* queues
            .redrive(app, stage, params.name)
            .pipe(Effect.mapError((e) => new Conflict({ code: 'redrive_failed', message: e.message })));
          return { taskHandle };
        }),
    });
  }),
);
