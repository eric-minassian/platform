import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type LocalRouterState,
  localDecision,
  localRouteRecord,
  safeJoin,
  startLocalRouter,
} from '../src/dev/router.ts';
import { tempDir } from './helpers.ts';

const record = localRouteRecord({
  app: 'shop',
  stage: 'local',
  deploymentId: 'd1',
  hasServer: true,
  hasStatic: true,
  serverRoutes: ['/api/'],
  spa: true,
});
const server = { host: '127.0.0.1', port: 1 };
const webDev = { host: '127.0.0.1', port: 2 };

describe('localDecision', () => {
  it('mirrors the edge: api + platform routes to the server, the rest to the frontend', () => {
    const s: LocalRouterState = { record, server, webDev };
    expect(localDecision(s, '/api/todos?x=1')).toEqual({ kind: 'server', target: server });
    expect(localDecision(s, '/__platform/auth/me')).toEqual({ kind: 'server', target: server });
    expect(localDecision(s, '/settings')).toEqual({ kind: 'webdev', target: webDev });
    expect(localDecision(s, '/src/main.tsx')).toEqual({ kind: 'webdev', target: webDev });
  });

  it('serves built files (with SPA fallback) when no dev server runs', () => {
    const s: LocalRouterState = { record, server, staticDir: '/srv/www' };
    expect(localDecision(s, '/assets/app.js')).toEqual({ kind: 'file', path: '/srv/www/assets/app.js' });
    expect(localDecision(s, '/deep/link')).toEqual({ kind: 'file', path: '/srv/www/index.html' });
  });

  it('reports a starting server and missing frontends', () => {
    expect(localDecision({ record }, '/api/x').kind).toBe('unavailable');
    expect(localDecision({ record, server, staticDir: '/srv', webDevStarting: true }, '/').kind).toBe(
      'unavailable',
    );
    expect(localDecision({ record, server }, '/').kind).toBe('unavailable');
  });

  it('is server-only without static', () => {
    const r = localRouteRecord({
      app: 'a',
      stage: 'local',
      deploymentId: 'd',
      hasServer: true,
      hasStatic: false,
      serverRoutes: ['/api/'],
      spa: true,
    });
    expect(r.s).toBeUndefined();
    expect(localDecision({ record: r, server }, '/anything')).toEqual({ kind: 'server', target: server });
  });

  it('never escapes the static root', () => {
    expect(safeJoin('/srv/www', '/../../etc/passwd')).toBeNull();
    expect(safeJoin('/srv/www', '/a/b.js')).toBe('/srv/www/a/b.js');
  });
});

describe('startLocalRouter', () => {
  let upstream: Server;
  let router: Server;
  let base: string;
  const seen: Array<Record<string, string | string[] | undefined>> = [];

  beforeAll(async () => {
    upstream = createServer((req, res) => {
      seen.push(req.headers);
      res.writeHead(200, { 'content-type': 'text/plain' }).end(`server:${req.method} ${req.url}`);
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
    const up = { host: '127.0.0.1', port: (upstream.address() as AddressInfo).port };

    const staticDir = tempDir();
    mkdirSync(join(staticDir, 'assets'));
    writeFileSync(join(staticDir, 'index.html'), '<p>spa</p>');
    writeFileSync(join(staticDir, 'assets', 'app.js'), 'console.log(1)');

    router = await startLocalRouter({
      port: 0,
      state: () => ({ record, server: up, staticDir }),
      intercept: [
        (_req, res, url) => {
          if (url.pathname !== '/__plat_dev/ping') return false;
          res.writeHead(200).end('pong');
          return true;
        },
      ],
    });
    base = `http://127.0.0.1:${(router.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    router?.close();
    upstream?.close();
  });

  it('proxies server routes with the public host header', async () => {
    // fetch() can't set Host; use node:http like a browser hitting shop.localhost would.
    const text = await new Promise<string>((resolve, reject) => {
      const req = request(
        `${base}/api/items?q=1`,
        { method: 'POST', headers: { host: 'shop.localhost:3000' } },
        (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => resolve(body));
        },
      );
      req.once('error', reject);
      req.end('x');
    });
    expect(text).toBe('server:POST /api/items?q=1');
    expect(seen.at(-1)?.['x-platform-host']).toBe('shop.localhost:3000');
    expect(seen.at(-1)?.['x-forwarded-proto']).toBe('http');
  });

  it('serves static files and the SPA fallback', async () => {
    const js = await fetch(`${base}/assets/app.js`);
    expect(js.headers.get('content-type')).toContain('javascript');
    expect(await js.text()).toBe('console.log(1)');
    expect(await (await fetch(`${base}/some/page`)).text()).toBe('<p>spa</p>');
    expect((await fetch(`${base}/missing.png`)).status).toBe(404);
  });

  it('runs interceptors first', async () => {
    expect(await (await fetch(`${base}/__plat_dev/ping`)).text()).toBe('pong');
  });
});
