import { existsSync, readFileSync } from 'node:fs';
import { Agent } from 'node:https';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { PutParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import {
  type Bindings,
  encodeBindings,
  names,
  newDeploymentId,
  type PlatformRuntimeConfig,
  type ResolvedManifest,
} from '@ericminassian/platform-core';
import {
  createEngine,
  type DeployStageResult,
  type EmulatorConnection,
  type Engine,
  type EngineLogEntry,
  emulatorChildEnv,
  engineContext,
  ensureLocalPlatform,
  errorName,
  type S3Location,
  startEmulator,
} from '@ericminassian/platform-engine';
import { bundleWorker, zipBundle } from '../build.ts';
import { CliError } from '../util/output.ts';
import { type LocalRealtime, localRealtime, type PublicFiles, type StoredFile } from './router.ts';

/**
 * A stage running inside a private AWS Emulator: shared platform resources
 * (`ensureLocalPlatform`) plus this app's resources, created by the same
 * engine that deploys to AWS. The web server runs outside the emulator
 * (`webMode: 'external'`) because the emulator doesn't serve Web Function
 * endpoints yet, and so do long-running services (`servicesMode:
 * 'external'`): `plat dev` runs them as local processes, `plat test` not at all.
 */
export interface LocalStage {
  conn: EmulatorConnection;
  engine: Engine;
  platform: PlatformRuntimeConfig;
  result: DeployStageResult;
  bindings: Bindings;
  deploymentId: string;
  stage: string;
  /** Present when the manifest declares `realtime`: what the local router serves for it. */
  realtime?: LocalRealtime;
  /** Present when the manifest has public stores: their files in the emulator, for the local router. */
  publicFiles?: PublicFiles;
  stop(): Promise<void>;
}

export interface StartLocalStageOptions {
  root: string;
  manifest: ResolvedManifest;
  stage: 'local' | 'test';
  /** Public port of the local router (used in URLs, auth redirects). */
  port: number;
  log?: (e: EngineLogEntry) => void;
  onEmulatorLog?: (line: string) => void;
}

export async function startLocalStage(opts: StartLocalStageOptions): Promise<LocalStage> {
  const conn = await startEmulator({ port: 0, idleTimeoutSeconds: 6 * 3600, onLog: opts.onEmulatorLog });
  try {
    const engine = createEngine({
      region: conn.region,
      emulator: { endpoint: conn.endpoint, caFile: conn.caFile, credentials: conn.credentials },
      log: opts.log,
    });
    const platform = await ensureLocalPlatform(engine, { port: opts.port, jwksBaseUrl: conn.endpoint });
    const deploymentId = newDeploymentId();
    const worker = opts.manifest.worker
      ? await uploadWorker(engine, platform, opts.root, opts.manifest, opts.stage, deploymentId)
      : undefined;
    const result = await engine.deployStage({
      manifest: opts.manifest,
      stage: opts.stage,
      deploymentId,
      platform,
      artifacts: worker ? { worker } : {},
      webMode: 'external',
      servicesMode: 'external',
      logRetentionDays: 1,
    });
    await seedSecrets(conn, result.bindings, opts.root);
    const realtime = await setUpRealtime(engine, platform, opts.manifest, result.bindings);
    return {
      conn,
      engine,
      platform,
      result,
      bindings: result.bindings,
      deploymentId,
      stage: opts.stage,
      ...(realtime ? { realtime } : {}),
      ...(result.bindings.storage?.public?.length
        ? { publicFiles: emulatorFiles(engine, result.bindings.storage.bucket) }
        : {}),
      stop: () => conn.stop(),
    };
  } catch (err) {
    await conn.stop();
    throw err;
  }
}

/**
 * The realtime the local router serves: the emulator's Event API (with its
 * subscribe key) as the edge would read it from the route store, and the
 * stage's namespace from its bindings.
 */
async function setUpRealtime(
  engine: Engine,
  platform: PlatformRuntimeConfig,
  manifest: ResolvedManifest,
  bindings: Bindings,
): Promise<LocalRealtime | undefined> {
  if (!manifest.realtime) return undefined;
  const entry = await engine.ensureRealtimePlatform(platform);
  if (!entry || !bindings.realtime) {
    throw new CliError('the AWS Emulator has no Event API for realtime', {
      hint: 'upgrade @ericminassian/plat and the AWS Emulator',
    });
  }
  return localRealtime(entry, {
    namespace: bindings.realtime.namespace,
    subscribe: bindings.realtime.subscribe,
  });
}

/** Public stores' files from the emulator's S3, as the edge reads them from the storage bucket. */
function emulatorFiles(engine: Engine, bucket: string): PublicFiles {
  const s3 = engineContext(engine).clients.s3;
  return async (key, { range, ifNoneMatch }) => {
    try {
      const out = await s3.send(
        new GetObjectCommand({
          Bucket: bucket,
          Key: key,
          ...(range ? { Range: range } : {}),
          ...(ifNoneMatch ? { IfNoneMatch: ifNoneMatch } : {}),
        }),
      );
      const file: StoredFile = {
        status: out.ContentRange ? 206 : 200,
        headers: {
          ...(out.ContentType ? { contentType: out.ContentType } : {}),
          ...(out.CacheControl ? { cacheControl: out.CacheControl } : {}),
          ...(out.ContentLength !== undefined ? { contentLength: out.ContentLength } : {}),
          ...(out.ContentRange ? { contentRange: out.ContentRange } : {}),
          ...(out.ETag ? { etag: out.ETag } : {}),
          ...(out.LastModified ? { lastModified: out.LastModified } : {}),
        },
      };
      return out.Body instanceof Readable ? { ...file, body: out.Body } : file;
    } catch (e) {
      const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 304) return { status: 304, headers: {} };
      if (status === 404 || errorName(e) === 'NoSuchKey') return undefined;
      throw e;
    }
  };
}

