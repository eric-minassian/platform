/**
 * @ericminassian/platform-engine — provisions and deploys platform stages
 * with direct AWS SDK calls. No CloudFormation, no state file: resources have
 * deterministic names (`names` in core) and `platform:*` tags, so the engine
 * can always rediscover what it owns. Every driver is idempotent ("ensure").
 *
 * The same engine runs in three places:
 *  - the control plane's deployer (real AWS),
 *  - `plat dev` / `plat test` (AWS Emulator, `webMode: 'external'`),
 *  - `foundation/`, which deploys the control plane itself (the platform's
 *    shared resources around it are a CDK stack, not engine resources).
 *
 * CONTRACT: the exported names and types below are used by the CLI, the
 * control plane and the foundation. Keep them stable.
 */

import { GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import type {
  Bindings,
  PlatformRuntimeConfig,
  RealtimeEdgeEntry,
  ResolvedManifest,
  RouteRecord,
  WebCompute,
} from '@ericminassian/platform-core';
import { createClients } from './clients.ts';
import { ensureRealtimePlatform } from './drivers/appsync.ts';
import { putObject } from './drivers/s3.ts';
import { ensureLocal } from './local.ts';
import { controlService, describeServices } from './services.ts';
import { deployStage, destroyStage, expireStorage, listStageResources, rollbackStage } from './stage.ts';
import type { EngineContext } from './util.ts';

export type { AwsClients } from './clients.ts';
export * from './drivers/index.ts';
export * from './emulator.ts';
export * as images from './images.ts';
export * as policies from './policy.ts';
export { ServiceNotFoundError } from './services.ts';
export { hostFor } from './stage.ts';
export { cacheControlFor, contentTypeFor } from './static.ts';
export type { EngineContext, PolicyDocument, PolicyStatement } from './util.ts';
export { errorName, isNotFound, isNotImplemented, platformTags, retry, stageTags, waitFor } from './util.ts';

export interface EngineLogEntry {
  level: 'info' | 'warn' | 'error';
  msg: string;
  /** e.g. `table foo--prod`. */
  resource?: string;
}

export interface EngineOptions {
  region: string;
  /** Target the AWS Emulator instead of AWS (endpoint, CA, static credentials + compat shims). */
  emulator?: {
    endpoint: string;
    caFile: string;
    credentials: { accessKeyId: string; secretAccessKey: string };
  };
  /** Explicit credentials; default is the AWS SDK default chain. */
  credentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
  log?: (e: EngineLogEntry) => void;
}

export interface S3Location {
  bucket: string;
  key: string;
  versionId?: string;
}

export interface DeployStageInput {
  manifest: ResolvedManifest;
  stage: string;
  deploymentId: string;
  platform: PlatformRuntimeConfig;
  /**
   * Uploaded build artifacts (zips) in the artifacts bucket. `services` is
   * `services.zip`: `<service>/index.mjs` (+ `.map`) for each declared service.
   */
  artifacts: { server?: S3Location; worker?: S3Location; static?: S3Location; services?: S3Location };
  /**
   * `function`: create/update the Lambda Web Function + route record (AWS).
   * `external`: skip both; `plat dev` runs the server process itself because
   * the emulator does not serve Web Function endpoints yet.
   */
  webMode?: 'function' | 'external';
  /**
   * How the server runs with `webMode: 'function'` (core `webComputeFor`
   * decides it): `instance`, a Lambda Web Function (the default), or
   * `request`, a Lambda function per request behind function URLs. A deploy
   * builds only this one; the stage keeps the other mode's (it costs nothing
   * idle) until the manifest drops `web.server` or the stage is destroyed.
   */
  webCompute?: WebCompute;
  /**
   * `ecs`: build each service's image and run it on ECS (AWS; the default).
   * `external`: skip images and ECS; `plat dev` runs services as local
   * processes. Their log groups are created either way.
   */
  servicesMode?: 'ecs' | 'external';
  /** Use this role instead of creating the per-stage role (the control plane runs privileged). */
  roleArn?: string;
  /** Extra environment variables for web + worker (merged over manifest `env`). */
  extraEnv?: Record<string, string>;
  logRetentionDays?: number;
}

export interface ResourceRef {
  /** `role`, `table`, `queue`, `bus`, `rule`, `schedule-group`, `schedule`, `log-group`, `web-function`, `function` (worker, a handler's own, or the request-mode server), `esm`, `user-pool-client`, `channel-namespace`, `email-tenant`, `configuration-set`, `route`, `static`, `image`, `task-definition`, `ecs-service` */
  type: string;
  name: string;
  arn?: string;
}

export interface DeployStageResult {
  bindings: Bindings;
  host: string;
  url: string;
  route?: RouteRecord;
  /** How the server runs, when the stage has one. */
  compute?: WebCompute;
  /** The server in instance mode. */
  webFunction?: { name: string; endpointDomain: string; revisionId: string };
  /** The server in request mode: the version this deploy published, behind `urlDomain`. */
  requestFunction?: { name: string; urlDomain: string; version: string };
  workerFunction?: { name: string; arn: string };
  /** Services the deploy rolled out (`servicesMode: 'ecs'`). */
  services?: DeployedService[];
  resources: ResourceRef[];
}

export interface DeployedService {
  /** The key in plat.config.ts (`ais`). */
  name: string;
  /** `<repositoryUri>@sha256:…`. */
  image: string;
  taskDefinitionArn: string;
  /** 1 running, 0 when a preview doesn't run it. */
  desired: number;
  /** A preview's stop schedule. */
  stopsAt?: string;
}

export interface RollbackStageInput {
  app: string;
  stage: string;
  platform: PlatformRuntimeConfig;
  /**
   * Route record of the deployment to go back to, in its compute mode. The
   * engine picks the endpoint or function URL (`o`) itself.
   */
  route: RouteRecord;
  /** That deployment's Web Function revision (instance mode). */
  revisionId?: string;
  /** That deployment's function version (request mode). */
  version?: string;
  /**
   * Services that deployment declared. Each one the stage still runs is
   * pointed back at that deployment's build; the rollback is refused if a
   * build was cleaned up since.
   */
  services?: readonly string[];
}

export interface StageServicesInput {
  app: string;
  stage: string;
  platform: PlatformRuntimeConfig;
}

/** One service as ECS reports it right now. */
export interface ServiceRuntimeState {
  name: string;
  desired: number;
  running: number;
  pending: number;
  /** The newest ECS deployment's rollout (`COMPLETED`, `IN_PROGRESS`, `FAILED`). */
  rollout?: 'completed' | 'in_progress' | 'failed';
  /** Deployment whose build the newest ECS deployment runs (its task definition's tag). */
  deploymentId?: string;
  /** When the current task started. */
  startedAt?: string;
  /** When a stop schedule scales it to zero. */
  stopsAt?: string;
  /** The task that stopped most recently. */
  lastStop?: { at: string; reason: string; exitCode?: number };
  /** Recent ECS service events, newest first (at most 10). */
  events: Array<{ at: string; message: string }>;
}

export interface ControlServiceInput extends StageServicesInput {
  name: string;
  /**
   * `start`: desired 1, stopping again after `minutes` when given (replacing
   * any stop schedule). `stop`: desired 0 (and no stop schedule). `restart`:
   * a fresh task on the same build.
   */
  action: 'start' | 'stop' | 'restart';
  minutes?: number;
}

export interface DestroyStageInput {
  app: string;
  stage: string;
  platform: PlatformRuntimeConfig;
  /** Keep the table and storage objects (default false; prod should pass true). */
  keepData?: boolean;
}

export interface ExpireStorageInput {
  app: string;
  stage: string;
  platform: PlatformRuntimeConfig;
  /** The live deployment's: its stores' `expireAfterDays` and where their files are. */
  manifest: Pick<ResolvedManifest, 'storage' | 'storageOptions'>;
  /** Default: the current time. */
  now?: Date;
}

export interface Engine {
  readonly region: string;
  readonly target: 'aws' | 'emulator';
  accountId(): Promise<string>;
  deployStage(input: DeployStageInput): Promise<DeployStageResult>;
  /** Returns the route record it wrote. */
  rollbackStage(input: RollbackStageInput): Promise<RouteRecord>;
  destroyStage(input: DestroyStageInput): Promise<void>;
  /**
   * Delete the files of the stage's stores that set `expireAfterDays` and
   * weren't written for that many days. Answers how many, by store. The
   * control plane runs it daily for every live stage.
   */
  expireStorage(input: ExpireStorageInput): Promise<Record<string, number>>;
  /** Everything the engine owns for a stage (found by name + tags). */
  listStageResources(app: string, stage: string): Promise<ResourceRef[]>;
  /** Upload a local file/buffer into the artifacts bucket (used by `plat dev`). */
  putArtifact(platform: PlatformRuntimeConfig, key: string, body: Uint8Array): Promise<S3Location>;
  /**
   * Keep realtime usable platform-wide: the public subscribe key exists and is far from expiry,
   * and the router's realtime entry is current (written only when the platform has a route
   * store). Returns that entry, or undefined when the platform has no realtime API. The control
   * plane runs it nightly; `plat dev` serves the entry from its local router.
   */
  ensureRealtimePlatform(platform: PlatformRuntimeConfig): Promise<RealtimeEdgeEntry | undefined>;
  /** The stage's long-running services as ECS runs them now (none without container compute). */
  describeServices(input: StageServicesInput): Promise<ServiceRuntimeState[]>;
  /** Start, stop or restart one of the stage's services. */
  controlService(input: ControlServiceInput): Promise<{ desired: number; stopsAt?: string }>;
}

export function createEngine(opts: EngineOptions): Engine {
  const ctx = createContext(opts);
  const engine: Engine = {
    region: opts.region,
    target: ctx.target,
    accountId: () => ctx.accountId(),
    deployStage: (input) => deployStage(ctx, input),
    rollbackStage: (input) => rollbackStage(ctx, input),
    destroyStage: (input) => destroyStage(ctx, input),
    expireStorage: (input) => expireStorage(ctx, input),
    listStageResources: (app, stage) => listStageResources(ctx, app, stage),
    putArtifact: (platform, key, body) => putObject(ctx, { bucket: platform.artifactsBucket, key, body }),
    ensureRealtimePlatform: (platform) => ensureRealtimePlatform(ctx, platform),
    describeServices: (input) => describeServices(ctx, input),
    controlService: (input) => controlService(ctx, input),
  };
  contexts.set(engine, ctx);
  return engine;
}

const contexts = new WeakMap<Engine, EngineContext>();

/** Driver-level access (clients, logger) for advanced callers such as `foundation/`. */
export function engineContext(engine: Engine): EngineContext {
  const ctx = contexts.get(engine);
  if (!ctx) throw new Error('not an engine created by createEngine');
  return ctx;
}

function createContext(opts: EngineOptions): EngineContext {
  const clients = createClients(opts);
  const target = opts.emulator ? 'emulator' : 'aws';
  let account: Promise<string> | undefined;
  return {
    clients,
    region: opts.region,
    target,
    log: (level, msg, resource) => opts.log?.({ level, msg, ...(resource ? { resource } : {}) }),
    accountId: () => {
      account ??= clients.sts.send(new GetCallerIdentityCommand({})).then((r) => r.Account!);
      return account;
    },
  };
}

/**
 * Shared resources `plat dev` needs inside a fresh emulator (buckets, tables,
 * user pool, realtime API, mail domain) and the matching runtime config
 * (`target: 'emulator'`).
 */
export async function ensureLocalPlatform(
  engine: Engine,
  opts: { domain?: string; port: number; jwksBaseUrl: string },
): Promise<PlatformRuntimeConfig> {
  return ensureLocal(engineContext(engine), opts);
}
