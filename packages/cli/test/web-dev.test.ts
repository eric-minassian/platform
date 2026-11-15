import type { ChildProcess } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { killTree } from '../src/dev/proc.ts';
import { startWebDev, webDevPort } from '../src/dev/web-dev.ts';
import { freePort, portFree } from '../src/util/net.ts';
import { tempDir } from './helpers.ts';

const open: Server[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const c of children.splice(0)) killTree(c);
  await Promise.all(open.splice(0).map((s) => new Promise((done) => s.close(done))));
});

/** Listens on host:port (0 = any); undefined when the host has no such address. */
function hold(port: number, host: string): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', (err: NodeJS.ErrnoException) =>
      err.code === 'EADDRNOTAVAIL' || err.code === 'EAFNOSUPPORT' ? resolve(undefined) : reject(err),
    );
    srv.listen(port, host, () => {
      open.push(srv);
      const addr = srv.address();
      resolve(typeof addr === 'object' && addr ? addr.port : undefined);
    });
  });
}

describe('portFree', () => {
  it('sees a port taken on either loopback address', async () => {
    const v4 = (await hold(0, '127.0.0.1'))!;
    expect(await portFree(v4)).toBe(false);

    // A dev server bound to `localhost` often holds ::1 alone.
    const v6 = await hold(0, '::1');
    if (v6 !== undefined) expect(await portFree(v6)).toBe(false);

    const port = await freePort();
    expect(await portFree(port)).toBe(true);
  });
});

describe('webDevPort', () => {
  it('uses web.dev.port when free, any free port when not', async () => {
    const preferred = await freePort();
    expect(await webDevPort(preferred)).toBe(preferred);

    await hold(preferred, '127.0.0.1');
    const other = await webDevPort(preferred);
    expect(other).not.toBe(preferred);
    expect(await portFree(other)).toBe(true);

    expect(await webDevPort()).toBeGreaterThan(0);
  });
});

describe('startWebDev', () => {
  // Reports the env `plat dev` gave it, on the port it was told to use.
  const devServer = `
    import { createServer } from 'node:http';
    const { PORT, PLATFORM_DEV_WEB_PORT, PLATFORM_DEV_ROUTER } = process.env;
    createServer((_req, res) => res.end(JSON.stringify({ PORT, PLATFORM_DEV_WEB_PORT, PLATFORM_DEV_ROUTER })))
      .listen(Number(PLATFORM_DEV_WEB_PORT), 'localhost');
  `;

  it('runs two apps side by side with the same web.dev.port', async () => {
    const preferred = await freePort();
    const apps = [tempDir(), tempDir()];
    for (const root of apps) writeFileSync(join(root, 'dev.mjs'), devServer);

    const devs = [];
    for (const [i, root] of apps.entries()) {
      const dev = await startWebDev(root, { command: 'node dev.mjs', port: preferred }, 3100 + i);
      children.push(dev.child);
      // The second starts while the first holds the port.
      await dev.ready;
      devs.push(dev);
    }

    expect(devs[0]!.port).toBe(preferred);
    expect(devs[1]!.port).not.toBe(preferred);
    for (const [i, dev] of devs.entries()) {
      const env = await (await fetch(`http://localhost:${dev.port}/`)).json();
      expect(env).toEqual({
        PORT: String(dev.port),
        PLATFORM_DEV_WEB_PORT: String(dev.port),
        PLATFORM_DEV_ROUTER: `http://localhost:${3100 + i}`,
      });
    }
  });

  it('fails fast when the command exits before listening', async () => {
    const dev = await startWebDev(tempDir(), { command: 'exit 3' }, 3000);
    children.push(dev.child);
    await expect(dev.ready).rejects.toThrow(`it exited (code 3) before listening on port ${dev.port}`);
  });
});
