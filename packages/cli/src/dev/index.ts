import { type ChildProcess, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { resolve } from 'node:path';
import {
  DEV_UPLOAD_PATH,
  DEV_UPLOAD_RELAY_ENV,
  EMAIL_INBOX_PATH,
  LOCAL_MAIL_URL_ENV,
  LOCAL_STAGE,
  type ResolvedManifest,
  publicStores,
} from '@ericminassian/platform-core';
import { EMULATOR_INSTALL_HINT } from '@ericminassian/platform-engine';
import pc from 'picocolors';
import { SDK_SERVER } from '../build.ts';
import { loadProject, resolveFromApp } from '../project.ts';
import { freePort, portFree, waitForPort } from '../util/net.ts';
import { CliError, info, step, success, warn } from '../util/output.ts';
import { type LocalCron, scheduleCrons } from './crons.ts';
import { tsxArgs } from './entries.ts';
import { type LocalStage, localEnv, startLocalStage } from './local-stage.ts';
import { createInbox, localMailUrl } from './mail.ts';
import { formatMail, prefixer } from './pretty.ts';
import { killTree } from './proc.ts';
import { type Interceptor, type LocalRouterState, localRouteRecord, startLocalRouter } from './router.ts';
import { startDevService } from './services.ts';
import { relayUpload } from './upload-relay.ts';
import { startWebDev } from './web-dev.ts';
import { type Dispatcher, startLocalWorker, startWorkerDispatch } from './worker.ts';

export interface DevOptions {
  cwd: string;
  port: number;
  /** Print SDK trace spans too. */
  spans?: boolean;
  /** Run the app's long-running services (default true). */
  services?: boolean;
}

export const DEV_CONTROL_PREFIX = '/__plat_dev/';

/** Environment for `plat dev`'s processes: upload URLs go through the router's relay (see `DEV_UPLOAD_PATH`). */
const DEV_UPLOADS = { [DEV_UPLOAD_RELAY_ENV]: '1' };

/**
 * `plat dev`: the whole app locally against the AWS Emulator.
 *
 *  emulator ← engine (same code as prod; `webMode: 'external'`)
 *  web server (SDK wrapper, tsx watch) ─┐
 *  frontend dev server (web.dev) ───────┼─ local router (core `decide()`)
 *  local sign-in page ──────────────────┤
 *  mail inbox (`Email.send` posts here) ┘
 *  worker (real Node, tsx watch) ← dispatcher (emulator SQS + EventBridge tap + local crons)
 *  services (real Node, tsx watch, restarted when they exit)
 */
export async function runDev(opts: DevOptions): Promise<void> {
  const { root, manifest } = await loadProject(opts.cwd);
  // The router binds last, after the slow emulator start; find out now.
  if (!(await portFree(opts.port))) {
    throw new CliError(`port ${opts.port} is in use`, {
      hint: 'another `plat dev` may be running; pick a free port with --port <port> or PLAT_DEV_PORT',
    });
  }
  const children: ChildProcess[] = [];
  const cleanups: Array<() => void | Promise<void>> = [];
  let stage: LocalStage | undefined;
  let router: Server | undefined;
  let shuttingDown = false;

  const shutdown = async (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    info(pc.dim('\nstopping…'));
    for (const fn of cleanups) await fn();
    for (const c of children) killTree(c);
    router?.close();
    await stage?.stop();
    process.exit(code);
  };
  process.once('SIGINT', () => void shutdown(0));
  process.once('SIGTERM', () => void shutdown(0));

  try {
    step('starting the AWS Emulator');
    stage = await startLocalStage({
      root,
      manifest,
      stage: LOCAL_STAGE,
      port: opts.port,
      log: (e) => {
        if (e.level !== 'info' || process.env.PLAT_DEV_VERBOSE) info(pc.dim(`  engine ${e.level}: ${e.msg}`));
      },
    });
  } catch (err) {
    await stage?.stop();
    if ((err as Error).message === EMULATOR_INSTALL_HINT) {
      throw new CliError('the AWS Emulator is not installed', { hint: EMULATOR_INSTALL_HINT });
    }
    throw err;
  }
  success(`provisioned ${manifest.name} (${stage.result.resources.length} resources) in the emulator`);

  const state: LocalRouterState = {
    record: localRouteRecord({
      app: manifest.name,
      stage: LOCAL_STAGE,
      deploymentId: stage.deploymentId,
      hasServer: !!manifest.web?.server,
      hasStatic: !!(manifest.web?.static || manifest.web?.dev),
      serverRoutes: manifest.web?.serverRoutes ?? ['/api/'],
      spa: manifest.web?.spa ?? true,
      ...(stage.realtime
        ? {
            realtime: {
              namespace: stage.realtime.config.namespace,
              subscribe: stage.realtime.config.subscribe,
            },
          }
        : {}),
      publicStores: publicStores(manifest),
    }),
    ...(manifest.web?.static ? { staticDir: resolve(root, manifest.web.static) } : {}),
    ...(stage.realtime ? { realtime: stage.realtime } : {}),
    ...(stage.publicFiles ? { publicFiles: stage.publicFiles } : {}),
  };

  // ------------------------------------------------------------ mail
  // Nothing is sent locally: the server and worker post each message to the
  // inbox the router serves, and every message gets a line here.
  const inboxUrl = `http://${manifest.name}.localhost:${opts.port}${EMAIL_INBOX_PATH}`;
  const inbox = createInbox({
    app: manifest.name,
    onMessage: (mail) => info(`${pc.cyan('mail  │')} ${formatMail(mail, `${inboxUrl}/${mail.id}`)}`),
  });
  cleanups.push(() => inbox.close());
  const mailUrl = localMailUrl(`http://127.0.0.1:${opts.port}`);

  // ------------------------------------------------------------ worker
  let dispatcher: Dispatcher | undefined;
  if (manifest.worker) {
    // The dispatcher's port first: the worker posts its own retries and sends there.
    const jobsPort = await freePort();
    const worker = await startLocalWorker(stage, manifest, root, {
      mailUrl,
      jobsUrl: `http://127.0.0.1:${jobsPort}/`,
      env: DEV_UPLOADS,
    });
    children.push(worker.child);
    const out = prefixer(pc.yellow('worker│'), (s) => process.stdout.write(s), { spans: opts.spans });
    worker.child.stdout!.on('data', out);
    worker.child.stderr!.on('data', out);
    dispatcher = await startWorkerDispatch(
      stage,
      manifest,
      worker,
      (kind, name, outcome, detail) => {
        if (outcome === 'error') warn(`${kind} ${name} failed${detail ? `: ${detail}` : ''}`);
      },
      { port: jobsPort },
    );
    cleanups.push(() => dispatcher?.stop());
  }
  const workerUrl = dispatcher?.url;

  const runCron = async (name: string) => {
    if (!dispatcher) throw new CliError('this app has no worker');
    if (!manifest.crons[name]) {
      throw new CliError(`no cron named ${name}`, {
        hint: `crons: ${Object.keys(manifest.crons).join(', ') || '(none)'}`,
      });
    }
    info(`${pc.magenta('cron  │')} running ${name}`);
    const r = await dispatcher.runCron(name);
    if (!r.ok) throw new CliError(`cron ${name} failed: ${r.error?.message}`);
  };
  const crons = dispatcher
    ? scheduleCrons(
        Object.entries(manifest.crons).map(([name, c]): LocalCron => ({ name, ...c })),
        (name) => runCron(name).catch((err) => warn((err as Error).message)),
      )
    : undefined;
  if (crons) cleanups.push(() => crons.stop());

  // ------------------------------------------------------------ services
  const runServices = opts.services !== false;
  if (runServices) {
    const services = Object.keys(manifest.services).map((name) =>
      startDevService(stage, manifest, root, name, {
        ...(workerUrl ? { workerUrl } : {}),
        env: DEV_UPLOADS,
        ...(opts.spans ? { spans: true } : {}),
        write: (s) => process.stdout.write(s),
        warn,
      }),
    );
    cleanups.push(async () => void (await Promise.all(services.map((s) => s.stop()))));
  }

  // ------------------------------------------------------------ web server
  if (manifest.web?.server) {
    const { child, port: serverPort } = await spawnWebServer(stage, manifest, root, {
      ...(workerUrl ? { workerUrl } : {}),
      mailUrl,
    });
    children.push(child);
    const out = prefixer(pc.green('web   │'), (s) => process.stdout.write(s), { spans: opts.spans });
    child.stdout!.on('data', out);
    child.stderr!.on('data', out);
    child.once('exit', (code) => {
      if (!shuttingDown) warn(`web server exited (code ${code})`);
    });
    void (async () => {
      try {
        await waitForPort(serverPort, '127.0.0.1', 60_000);
        state.server = { host: '127.0.0.1', port: serverPort };
      } catch (err) {
        warn(`web server did not start: ${(err as Error).message}`);
      }
    })();
  }

  // ------------------------------------------------------------ frontend dev server
  if (manifest.web?.dev) {
    const preferred = manifest.web.dev.port;
    const { child, port, ready } = await startWebDev(root, manifest.web.dev, opts.port);
    children.push(child);
    if (preferred && port !== preferred) {
      info(pc.dim(`  web.dev.port ${preferred} is in use; the frontend dev server gets port ${port}`));
    }
    const out = prefixer(pc.blue('front │'), (s) => process.stdout.write(s));
    child.stdout!.on('data', out);
    child.stderr!.on('data', out);
    child.once('exit', (code) => {
      if (!shuttingDown && state.webDev) warn(`frontend dev server exited (code ${code})`);
    });
    state.webDevStarting = true;
    void (async () => {
      try {
        await ready;
        state.webDev = { host: 'localhost', port };
      } catch (err) {
        if (!shuttingDown) warn(`frontend dev server did not start: ${(err as Error).message}`);
      } finally {
        state.webDevStarting = false;
      }
    })();
  }

  // ------------------------------------------------------------ router
  const emulatorCa = readFileSync(stage.conn.caFile);
  const intercept: Interceptor[] = [
    async (req, res, url) => {
      if (url.pathname !== DEV_UPLOAD_PATH) return false;
      await relayUpload(req, res, url, {
        endpoint: stage.conn.endpoint,
        ca: emulatorCa,
        port: opts.port,
      });
      return true;
    },
    async (req, res, url) => {
      if (!url.pathname.startsWith(DEV_CONTROL_PREFIX)) return false;
      const cron = /^\/__plat_dev\/cron\/([^/]+)$/.exec(url.pathname);
      if (cron && req.method === 'POST') {
        try {
          await runCron(decodeURIComponent(cron[1]!));
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true }));
        } catch (err) {
          res
            .writeHead(400, { 'content-type': 'application/json' })
            .end(JSON.stringify({ error: (err as Error).message }));
        }
        return true;
      }
      if (url.pathname === `${DEV_CONTROL_PREFIX}status`) {
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(
            JSON.stringify({ app: manifest.name, bindings: stage.bindings, emulator: stage.conn.endpoint }),
          );
        return true;
      }
      res.writeHead(404).end();
      return true;
    },
  ];
  // Local sign-in (`/__platform/auth/*`) is served by the SDK's server wrapper in local mode.
  router = await startLocalRouter({
    port: opts.port,
    host: '127.0.0.1',
    state: () => state,
    inbox,
    intercept,
  });

  printBanner(manifest, stage, opts.port, crons, inboxUrl, runServices);
  await new Promise(() => {}); // run until signalled
}

