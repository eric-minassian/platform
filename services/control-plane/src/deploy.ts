/**
 * The deployer: runs one deployment through the engine and records progress.
 * Runs in the worker (`invoke.deploy`) so it gets the 15-minute timeout; the
 * API only queues it. Rollbacks also run in the worker (see jobs/call.ts),
 * which the API waits for.
 */
import {
  type ArtifactFile,
  type DeploymentEventEntry,
  ManifestError,
  names,
  type PlatformRuntimeConfig,
  parseManifest,
  type RealtimeEdgeEntry,
  type ResolvedManifest,
  type RollbackResponse,
  type RouteRecord,
  webComputeFor,
} from '@ericminassian/platform-core';
import {
  type ControlServiceInput,
  createEngine,
  type DeployedService,
  type DeployStageInput,
  type DeployStageResult,
  type DestroyStageInput,
  type Engine,
  type ExpireStorageInput,
  type EngineLogEntry,
  type RollbackStageInput,
  type ServiceRuntimeState,
  type StageServicesInput,
} from '@ericminassian/platform-engine';
import {
  Cause,
  Clock,
  Context,
  DateTime,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Queue,
  Schedule,
  Schema,
  Stream,
} from 'effect';
import { HttpClient } from 'effect/http';
import { type ArtifactRef, Artifacts } from './artifacts.ts';
import { Aws, accountConcurrency } from './aws.ts';
import { logRetentionDays, Settings, servicesLimitIssue } from './config.ts';
import { EDGE_TIMEOUT_SECONDS, waitForEdge } from './edge.ts';
import { stageCompute } from './records.ts';
import { type DeploymentItem, type StageItem, Store } from './store.ts';

