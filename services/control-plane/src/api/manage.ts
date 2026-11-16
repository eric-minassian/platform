/**
 * Data browser, storage, secrets, job controls (run cron, redrive DLQ), email's suppression list
 * and pauses, and service controls.
 */
import { ENV_NAME_PATTERN, isEmailAddress, isPreviewStage, publicStores } from '@ericminassian/platform-core';
import { BadRequest, Conflict, NotFound, PlatformApi } from '@ericminassian/platform-core/platform-api';
import { Effect, Option } from 'effect';
import { HttpApiBuilder } from 'effect/http-api';
import { DataBrowser } from '../data.ts';
import { AppEmail } from '../email.ts';
import { AppQueues } from '../jobs/queues.ts';
import { AppServices } from '../jobs/services.ts';
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
    const email = yield* AppEmail;
    const queues = yield* AppQueues;
    const secrets = yield* AppSecrets;
    const services = yield* AppServices;

    const scope = Effect.fnUntraced(function* (app: string, stage: string | undefined) {
      const found = yield* access.memberApp(app);
      return { app: found.app.name, stage: yield* stageParam(stage) };
    });

    /** The app and stage of an email endpoint; 404 unless the stage's live deployment declares `email`. */
    const emailScope = Effect.fnUntraced(function* (app: string, stage: string | undefined) {
      const target = yield* scope(app, stage);
      const manifest = yield* access.liveManifest(target.app, target.stage);
      if (Option.isNone(manifest) || !manifest.value.email)
        return yield* new NotFound({
          code: 'not_found',
          message: `${target.app}/${target.stage} doesn't send email: its live deployment declares no \`email\` in plat.config.ts`,
        });
      return target;
    });

    /** Starts, stops or restarts a service the stage's live deployment declares. */
    const controlService = Effect.fnUntraced(function* (
      params: { readonly app: string; readonly name: string },
      stageQuery: string | undefined,
      action: 'start' | 'stop' | 'restart',
      requestedMinutes?: number,
    ) {
      const { app, stage } = yield* scope(params.app, stageQuery);
      const declared = Option.getOrUndefined(yield* access.liveManifest(app, stage))?.services ?? {};
      const config = Object.hasOwn(declared, params.name) ? declared[params.name] : undefined;
      if (!config) return yield* NotFound.of(`service ${params.name} on ${stage}`);
      // On a preview a start always comes with a stop: after the service's previewMinutes,
      // or 30 when that is 0 (a deploy doesn't run it then).
      const minutes =
        action === 'start' && isPreviewStage(stage)
          ? (requestedMinutes ?? (config.previewMinutes || 30))
          : requestedMinutes;
      return yield* services.control({ app, stage, name: params.name, action, minutes }).pipe(
        Effect.catchTags({
          ServiceMissing: () =>
            Effect.fail(
              new NotFound({
                code: 'not_found',
                message: `service ${params.name} on ${stage} doesn't exist yet: deploy the stage to create it`,
              }),
            ),
          ServiceActionFailed: (e) =>
            Effect.fail(new Conflict({ code: 'service_action_failed', message: e.message })),
        }),
      );
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
          const manifest = yield* access.liveManifest(app, stage);
          const served = Option.match(manifest, { onNone: (): string[] => [], onSome: publicStores });
          if (!query.store) {
            const stores = Option.match(manifest, { onNone: () => [], onSome: (m) => m.storage });
            return { stores, public: served };
          }
          return yield* data.storage({
            app,
            stage,
            store: query.store,
            public: served.includes(query.store),
            prefix: query.prefix,
            cursor: query.cursor,
          });
        }),

      storageUrl: ({ params, query }) =>
        Effect.gen(function* () {
          const { app, stage } = yield* scope(params.app, query.stage);
          if (query.key.includes('..')) return yield* BadRequest.of('invalid key');
          const manifest = yield* access.liveManifest(app, stage);
          const served = Option.match(manifest, { onNone: (): string[] => [], onSome: publicStores });
          return {
            url: yield* data.downloadUrl({
              app,
              stage,
              store: query.store,
              public: served.includes(query.store),
              key: query.key,
            }),
          };
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
          yield* queues.runCron(app, stage, manifest.value, params.name);
          return { started: params.name };
        }),

      restartService: ({ params, query }) => controlService(params, query.stage, 'restart'),

      startService: ({ params, query, payload }) =>
        controlService(params, query.stage, 'start', payload?.minutes),

      stopService: ({ params, query }) => controlService(params, query.stage, 'stop'),

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

      suppressed: ({ params, query }) =>
        Effect.gen(function* () {
          const { app, stage } = yield* emailScope(params.app, query.stage);
          return yield* email.suppressed(app, stage, query.next);
        }),

      unsuppress: ({ params, query }) =>
        Effect.gen(function* () {
          const { app, stage } = yield* emailScope(params.app, query.stage);
          const address = params.address.trim();
          if (!isEmailAddress(address)) return yield* BadRequest.of(`"${address}" is not an email address`);
          return yield* email.unsuppress(app, stage, address);
        }),

      resumeEmail: ({ params, query }) =>
        Effect.gen(function* () {
          const { app, stage } = yield* emailScope(params.app, query.stage);
          return yield* email.resume(app, stage);
        }),
    });
  }),
);
