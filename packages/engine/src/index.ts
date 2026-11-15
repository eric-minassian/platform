/**
 * @ericminassian/platform-engine — provisions and deploys platform stages
 * with direct AWS SDK calls. No CloudFormation, no state file: resources have
 * deterministic names (`names` in core) and `platform:*` tags, so the engine
 * can always rediscover what it owns. Every driver is idempotent ("ensure").
 *
 * The same engine runs in three places:
 *  - the control plane's deployer (real AWS),
 *  - `plat dev` / `plat test` (AWS Emulator, `webMode: 'external'`),
 *  - `foundation/` (the platform's own shared resources).
 *
 * CONTRACT: the exported names and types below are used by the CLI, the
 * control plane and the foundation. Keep them stable.
 */

import { GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import type {
  Bindings,
  PlatformRuntimeConfig,
  ResolvedManifest,
  RouteRecord,
} from '@ericminassian/platform-core';
import { createClients } from './clients.ts';
import { putObject } from './drivers/s3.ts';
import { ensureLocal } from './local.ts';
import { deployStage, destroyStage, listStageResources, rollbackStage } from './stage.ts';
import type { EngineContext } from './util.ts';

export type { AwsClients } from './clients.ts';
export * from './drivers/index.ts';
export * from './emulator.ts';
export * as policies from './policy.ts';
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
  /** Uploaded build artifacts (zips) in the artifacts bucket. */
  artifacts: { server?: S3Location; worker?: S3Location; static?: S3Location };
  /**
   * `function`: create/update the Lambda Web Function + route record (AWS).
   * `external`: skip both; `plat dev` runs the server process itself because
   * the emulator does not serve Web Function endpoints yet.
   */
  webMode?: 'function' | 'external';
  /** Use this role instead of creating the per-stage role (the control plane runs privileged). */
  roleArn?: string;
  /** Extra environment variables for web + worker (merged over manifest `env`). */
  extraEnv?: Record<string, string>;
  logRetentionDays?: number;
}

export interface ResourceRef {
  /** `role`, `table`, `queue`, `bus`, `rule`, `schedule-group`, `schedule`, `log-group`, `web-function`, `function`, `esm`, `user-pool-client`, `route`, `static` */
  type: string;
  name: string;
  arn?: string;
}

export interface DeployStageResult {
  bindings: Bindings;
  host: string;
  url: string;
  route?: RouteRecord;
  webFunction?: { name: string; endpointDomain: string; revisionId: string };
  workerFunction?: { name: string; arn: string };
  resources: ResourceRef[];
}

export interface RollbackStageInput {
  app: string;
  stage: string;
  platform: PlatformRuntimeConfig;
  /** Route record of the deployment to go back to (its static prefix + endpoint). */
  route: RouteRecord;
  /** Web Function revision to route 100% of traffic to. */
  revisionId?: string;
}

export interface DestroyStageInput {
  app: string;
  stage: string;
  platform: PlatformRuntimeConfig;
  /** Keep the table and storage objects (default false; prod should pass true). */
  keepData?: boolean;
}

export interface Engine {
  readonly region: string;
  readonly target: 'aws' | 'emulator';
  accountId(): Promise<string>;
  deployStage(input: DeployStageInput): Promise<DeployStageResult>;
  rollbackStage(input: RollbackStageInput): Promise<void>;
  destroyStage(input: DestroyStageInput): Promise<void>;
  /** Everything the engine owns for a stage (found by name + tags). */
  listStageResources(app: string, stage: string): Promise<ResourceRef[]>;
  /** Upload a local file/buffer into the artifacts bucket (used by `plat dev`). */
  putArtifact(platform: PlatformRuntimeConfig, key: string, body: Uint8Array): Promise<S3Location>;
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
    listStageResources: (app, stage) => listStageResources(ctx, app, stage),
    putArtifact: (platform, key, body) => putObject(ctx, { bucket: platform.artifactsBucket, key, body }),
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
 * user pool) and the matching runtime config (`target: 'emulator'`).
 */
export async function ensureLocalPlatform(
  engine: Engine,
  opts: { domain?: string; port: number; jwksBaseUrl: string },
): Promise<PlatformRuntimeConfig> {
  return ensureLocal(engineContext(engine), opts);
}