/** A deployment step that can't go on; `message` lands in the deployment's record. */
export class DeployFailed extends Schema.TaggedError<DeployFailed, { readonly brand: unique symbol }>()(
  'DeployFailed',
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

/** The stage can't be rolled back as asked; the API answers 409 with `message`. */
export class RollbackRefused extends Schema.TaggedError<RollbackRefused, { readonly brand: unique symbol }>()(
  'RollbackRefused',
  { message: Schema.String },
) {}

const engineFailed = (cause: unknown) =>
  new DeployFailed({ message: cause instanceof Error ? cause.message : String(cause), cause });

/** The engine (promise-based, shared with the CLI and the foundation). */
export class StageEngine extends Context.Service<
  StageEngine,
  {
    deploy(
      input: DeployStageInput,
      log: (entry: EngineLogEntry) => void,
    ): Effect.Effect<DeployStageResult, DeployFailed>;
    /** Points the stage at an earlier deployment; answers the route it now has. */
    rollback(input: RollbackStageInput): Effect.Effect<RouteRecord, DeployFailed>;
    destroy(
      input: DestroyStageInput,
      log: (entry: EngineLogEntry) => void,
    ): Effect.Effect<void, DeployFailed>;
    /**
     * Makes sure realtime's public API key exists and lasts another year, and
     * that the router's realtime entry is current. None without an Event API.
     */
    ensureRealtime(
      platform: PlatformRuntimeConfig,
      log: (entry: EngineLogEntry) => void,
    ): Effect.Effect<Option.Option<RealtimeEdgeEntry>, DeployFailed>;
    /** Deletes files their store's `expireAfterDays` no longer keeps; answers how many, by store. */
    expireStorage(input: ExpireStorageInput): Effect.Effect<Record<string, number>, DeployFailed>;
    /** The stage's long-running services as ECS runs them now. */
    describeServices(
      input: StageServicesInput,
    ): Effect.Effect<ReadonlyArray<ServiceRuntimeState>, DeployFailed>;
    /** Starts, stops or restarts one of the stage's services. */
    controlService(
      input: ControlServiceInput,
    ): Effect.Effect<{ readonly desired: number; readonly stopsAt?: string | undefined }, DeployFailed>;
  }
>()('@ericminassian/platform-control-plane/StageEngine') {
  static readonly layer: Layer.Layer<StageEngine> = Layer.sync(StageEngine, () => {
    // Service reads and controls log nothing, so they share one engine per region and
    // the console's polling reuses its clients' connections.
    const engines = new Map<string, Engine>();
    const shared = (region: string): Engine => {
      let engine = engines.get(region);
      if (!engine) {
        engine = createEngine({ region });
        engines.set(region, engine);
      }
      return engine;
    };
    return StageEngine.of({
      deploy: (input, log) =>
        Effect.tryPromise({
          try: () => createEngine({ region: input.platform.region, log }).deployStage(input),
          catch: engineFailed,
        }),
      rollback: (input) =>
        Effect.tryPromise({
          try: () => createEngine({ region: input.platform.region }).rollbackStage(input),
          catch: engineFailed,
        }),
      destroy: (input, log) =>
        Effect.tryPromise({
          try: () => createEngine({ region: input.platform.region, log }).destroyStage(input),
          catch: engineFailed,
        }),
      ensureRealtime: (platform, log) =>
        Effect.tryPromise({
          try: () => createEngine({ region: platform.region, log }).ensureRealtimePlatform(platform),
          catch: engineFailed,
        }).pipe(Effect.map(Option.fromUndefinedOr)),
      expireStorage: (input) =>
        Effect.tryPromise({
          try: () => createEngine({ region: input.platform.region }).expireStorage(input),
          catch: engineFailed,
        }),
      describeServices: (input) =>
        Effect.tryPromise({
          try: () => shared(input.platform.region).describeServices(input),
          catch: engineFailed,
        }),
      controlService: (input) =>
        Effect.tryPromise({
          try: () => shared(input.platform.region).controlService(input),
          catch: engineFailed,
        }),
    });
  });
}

type Push = (entry: Omit<DeploymentEventEntry, 'ts'>) => void;

/** The event a deployment records for each service it rolled out. */
export function deployedServiceEvent(
  app: string,
  stage: string,
  service: DeployedService,
): Omit<DeploymentEventEntry, 'ts'> {
  const msg =
    service.desired === 0
      ? `service ${service.name} is on this deployment, stopped`
      : `service ${service.name} runs this deployment${service.stopsAt ? `, stopping at ${service.stopsAt}` : ''}`;
  return {
    level: 'info',
    msg,
    resource: `ecs-service ${names.service(app, stage, service.name)}`,
  };
}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

/** The server build a deploy put up: a Web Function revision or a request-mode function version. */
const serverBuild = (result: DeployStageResult) =>
  result.webFunction?.revisionId ?? result.requestFunction?.version;

/** The message a failed deployment records. */
const failureMessage = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.squash(cause);
  return error instanceof Error ? error.message : String(error);
};

export class Deployer extends Context.Service<
  Deployer,
  {
    /** Runs a queued deployment; a second run of the same one does nothing. */
    run(id: string): Effect.Effect<void>;
    /** Tears a stage down (prod keeps its data); fails, so the job retries, if the engine fails. */
    destroy(app: string, stage: string): Effect.Effect<void, DeployFailed>;
    /** Points a stage back at an earlier successful deployment (default: the previous one). */
    rollback(
      app: string,
      stage: string,
      toDeployment?: string,
    ): Effect.Effect<RollbackResponse, RollbackRefused>;
  }