/**
 * The app's server exactly as the Web Function runs it (SDK wrapper, bindings,
 * `AWS_LAMBDA_HTTP_ENDPOINT`), under `tsx watch` so edits restart it.
 */
export async function spawnWebServer(
  stage: LocalStage,
  manifest: ResolvedManifest,
  root: string,
  opts: {
    watch?: boolean;
    workerUrl?: string;
    /** `PLATFORM_LOCAL_MAIL_URL`: the local inbox the SDK posts mail to. */
    mailUrl?: string;
  } = {},
): Promise<{ child: ChildProcess; port: number }> {
  if (!manifest.web?.server) throw new Error('manifest has no web.server');
  const port = await freePort();
  const env = localEnv(stage, manifest, {
    AWS_LAMBDA_HTTP_ENDPOINT: `127.0.0.1:${port}`,
    PLATFORM_LOG_PRETTY: '1',
    ...DEV_UPLOADS,
    PLATFORM_ENTRY: resolve(root, manifest.web.server),
    PLATFORM_SDK_SERVER: resolveFromApp(root, SDK_SERVER),
    // Queue sends and `Jobs.invoke` locally: the SDK posts to the dispatcher instead of invoking the
    // emulator's sandboxed Lambda.
    ...(opts.workerUrl ? { PLATFORM_LOCAL_WORKER_URL: opts.workerUrl } : {}),
    ...(opts.mailUrl ? { [LOCAL_MAIL_URL_ENV]: opts.mailUrl } : {}),
  });
  const child = spawn(process.execPath, tsxArgs('server-entry', opts.watch !== false), {
    cwd: root,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { child, port };
}

function printBanner(
  manifest: ResolvedManifest,
  stage: LocalStage,
  port: number,
  crons: ReturnType<typeof scheduleCrons> | undefined,
  inboxUrl: string,
  runServices: boolean,
): void {
  const b = stage.bindings;
  const lines = [
    '',
    `  ${pc.bold(manifest.name)} ${pc.dim('running locally on the AWS Emulator')}`,
    '',
    `  ${pc.green('➜')} App:       ${pc.underline(`http://${manifest.name}.localhost:${port}`)}  ${pc.dim(`(or http://localhost:${port})`)}`,
    `  ${pc.dim('➜')} Emulator:  ${stage.conn.endpoint}`,
  ];
  if (b.table) lines.push(`  ${pc.dim('➜')} Database:  ${b.table}`);
  const queues = b.jobs?.queues ?? [];
  if (queues.length) lines.push(`  ${pc.dim('➜')} Queues:    ${queues.join(', ')}`);
  if (manifest.events.length) lines.push(`  ${pc.dim('➜')} Events:    ${manifest.events.join(', ')}`);
  if (b.storage) {
    const stores = b.storage.stores.map((s) =>
      b.storage?.public?.includes(s) ? `${s} ${pc.dim('(public)')}` : s,
    );
    lines.push(`  ${pc.dim('➜')} Storage:   ${stores.join(', ')}`);
  }
  if (b.auth) lines.push(`  ${pc.dim('➜')} Auth:      local sign-in at /__platform/auth/login (any email)`);
  if (manifest.realtime) {
    // The emulator never calls the authorizer, so signed-in subscribe tokens aren't checked locally.
    const who =
      manifest.realtime.subscribe === 'signed-in' ? 'signed-in (tokens not checked locally)' : 'public';
    lines.push(`  ${pc.dim('➜')} Realtime:  ${manifest.realtime.channels.join(', ')} ${pc.dim(`· ${who}`)}`);
  }
  if (manifest.email) {
    const from = b.email ? `from ${b.email.from}, ` : '';
    lines.push(`  ${pc.dim('➜')} Mail:      ${pc.underline(inboxUrl)} ${pc.dim(`· ${from}nothing is sent`)}`);
  }
  for (const name of Object.keys(manifest.crons)) {
    const next = crons?.next(name);
    lines.push(
      `  ${pc.dim('➜')} Cron:      ${name} ${pc.dim(`next ${next?.toISOString() ?? '?'} · now: plat dev run-cron ${name}`)}`,
    );
  }
  for (const [name, service] of Object.entries(manifest.services)) {
    lines.push(
      `  ${pc.dim('➜')} Service:   ${name} ${pc.dim(runServices ? `· ${service.entry}` : '· not running (--no-services)')}`,
    );
  }
  lines.push('', pc.dim('  Ctrl+C to stop. Emulator state lives in memory and is discarded on exit.'), '');
  info(lines.join('\n'));
}

/** `plat dev run-cron <name>`: ask a running `plat dev` to fire a cron now. */
export async function runCronOnDev(name: string, port: number): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${port}${DEV_CONTROL_PREFIX}cron/${encodeURIComponent(name)}`, {
      method: 'POST',
    });
  } catch {
    throw new CliError(`no \`plat dev\` running on port ${port}`, {
      hint: 'start it with `plat dev` (or pass --port)',
    });
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new CliError(body.error ?? `HTTP ${res.status}`);
  }
}
