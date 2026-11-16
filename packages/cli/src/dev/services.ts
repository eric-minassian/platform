import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { type ResolvedManifest, SERVICE_ENV } from '@ericminassian/platform-core';
import pc from 'picocolors';
import { SDK_SERVICE } from '../build.ts';
import { resolveFromApp } from '../project.ts';
import { tsxArgs } from './entries.ts';
import { type LocalStage, localEnv } from './local-stage.ts';
import { prefixer } from './pretty.ts';
import { killTree } from './proc.ts';

/**
 * Long-running services under `plat dev`: one process per service running
 * service-host.ts (the SDK's runService, as in the container) under
 * `tsx watch`, so edits restart it. When the service exits by itself (a crash,
 * or a layer that can't be built) tsx watch waits for an edit, so this starts
 * it again after a backoff, as ECS replaces a container that stops.
 */
export interface SpawnedService {
  child: ChildProcess;
  /** Prefix of the lines service-host.ts writes when the service starts and when it fails (`<token> exit <code>`). */
  token: string;
}

/** One service process with the stage's bindings, `PLATFORM_SERVICE` and pretty logs. */
export function spawnService(
  stage: LocalStage,
  manifest: ResolvedManifest,
  root: string,
  name: string,
  opts: { watch?: boolean; workerUrl?: string; env?: Record<string, string> } = {},
): SpawnedService {
  const service = manifest.services[name];
  if (!service) throw new Error(`manifest has no service ${name}`);
  const token = `__plat_dev_service_${randomUUID().replaceAll('-', '')}`;
  const env = localEnv(stage, manifest, {
    [SERVICE_ENV]: name,
    PLATFORM_SERVICE_ENTRY: resolve(root, service.entry),
    PLATFORM_SDK_SERVICE: resolveFromApp(root, SDK_SERVICE),
    PLATFORM_DEV_SERVICE_TOKEN: token,
    PLATFORM_LOG_PRETTY: '1',
    // Queue sends and `Jobs.invoke` locally: the SDK posts to the dispatcher instead of invoking the
    // emulator's sandboxed Lambda.
    ...(opts.workerUrl ? { PLATFORM_LOCAL_WORKER_URL: opts.workerUrl } : {}),
    ...opts.env,
  });
  const child = spawn(process.execPath, tsxArgs('service-host', opts.watch !== false), {
    cwd: root,
    env,
    detached: true,
    // tsx watch reruns its script on any input, which is how a restart is asked for.
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return { child, token };
}

export interface DevService {
  name: string;
  /** SIGTERM; resolves once it exited (tsx watch gives it 5 s), so its finalizers still reach the emulator. */
  stop(): Promise<void>;
}

/** Restarts of a service that exits by itself: 1 s doubling to 30 s, from 1 s again once it ran a minute. */
export const DEV_RESTART_BACKOFF = { initialMs: 1_000, maxMs: 30_000, resetAfterMs: 60_000 };

/**
 * When to restart a service process. `started` when one starts (`ours` when
 * it is a restart this asked for, not one tsx watch made for an edit);
 * `exited` when it fails, returning how long to wait before restarting it.
 */
export function restartBackoff(opts = DEV_RESTART_BACKOFF) {
  let delay = opts.initialMs;
  let startedAt = 0;
  return {
    started(now: number, ours: boolean): void {
      // An edit restarted it, maybe with the fix: no reason to keep waiting longer.
      if (!ours) delay = opts.initialMs;
      startedAt = now;
    },
    exited(now: number): number {
      if (now - startedAt >= opts.resetAfterMs) delay = opts.initialMs;
      const wait = delay;
      delay = Math.min(delay * 2, opts.maxMs);
      return wait;
    },
  };
}

/**
 * Splits a service's stdout into lines, taking out service-host.ts's own
 * (`<token> start`, `<token> exit <code>`) and passing the rest on.
 */
export function serviceOutput(
  token: string,
  on: { line(text: string): void; started(): void; exited(code: number): void },
): (chunk: Buffer | string) => void {
  let buf = '';
  return (chunk) => {
    buf += chunk.toString();
    let idx = buf.indexOf('\n');
    while (idx !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line === `${token} start`) on.started();
      else if (line.startsWith(`${token} exit `)) on.exited(Number(line.slice(token.length + 6)));
      else on.line(line);
      idx = buf.indexOf('\n');
    }
  };
}

/** Runs one service under `tsx watch` for `plat dev`, restarting it when it fails. */
export function startDevService(
  stage: LocalStage,
  manifest: ResolvedManifest,
  root: string,
  name: string,
  opts: {
    workerUrl?: string;
    spans?: boolean;
    write: (s: string) => void;
    warn: (msg: string) => void;
    backoff?: typeof DEV_RESTART_BACKOFF;
  },
): DevService {
  const { child, token } = spawnService(
    stage,
    manifest,
    root,
    name,
    opts.workerUrl ? { workerUrl: opts.workerUrl } : {},
  );
  const label = pc.magenta(`${name.padEnd(6)}│`);
  const out = prefixer(label, opts.write, { spans: opts.spans });
  const err = prefixer(label, opts.write, { spans: opts.spans });
  const backoff = restartBackoff(opts.backoff);
  let restart: ReturnType<typeof setTimeout> | undefined;
  let ours = false;
  let stopped = false;

  child.stdout!.on(
    'data',
    serviceOutput(token, {
      line: (text) => {
        // tsx announces the rerun asked for below ("Return key Rerunning..."); `exited` already said so.
        if (!/\[tsx\] return key/i.test(text)) out(`${text}\n`);
      },
      started: () => {
        clearTimeout(restart);
        backoff.started(Date.now(), ours);
        ours = false;
      },
      exited: (code) => {
        if (stopped) return;
        const wait = backoff.exited(Date.now());
        opts.warn(`service ${name} exited with code ${code}; starting it again in ${wait / 1_000}s`);
        clearTimeout(restart);
        restart = setTimeout(() => {
          ours = true;
          child.stdin!.write('\n');
        }, wait);
      },
    }),
  );
  child.stderr!.on('data', err);
  // Writing to a watcher that is gone fails asynchronously; its exit is reported below.
  child.stdin!.on('error', () => {});
  child.once('exit', (code) => {
    clearTimeout(restart);
    if (!stopped) opts.warn(`service ${name} stopped (tsx exited with code ${code})`);
  });

  const exited = new Promise<void>((done) => child.once('exit', () => done()));
  return {
    name,
    stop() {
      stopped = true;
      clearTimeout(restart);
      killTree(child);
      return Promise.race([exited, new Promise<void>((done) => setTimeout(done, 6_000).unref())]);
    },
  };
}