>()('@ericminassian/platform-control-plane/Deployer') {
  static readonly layer: Layer.Layer<
    Deployer,
    never,
    Artifacts | Aws | HttpClient.HttpClient | Settings | StageEngine | Store
  > = Layer.effect(
    Deployer,
    Effect.gen(function* () {
      const aws = yield* Aws;
      const artifacts = yield* Artifacts;
      const http = yield* HttpClient.HttpClient;
      const settings = yield* Settings;
      const engine = yield* StageEngine;
      const store = yield* Store;

      /**
       * Progress, which the engine reports through a synchronous callback. Each
       * entry is logged, and with `deployment` also appended to its event log
       * in batches (20 entries or 1.5 s), which `plat deploy` streams. Closing
       * the scope writes what is left.
       */
      const progress = Effect.fnUntraced(function* (deployment?: {
        readonly app: string;
        readonly id: string;
      }) {
        const clock = yield* Clock.Clock;
        const queue = yield* Queue.unbounded<DeploymentEventEntry, Cause.Done>();
        const writer = yield* Stream.fromQueue(queue).pipe(
          Stream.tap((e) =>
            (e.level === 'error' ? Effect.logError : e.level === 'warn' ? Effect.logWarning : Effect.logInfo)(
              e.msg,
            ).pipe(Effect.annotateLogs(e.resource ? { resource: e.resource } : {})),
          ),
          Stream.groupedWithin(20, '1.5 seconds'),
          Stream.runForEach((batch) =>
            deployment
              ? store
                  .appendDeploymentEvents(deployment.app, deployment.id, batch)
                  .pipe(
                    Effect.catchCause((cause) =>
                      Effect.logWarning('failed to record deployment events', cause),
                    ),
                  )
              : Effect.void,
          ),
          Effect.forkScoped,
        );
        yield* Effect.addFinalizer(() => Queue.end(queue).pipe(Effect.andThen(Fiber.join(writer))));
        const push: Push = (entry) => {
          Queue.offerUnsafe(queue, { ts: clock.currentTimeMillisUnsafe(), ...entry });
        };
        return push;
      });

      const findArtifacts = Effect.fnUntraced(function* (ref: ArtifactRef) {
        const slots: ReadonlyArray<readonly [keyof DeployStageInput['artifacts'], ArtifactFile]> = [
          ['server', 'server.zip'],
          ['worker', 'worker.zip'],
          ['static', 'static.zip'],
          ['services', 'services.zip'],
        ];
        const found = yield* Effect.forEach(
          slots,
          ([slot, file]) => Effect.map(artifacts.locate(ref, file), (loc) => [slot, loc] as const),
          { concurrency: 'unbounded' },
        );
        const located: DeployStageInput['artifacts'] = {};
        for (const [slot, loc] of found) if (Option.isSome(loc)) located[slot] = loc.value;
        return located;
      }, Effect.orDie);

      /** Everything up to the route flip and the edge check; the caller records the outcome. */
      const deployStage = Effect.fnUntraced(function* (
        dep: DeploymentItem,
        before: Option.Option<StageItem>,
        push: Push,
      ) {
        const { app, stage, id } = dep;
        // A compute switch runs an earlier deployment's build again, from where it was uploaded.
        const ref: ArtifactRef = { app, stage, deployment: dep.computeSwitchOf ?? id };
        const platform = yield* settings.runtime;
        push({ level: 'info', msg: `deploying ${app} to ${stage}` });
        const raw = yield* artifacts.readText(ref, 'manifest.json');
        const manifest = yield* Effect.try({
          try: () => {
            // `plat build` writes { manifest, resolved, build }; accept a bare manifest too.
            const doc = JSON.parse(raw) as { manifest?: unknown };
            return parseManifest(doc.manifest ?? doc);
          },
          catch: (e) =>
            new DeployFailed({
              message: e instanceof ManifestError || e instanceof Error ? e.message : String(e),
            }),
        });
        if (manifest.name !== app)
          return yield* new DeployFailed({
            message: `plat.config.ts name "${manifest.name}" does not match app "${app}"`,
          });
        const located = yield* findArtifacts(ref);
        if (manifest.web?.server && !located.server)
          return yield* new DeployFailed({
            message: 'manifest declares web.server but server.zip was not uploaded',
          });
        if (manifest.worker && !located.worker)
          return yield* new DeployFailed({
            message: 'manifest needs a worker but worker.zip was not uploaded',
          });
        if (Object.keys(manifest.services).length > 0 && !located.services)
          return yield* new DeployFailed({
            message: 'manifest declares services but services.zip was not uploaded',
          });
        // The API checked the manifest it was sent; manifest.json is uploaded separately.
        const overLimit = servicesLimitIssue(settings.platform, manifest);
        if (overLimit) return yield* new DeployFailed({ message: overLimit });

        const previous = Option.getOrUndefined(before);
        const previousCompute = previous ? stageCompute(previous) : undefined;
        // A switch runs in the mode the chooser picked; any other deployment in the one its
        // setting, stage and SDK give (prod on `auto` keeps the stage's).
        const choice =
          dep.computeSwitchOf && dep.compute
            ? { compute: dep.compute }
            : webComputeFor({
                setting: manifest.web?.compute ?? 'auto',
                stage,
                current: previousCompute,
                sdk: dep.sdk,
                accountConcurrency: yield* Effect.provideService(accountConcurrency, Aws, aws),
              });
        if ('error' in choice) return yield* new DeployFailed({ message: choice.error });
        if (manifest.web?.server) {
          push({ level: 'info', msg: `the server runs in ${choice.compute} mode` });
          if ('note' in choice && choice.note) push({ level: 'warn', msg: choice.note });
        }

        const result = yield* engine.deploy(
          {
            manifest,
            stage,
            deploymentId: id,
            platform,
            artifacts: located,
            webMode: 'function',
            webCompute: choice.compute,
            servicesMode: 'ecs',
            logRetentionDays: logRetentionDays(settings.platform, stage),
          },
          push,
        );
        for (const service of result.services ?? []) push(deployedServiceEvent(app, stage, service));

        yield* store.updateStage(app, stage, {
          status: 'active',
          host: result.host,
          url: result.url,
          currentDeployment: id,
          previousDeployment: previous?.currentDeployment,
          currentRevision: serverBuild(result),
          previousRevision: previous?.currentRevision,
          compute: result.compute,
          // The count toward a switch starts over in a new mode.
          ...(result.compute !== previousCompute ? { computeStreak: undefined } : {}),
          route: result.route,
          previousRoute: previous?.route,
        });
        // A stage without a server gets its health answered by the edge router, from the route.
        if (result.route) {
          push({ level: 'info', msg: 'waiting for the edge to serve this deployment' });
          const served = yield* waitForEdge(result.url, id).pipe(
            Effect.provideService(HttpClient.HttpClient, http),
          );
          push(
            served
              ? { level: 'info', msg: 'edge is serving this deployment' }
              : {
                  level: 'warn',
                  msg: `the edge was not serving this deployment after ${EDGE_TIMEOUT_SECONDS}s; it should catch up shortly`,
                },
          );
        }
        push({ level: 'info', msg: `live at ${result.url}` });
        return { result, manifest } satisfies { result: DeployStageResult; manifest: ResolvedManifest };
      });

      const run = Effect.fn('Deployer.run')(
        function* (id: string) {
          const found = yield* store.getDeployment(id);
          if (Option.isNone(found)) {
            yield* Effect.logWarning('deploy job for unknown deployment');
            return;
          }
          const { app, stage, status } = found.value;
          // Idempotent under Lambda async retries: only one run moves it out of `queued`.
          const claimed = yield* store.updateDeployment(
            app,
            id,
            { status: 'running', startedAt: yield* nowIso },
            'queued',
          );
          if (!claimed) {
            yield* Effect.logInfo('deployment already handled').pipe(Effect.annotateLogs({ status }));
            return;
          }
          const before = yield* store.getStage(app, stage);

          // The event log is complete before the status is final: the CLI stops
          // reading events once the deployment succeeded or failed.
          const outcome = yield* Effect.scoped(
            Effect.gen(function* () {
              const push = yield* progress({ app, id });
              const exit = yield* Effect.exit(deployStage(found.value, before, push));
              if (Exit.isFailure(exit)) push({ level: 'error', msg: failureMessage(exit.cause) });
              return exit;
            }),
          );

          if (Exit.isSuccess(outcome)) {
            const { result, manifest } = outcome.value;
            // The stage already serves this deployment. If this write failed, the job's
            // retry would find it `running` and stop, leaving a live deployment that
            // never succeeds; so ride out throttling here.
            yield* store
              .updateDeployment(app, id, {
                status: 'succeeded',
                finishedAt: yield* nowIso,
                url: result.url,
                manifest,
                route: result.route,
                compute: result.compute,
                revisionId: result.webFunction?.revisionId,
                version: result.requestFunction?.version,
              })
              .pipe(
                Effect.catchDefect(Effect.fail),
                Effect.retry({ schedule: Schedule.exponential('200 millis'), times: 6 }),
                Effect.orDie,
              );
            return;
          }
          yield* Effect.logError('deployment failed', outcome.cause);
          yield* store.updateDeployment(app, id, {
            status: 'failed',
            finishedAt: yield* nowIso,
            error: failureMessage(outcome.cause),
          });
          // The previous deployment (if any) is still live: failures never flip the route.
          const live = Option.isSome(before) && before.value.currentDeployment !== undefined;
          yield* store.updateStage(app, stage, { status: live ? 'active' : 'failed' });
        },
        (effect, id) => Effect.annotateLogs(effect, { deployment: id }),
      );

      const destroy = Effect.fn('Deployer.destroy')(
        function* (app: string, stage: string) {
          const platform = yield* settings.runtime;
          const destroyed = yield* Effect.scoped(
            Effect.gen(function* () {
              const push = yield* progress();
              return yield* Effect.exit(
                engine.destroy({ app, stage, platform, keepData: stage === 'prod' }, push),
              );
            }),
          );
          if (Exit.isFailure(destroyed)) {
            yield* Effect.logError('destroy failed', destroyed.cause);
            yield* store.updateStage(app, stage, { status: 'failed' });
            return yield* Effect.failCause(destroyed.cause);
          }
          return yield* store
            .updateStage(app, stage, { status: 'destroyed', route: undefined, previousRoute: undefined })
            .pipe(Effect.asVoid);
        },
        (effect, app, stage) => Effect.annotateLogs(effect, { app, stage }),
      );

      const refuse = (message: string) => Effect.fail(new RollbackRefused({ message }));

      const rollback = Effect.fn('Deployer.rollback')(function* (
        app: string,
        stage: string,
        toDeployment?: string,
      ) {
        const current = Option.getOrUndefined(yield* store.getStage(app, stage));
        if (!current?.currentDeployment) return yield* refuse(`${app}/${stage} has no live deployment`);
        const targetId = toDeployment ?? current.previousDeployment;
        if (!targetId) return yield* refuse(`${app}/${stage} has no previous deployment to roll back to`);
        if (targetId === current.currentDeployment) return yield* refuse(`${targetId} is already live`);
        const target = Option.getOrUndefined(yield* store.getDeployment(targetId));
        if (!target || target.app !== app || target.stage !== stage)
          return yield* refuse(`deployment ${targetId} is not part of ${app}/${stage}`);
        if (!target.route)
          return yield* refuse(`deployment ${targetId} has no recorded route (it never went live)`);

        const platform = yield* settings.runtime;
        const route = yield* engine
          .rollback({
            app,
            stage,
            platform,
            route: target.route,
            ...(target.revisionId ? { revisionId: target.revisionId } : {}),
            ...(target.version ? { version: target.version } : {}),
            services: Object.keys(target.manifest?.services ?? {}),
          })
          .pipe(Effect.catchTag('DeployFailed', (e) => refuse(e.message)));
        // Rolling back restores the target's mode too.
        const compute = stageCompute(target);
        yield* store.updateStage(app, stage, {
          status: 'active',
          currentDeployment: targetId,
          previousDeployment: current.currentDeployment,
          currentRevision: target.revisionId ?? target.version,
          previousRevision: current.currentRevision,
          compute,
          ...(compute !== stageCompute(current) ? { computeStreak: undefined } : {}),
          route,
          previousRoute: current.route,
          ...(target.url ? { url: target.url } : {}),
        });
        yield* store.updateDeployment(app, current.currentDeployment, { status: 'rolled_back' });
        return { currentDeployment: targetId, url: target.url ?? current.url };
      });

      return Deployer.of({ run, destroy, rollback });
    }),
  );
}
