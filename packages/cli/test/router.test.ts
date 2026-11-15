import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import { type AddressInfo, createServer as createTcpServer, type Server as TcpServer } from 'node:net';
import { join } from 'node:path';
import { REALTIME_PATH, REALTIME_TOKEN_PATH, type RealtimeEdgeEntry } from '@ericminassian/platform-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type LocalRealtime,
  type LocalRouterState,
  localDecision,
  localRealtime,
  localRouteRecord,
  safeJoin,
  startLocalRouter,
  viewerAddress,
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
const entry: RealtimeEdgeEntry = { v: 1, h: '127.0.0.1:4001', o: '127.0.0.1:4002', k: 'da2-local' };

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

  it('answers health itself for a static-only stage, like the edge', () => {
    const r = localRouteRecord({
      app: 'a',
      stage: 'local',
      deploymentId: 'd1',
      hasServer: false,
      hasStatic: true,
      serverRoutes: ['/api/'],
      spa: true,
    });
    expect(localDecision({ record: r, staticDir: '/srv/www' }, '/__platform/health')).toEqual({
      kind: 'health',
      body: { ok: true, app: 'a', stage: 'local', revision: 'd1' },
    });
  });

  it('keeps the realtime path for the router when the stage has realtime', () => {
    const rtRecord = localRouteRecord({
      app: 'shop',
      stage: 'local',
      deploymentId: 'd1',
      hasServer: true,
      hasStatic: true,
      serverRoutes: ['/api/'],
      spa: true,
      realtime: { namespace: 'shop--local', subscribe: 'signed-in' },
    });
    expect(rtRecord.rt).toEqual({ n: 'shop--local', m: 's' });
    const realtime = localRealtime(entry, { namespace: 'shop--local', subscribe: 'signed-in' });
    const s: LocalRouterState = { record: rtRecord, server, webDev, realtime };
    expect(localDecision(s, `${REALTIME_PATH}?x=1`)).toEqual({ kind: 'realtime', realtime });
    // The token comes from the app's server.
    expect(localDecision(s, REALTIME_TOKEN_PATH)).toEqual({ kind: 'server', target: server });
    expect(localDecision({ record: rtRecord, server }, REALTIME_PATH).kind).toBe('unavailable');
    // No realtime declared: the path is the server's, like any platform path.
    expect(localDecision({ record, server }, REALTIME_PATH)).toEqual({ kind: 'server', target: server });
  });

  it('serves the key only to public stages, like the edge', () => {
    expect(localRealtime(entry, { namespace: 'shop--local', subscribe: 'public' })).toEqual({
      config: {
        v: 1,
        host: '127.0.0.1:4001',
        namespace: 'shop--local',
        subscribe: 'public',
        apiKey: 'da2-local',
      },
      target: { host: '127.0.0.1', port: 4002 },
    });
    expect(localRealtime(entry, { namespace: 'n', subscribe: 'signed-in' }).config.apiKey).toBeUndefined();
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

  it('tells the server the client address like the edge, replacing what the client sent', async () => {
    await fetch(`${base}/api/items`, {
      headers: { 'cloudfront-viewer-address': '203.0.113.9:1', 'cloudfront-viewer-country': 'ZZ' },
    });
    expect(seen.at(-1)?.['cloudfront-viewer-address']).toMatch(/^127\.0\.0\.1:\d+$/);
    expect(seen.at(-1)).not.toHaveProperty('cloudfront-viewer-country');
  });

  it('writes client addresses the way CloudFront does', () => {
    expect(viewerAddress('127.0.0.1', 51234)).toBe('127.0.0.1:51234');
    expect(viewerAddress('::ffff:127.0.0.1', 51234)).toBe('127.0.0.1:51234');
    expect(viewerAddress('::1', 51234)).toBe('::1:51234');
    expect(viewerAddress(undefined, undefined)).toBeUndefined();
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

describe('startLocalRouter realtime', () => {
  let upstream: TcpServer;
  let router: Server;
  let routerPort: number;
  let realtime: LocalRealtime;
  /** The request head the fake AppSync realtime endpoint received. */
  let head = '';

  beforeAll(async () => {
    // A stand-in for the emulator's realtime endpoint: records the handshake,
    // switches protocols, then echoes bytes back.
    upstream = createTcpServer((socket) => {
      let buffered = '';
      const onData = (chunk: Buffer) => {
        buffered += chunk.toString('latin1');
        const end = buffered.indexOf('\r\n\r\n');
        if (end === -1) return;
        socket.off('data', onData);
        head = buffered.slice(0, end);
        socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
        const rest = buffered.slice(end + 4);
        if (rest) socket.write(Buffer.from(rest, 'latin1'));
        socket.pipe(socket);
      };
      socket.on('data', onData);
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
    const port = (upstream.address() as AddressInfo).port;
    realtime = localRealtime(
      { v: 1, h: '127.0.0.1:4001', o: `127.0.0.1:${port}`, k: 'da2-local' },
      { namespace: 'shop--local', subscribe: 'public' },
    );
    const rtRecord = localRouteRecord({
      app: 'shop',
      stage: 'local',
      deploymentId: 'd1',
      hasServer: false,
      hasStatic: true,
      serverRoutes: ['/api/'],
      spa: true,
      realtime: { namespace: 'shop--local', subscribe: 'public' },
    });
    router = await startLocalRouter({
      port: 0,
      state: () => ({ record: rtRecord, staticDir: '/srv', realtime }),
    });
    routerPort = (router.address() as AddressInfo).port;
  });

  afterAll(() => {
    router?.close();
    upstream?.close();
  });

  it('answers the realtime config', async () => {
    const res = await fetch(`http://127.0.0.1:${routerPort}${REALTIME_PATH}`);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual(realtime.config);
  });

  it('tunnels a WebSocket handshake to AppSync’s path and host, without cookies', async () => {
    const echoed = await new Promise<string>((resolve, reject) => {
      const req = request({
        host: '127.0.0.1',
        port: routerPort,
        path: `${REALTIME_PATH}?v=1`,
        headers: {
          host: 'shop.localhost:3000',
          connection: 'Upgrade',
          upgrade: 'websocket',
          'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
          'sec-websocket-version': '13',
          'sec-websocket-protocol': 'aws-appsync-event-ws, header-abc',
          cookie: '__platform_id=secret',
          authorization: 'Bearer x',
        },
      });
      req.once('error', reject);
      req.once('upgrade', (res, socket) => {
        expect(res.statusCode).toBe(101);
        socket.once('data', (d) => {
          resolve(d.toString());
          socket.destroy();
        });
        socket.write('ping');
      });
      req.end();
    });
    expect(echoed).toBe('ping');
    const [requestLine, ...headers] = head.split('\r\n');
    expect(requestLine).toBe('GET /event/realtime HTTP/1.1');
    const byName = Object.fromEntries(
      headers.map((h) => [h.slice(0, h.indexOf(':')).toLowerCase(), h.slice(h.indexOf(':') + 1).trim()]),
    );
    expect(byName.host).toBe(`${realtime.target.host}:${realtime.target.port}`);
    expect(byName['sec-websocket-protocol']).toBe('aws-appsync-event-ws, header-abc');
    expect(byName.cookie).toBeUndefined();
    expect(byName.authorization).toBeUndefined();
  });

  it('refuses other upgrades', async () => {
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request({
        host: '127.0.0.1',
        port: routerPort,
        path: '/ws',
        headers: {
          connection: 'Upgrade',
          upgrade: 'websocket',
          'sec-websocket-key': 'x',
          'sec-websocket-version': '13',
        },
      });
      req.once('error', reject);
      req.once('response', (res) => resolve(res.statusCode));
      req.once('upgrade', () => resolve(101));
      req.end();
    });
    expect(status).toBe(501);
  });
});
