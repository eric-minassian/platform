/**
 * Stages and deployments: `plat deploy` creates a deployment, uploads its
 * artifacts with the forms it gets back, and starts it; the worker runs it.
 */
import {
  type ArtifactFile,
  isPreviewStage,
  ManifestError,
  newDeploymentId,
  PROD_STAGE,
  parseManifest,
  publicUrl,
  RollbackResponse,
  stageHost,
} from '@ericminassian/platform-core';
import {
  BadRequest,
  Conflict,
  CurrentPrincipal,
  Forbidden,
  InvalidManifest,
  LimitReached,
  NotFound,
  PlatformApi,
} from '@ericminassian/platform-core/platform-api';
import { DateTime, Effect, Option, Schema } from 'effect';
import { HttpApiBuilder } from 'effect/http-api';
import { Artifacts } from '../artifacts.ts';
import { actorOf } from '../authz.ts';
import { Settings, servicesLimitIssue } from '../config.ts';
import { WorkerJobs } from '../jobs/call.ts';
import { type DeploymentItem, Store } from '../store.ts';
import { Access, publicDeployment, publicStage } from './access.ts';

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

export const StagesLive = HttpApiBuilder.group(
  PlatformApi,
  'stages',
  Effect.fn(function* (handlers) {
    const access = yield* Access;
    const jobs = yield* WorkerJobs;
    const store = yield* Store;

    return handlers.handleAll({
      list: ({ params }) =>
        Effect.gen(function* () {
          const { app } = yield* access.memberApp(params.app);
          return (yield* store.listStages(app.name)).map(publicStage);
        }),

      destroy: ({ params, query }) =>
        Effect.gen(function* () {
          const stage = params.stage;
          const app = yield* access.stageApp(params.app, stage, 'destroy');
          if (stage === PROD_STAGE) {
            if ((yield* CurrentPrincipal).kind !== 'member')
              return yield* new Forbidden({
                code: 'forbidden',
                message: 'prod can only be destroyed by a member',
              });
            if (query.confirm !== app.name)
              return yield* BadRequest.of(`destroying prod needs ?confirm=${app.name}`);
          }
          const st = yield* store.getStage(app.name, stage);
          if (Option.isNone(st) || st.value.status === 'destroyed') return { status: 'destroyed' as const };
          yield* store.updateStage(app.name, stage, { status: 'destroying' });
          yield* jobs.invoke('destroy', { app: app.name, stage });
          return { status: 'destroying' as const };
        }),

      rollback: ({ params, payload }) =>
        Effect.gen(function* () {
          const { app } = yield* access.memberApp(params.app);
          return yield* jobs
            .call('rollback', {
              app: app.name,
              stage: params.stage,
              ...(payload?.deploymentId ? { deploymentId: payload.deploymentId } : {}),
            })
            .pipe(
              Effect.mapError((e) => new Conflict({ code: 'rollback_failed', message: e.message })),
              // The worker's rollback answers the deployment that is now live, and its URL.
              Effect.flatMap((result) => Effect.orDie(Schema.decodeUnknownEffect(RollbackResponse)(result))),
            );
        }),
    });
  }),
);