export async function uploadWorker(
  engine: Engine,
  platform: PlatformRuntimeConfig,
  root: string,
  manifest: ResolvedManifest,
  stage: string,
  deploymentId: string,
): Promise<S3Location> {
  const dir = await bundleWorker(root, manifest, join(root, '.plat', stage, 'worker'), { minify: false });
  const zip = zipBundle(dir);
  return engine.putArtifact(
    platform,
    names.artifactKey(manifest.name, stage, deploymentId, 'worker.zip'),
    zip,
  );
}

/** Environment for the local web server, worker tests and `plat test`. */
export function localEnv(
  stage: LocalStage,
  manifest: ResolvedManifest,
  extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
  return {
    ...emulatorChildEnv(stage.conn),
    ...manifest.env,
    PLATFORM_BINDINGS: encodeBindings(stage.bindings),
    PLATFORM_LOCAL: '1',
    ...extra,
  };
}

/** AWS SDK client config for talking to the emulator from the CLI process itself. */
export function emulatorClientConfig(conn: EmulatorConnection) {
  return {
    region: conn.region,
    endpoint: conn.endpoint,
    credentials: conn.credentials,
    requestHandler: { httpsAgent: new Agent({ ca: readFileSync(conn.caFile), keepAlive: true }) },
  };
}

/**
 * `.env.local` (KEY=VALUE, not committed) → SecureString parameters, so
 * `secrets.get()` works locally exactly as deployed. Only names declared in
 * plat.config.ts are loaded.
 */
async function seedSecrets(conn: EmulatorConnection, bindings: Bindings, root: string): Promise<void> {
  const values = readDotEnv(join(root, '.env.local'));
  const declared = new Set(bindings.secrets.names);
  const entries = Object.entries(values).filter(([k]) => declared.has(k));
  if (entries.length === 0) return;
  const ssm = new SSMClient(emulatorClientConfig(conn));
  try {
    for (const [name, value] of entries) {
      await ssm.send(
        new PutParameterCommand({
          Name: `${bindings.secrets.path}${name}`,
          Value: value,
          Type: 'SecureString',
          Overwrite: true,
        }),
      );
    }
  } catch (err) {
    throw new CliError(`could not load .env.local secrets into the emulator: ${(err as Error).message}`);
  } finally {
    ssm.destroy();
  }
}

export function readDotEnv(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2]!;
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]!] = v;
  }
  return out;
}
