import { type ChildProcess, spawn } from 'node:child_process';
import type { ResolvedManifest } from '@ericminassian/platform-core';
import { withLocalBin } from '../build.ts';
import { freePort, portFree, waitForPort } from '../util/net.ts';

type WebDevConfig = NonNullable<NonNullable<ResolvedManifest['web']>['dev']>;

export interface WebDev {
  child: ChildProcess;
  /** The port `web.dev.command` was told to listen on. */
  port: number;
  /** Resolves once the dev server accepts connections on `port`. */
  ready: Promise<void>;
}

/**
 * The port for the frontend dev server: `web.dev.port` when it is free, else
 * any free port. Several `plat dev` sessions run side by side on one machine,
 * and a taken preferred port must not be reused, or the router would proxy
 * to another app's dev server.
 */
export async function webDevPort(preferred?: number): Promise<number> {
  return preferred && (await portFree(preferred)) ? preferred : freePort();
}

/**
 * Runs `web.dev.command` and tells it which port to listen on:
 * `PLATFORM_DEV_WEB_PORT` for configs and commands (`--port $PLATFORM_DEV_WEB_PORT`),
 * and `PORT` for dev servers that read it themselves.
 */
export async function startWebDev(root: string, dev: WebDevConfig, routerPort: number): Promise<WebDev> {
  const port = await webDevPort(dev.port);
  const child = spawn(dev.command, {
    cwd: root,
    shell: true,
    detached: true,
    env: withLocalBin(root, {
      ...process.env,
      PLATFORM_DEV_ROUTER: `http://localhost:${routerPort}`,
      PLATFORM_DEV_WEB_PORT: String(port),
      PORT: String(port),
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = new AbortController();
  child.once('exit', () => exited.abort());
  // Dev servers often bind `localhost` (::1 on many systems); connect the same way.
  const ready = waitForPort(port, 'localhost', 60_000, exited.signal).catch((err: unknown) => {
    // An early exit explains itself in the command's output; a timeout usually
    // means the server ignored the port and is listening somewhere else.
    throw new Error(
      exited.signal.aborted
        ? `it exited (${child.signalCode ?? `code ${child.exitCode}`}) before listening on port ${port}`
        : `${(err as Error).message}; web.dev.command must listen on $PLATFORM_DEV_WEB_PORT`,
    );
  });
  return { child, port, ready };
}