export const DeploymentsLive = HttpApiBuilder.group(
  PlatformApi,
  'deployments',
  Effect.fn(function* (handlers) {
    const access = yield* Access;
    const artifacts = yield* Artifacts;
    const jobs = yield* WorkerJobs;
    const settings = yield* Settings;
    const store = yield* Store;

    const findDeployment = Effect.fn('findDeployment')(function* (id: string) {
      const found = yield* store.getDeployment(id);
      if (Option.isNone(found)) return yield* NotFound.of('deployment');
      return found.value;
    });

    return handlers.handleAll({
      list: ({ params, query }) =>
        Effect.gen(function* () {
          const { app } = yield* access.memberApp(params.app);
          const limit = Math.max(1, Math.min(query.limit || 50, 200));
          // With a stage filter, read further back so the filtered page can fill up.
          const list = yield* store.listDeployments(app.name, query.stage ? 200 : limit);
          return (
            list
              .filter((d) => !query.stage || d.stage === query.stage)
              .slice(0, limit)
              // List view: drop the event log and manifest (fetch one deployment for those).
              .map(({ events: _e, manifest: _m, ...d }) => publicDeployment({ ...d, events: [] }))
          );
        }),

      create: ({ params, payload }) =>
        Effect.gen(function* () {
          const stage = payload.stage;
          const app = yield* access.stageApp(params.app, stage);
          const manifest = yield* Effect.try({
            try: () => parseManifest(payload.manifest),
            catch: (e) => InvalidManifest.of(e instanceof ManifestError ? e.message : String(e)),
          });
          if (manifest.name !== app.name)
            return yield* BadRequest.of(`plat.config.ts name "${manifest.name}" must be "${app.name}"`);
          const { emailsPerDay } = settings.platform.limits;
          if (manifest.email && manifest.email.dailyLimit > emailsPerDay) {
            return yield* LimitReached.of(
              `email.dailyLimit is ${manifest.email.dailyLimit}, above the platform's ceiling of ${emailsPerDay} recipients a day (limits.emailsPerDay in platform.config.ts)`,
            );
          }
          const overLimit = servicesLimitIssue(settings.platform, manifest);
          if (overLimit) return yield* InvalidManifest.of(overLimit);

          // manifest.json is always uploaded; tolerate clients that list it.
          const files = [...new Set(payload.files ?? [])].filter((f) => f !== 'manifest.json');

          const existing = yield* store.listStages(app.name);
          const others = existing.filter((s) => s.status !== 'destroyed' && s.stage !== stage);
          const isNew = !existing.some((s) => s.stage === stage && s.status !== 'destroyed');
          if (isNew && others.length >= settings.platform.limits.stagesPerApp) {
            return yield* LimitReached.of(
              `${app.name} already has ${others.length} stages (limit ${settings.platform.limits.stagesPerApp})`,
            );
          }

          const id = newDeploymentId();
          const p = yield* CurrentPrincipal;
          const commit = payload.commit ? payload.commit.slice(0, 64) : p.kind === 'ci' ? p.sha : undefined;
          const ref = payload.ref ? payload.ref.slice(0, 200) : p.kind === 'ci' ? p.ref : undefined;
          const deployment: DeploymentItem = {
            id,
            app: app.name,
            stage,
            status: 'awaiting_upload',
            actor: actorOf(p),
            ...(commit ? { commit } : {}),
            ...(ref ? { ref } : {}),
            ...(payload.message ? { message: payload.message.slice(0, 500) } : {}),
            manifest,
            events: [],
            createdAt: yield* nowIso,
          };
          yield* store.createDeployment(deployment);
          const uploads = yield* artifacts.uploadForms({ app: app.name, stage, deployment: id }, [
            'manifest.json',
            ...files,
          ] satisfies ArtifactFile[]);
          return { deployment: publicDeployment(deployment), uploads };
        }),

      get: ({ params }) =>
        Effect.gen(function* () {
          const dep = yield* findDeployment(params.id);
          yield* access.stageApp(dep.app, dep.stage);
          return publicDeployment(dep);
        }),

      start: ({ params }) =>
        Effect.gen(function* () {
          const dep = yield* findDeployment(params.id);
          const app = yield* access.stageApp(dep.app, dep.stage);
          const alreadyStarted = (message: string) => new Conflict({ code: 'already_started', message });
          if (dep.status !== 'awaiting_upload') return yield* alreadyStarted(`deployment is ${dep.status}`);

          const ref = { app: dep.app, stage: dep.stage, deployment: dep.id };
          const manifest = yield* artifacts
            .locate(ref, 'manifest.json')
            .pipe(Effect.orElseSucceed(Option.none));
          if (Option.isNone(manifest)) return yield* BadRequest.of('manifest.json was not uploaded');

          if (!(yield* store.updateDeployment(dep.app, dep.id, { status: 'queued' }, 'awaiting_upload'))) {
            return yield* alreadyStarted('deployment was started concurrently');
          }
          const now = yield* nowIso;
          const st = yield* store.getStage(app.name, dep.stage);
          if (Option.isNone(st) || st.value.status === 'destroyed') {
            const platform = yield* settings.runtime;
            const host = stageHost(app.name, dep.stage, platform.domain);
            yield* store.putStage({
              app: app.name,
              stage: dep.stage,
              host,
              url: publicUrl(platform, host),
              status: 'deploying',
              preview: isPreviewStage(dep.stage),
              createdAt: now,
              updatedAt: now,
            });
          } else {
            yield* store.updateStage(app.name, dep.stage, { status: 'deploying' });
          }
          yield* jobs.invoke('deploy', { id: dep.id });
          return publicDeployment({ ...dep, status: 'queued' });
        }),
    });
  }),
);
