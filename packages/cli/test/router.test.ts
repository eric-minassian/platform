import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import { type AddressInfo, createServer as createTcpServer, type Server as TcpServer } from 'node:net';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  type CapturedEmail,
  EMAIL_INBOX_PATH,
  LOCAL_MAIL_URL_ENV,
  REALTIME_PATH,
  REALTIME_TOKEN_PATH,
  type RealtimeEdgeEntry,
  STORAGE_PATH,
} from '@ericminassian/platform-core';
import { localInbox, waitForEmail } from '@ericminassian/platform/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createInbox, type LocalInbox, localMailUrl, startInboxServer } from '../src/dev/mail.ts';
import {
  type LocalRealtime,
  type LocalRouterState,
  localDecision,
  localRealtime,
  localRouteRecord,
  type PublicFiles,
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
    const notFound = '/srv/www/404.html';
    expect(localDecision(s, '/assets/app.js')).toEqual({
      kind: 'file',
      path: '/srv/www/assets/app.js',
      notFound,
    });
    expect(localDecision(s, '/deep/link')).toEqual({ kind: 'file', path: '/srv/www/index.html', notFound });
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

  it('answers a file the build doesn’t have with its 404 page, like the edge', async () => {
    const staticDir = tempDir();
    writeFileSync(join(staticDir, 'index.html'), '<p>home</p>');
    writeFileSync(join(staticDir, '404.html'), '<p>not here</p>');
    const site = localRouteRecord({
      app: 'docs',
      stage: 'local',
      deploymentId: 'd1',
      hasServer: false,
      hasStatic: true,
      serverRoutes: [],
      spa: false,
    });
    const pages = await startLocalRouter({ port: 0, state: () => ({ record: site, staticDir }) });
    try {
      const at = `http://127.0.0.1:${(pages.address() as AddressInfo).port}`;
      const missing = await fetch(`${at}/no/such/page`);
      expect(missing.status).toBe(404);
      expect(missing.headers.get('content-type')).toContain('text/html');
      expect(await missing.text()).toBe('<p>not here</p>');
      expect((await fetch(`${at}/gone.png`)).status).toBe(404);
      expect(await (await fetch(`${at}/`)).text()).toBe('<p>home</p>');
    } finally {
      pages.close();
    }
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

describe('startLocalRouter mail', () => {
  let upstream: Server;
  let router: Server;
  let base: string;
  let inbox: LocalInbox;
  let arrived: CapturedEmail[];
  const serverSaw: string[] = [];
  const savedUrl = process.env[LOCAL_MAIL_URL_ENV];

  const mail = (overrides: Partial<CapturedEmail> = {}): CapturedEmail => ({
    id: crypto.randomUUID(),
    at: '2026-11-15T12:00:00.000Z',
    app: 'shop',
    stage: 'local',
    from: '"Shop" <shop--local@mail.localhost>',
    to: ['alice@example.com'],
    replyTo: [],
    subject: 'Your order',
    text: 'Thanks for your order.',
    ...overrides,
  });
  const post = (body: unknown, contentType = 'application/json') =>
    fetch(`${base}${EMAIL_INBOX_PATH}/messages`, {
      method: 'POST',
      headers: { 'content-type': contentType },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

  beforeAll(async () => {
    upstream = createServer((req, res) => {
      serverSaw.push(req.url ?? '');
      res.writeHead(200).end('server');
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
    const up = { host: '127.0.0.1', port: (upstream.address() as AddressInfo).port };
    inbox = createInbox({ app: 'shop', capacity: 3, onMessage: (m) => arrived.push(m) });
    router = await startLocalRouter({ port: 0, state: () => ({ record, server: up }), inbox });
    base = `http://127.0.0.1:${(router.address() as AddressInfo).port}`;
  });
  beforeEach(() => {
    arrived = [];
  });
  afterEach(() => {
    if (savedUrl === undefined) delete process.env[LOCAL_MAIL_URL_ENV];
    else process.env[LOCAL_MAIL_URL_ENV] = savedUrl;
  });
  afterAll(() => {
    inbox.close();
    router?.close();
    upstream?.close();
  });

  it('takes the inbox paths ahead of routing, which would send /__platform/* to the server', async () => {
    expect(localDecision({ record, server }, EMAIL_INBOX_PATH)).toEqual({ kind: 'server', target: server });
    for (const path of [
      EMAIL_INBOX_PATH,
      `${EMAIL_INBOX_PATH}/`,
      `${EMAIL_INBOX_PATH}/messages`,
      `${EMAIL_INBOX_PATH}/nope`,
    ])
      await (await fetch(`${base}${path}`)).arrayBuffer();
    expect(serverSaw).toEqual([]);
    expect(await (await fetch(`${base}/__platform/mailbox`)).text()).toBe('server');
    expect(serverSaw).toEqual(['/__platform/mailbox']);
  });

  it('keeps what the SDK posts, newest first, for the JSON list and the SDK’s test helpers', async () => {
    const first = mail({ subject: 'First' });
    const second = mail({ subject: 'Second', to: ['bob@example.com'] });
    expect((await post(first)).status).toBe(201);
    const res = await post(second);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: second.id });
    expect(arrived).toEqual([first, second]);

    const list = await fetch(`${base}${EMAIL_INBOX_PATH}/messages`);
    expect(list.headers.get('content-type')).toBe('application/json');
    expect(((await list.json()) as { messages: CapturedEmail[] }).messages.slice(0, 2)).toEqual([
      second,
      first,
    ]);

    process.env[LOCAL_MAIL_URL_ENV] = localMailUrl(base);
    expect((await localInbox()).slice(0, 2)).toEqual([second, first]);
    expect(await waitForEmail((m) => m.to.includes('bob@example.com'))).toEqual(second);
    await expect(waitForEmail((m) => m.subject === 'never', { timeoutMs: 150 })).rejects.toThrow(
      /within 150 ms/,
    );
  });

  it('keeps only the newest messages', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const m = mail({ subject: `n${i}` });
      ids.push(m.id);
      await post(m);
    }
    expect(inbox.messages().map((m) => m.id)).toEqual(ids.slice(2).toReversed());
    expect((await fetch(`${base}${EMAIL_INBOX_PATH}/${ids[0]}`)).status).toBe(404);
  });

  it('accepts only JSON messages', async () => {
    expect((await post(mail(), 'text/plain')).status).toBe(415);
    expect((await post('{nope')).status).toBe(400);
    expect((await post({ ...mail(), to: 'alice@example.com' })).status).toBe(400);
    expect((await post({ ...mail(), id: '../x' })).status).toBe(400);
    expect((await post({ ...mail(), id: '..' })).status).toBe(400);
    const put = await fetch(`${base}${EMAIL_INBOX_PATH}/messages`, { method: 'PUT' });
    expect(put.status).toBe(405);
    expect(put.headers.get('allow')).toBe('GET, POST');
    expect((await fetch(`${base}${EMAIL_INBOX_PATH}`, { method: 'POST' })).status).toBe(405);
    expect(arrived).toEqual([]);
  });

  it('lists messages on the inbox page, escaped', async () => {
    const m = mail({ subject: '<script>alert(1)</script> & more', to: ['carol@example.com'] });
    await post(m);
    const res = await fetch(`${base}${EMAIL_INBOX_PATH}`);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    const page = await res.text();
    expect(page).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; more');
    expect(page).not.toContain('<script>alert(1)');
    expect(page).toContain('carol@example.com');
    expect(page).toContain('&quot;Shop&quot; &lt;shop--local@mail.localhost&gt;');
    expect(page).toContain(`href="${EMAIL_INBOX_PATH}/${m.id}"`);
    expect(page).toContain('<time datetime="2026-11-15T12:00:00.000Z">2026-11-15 12:00:00 UTC</time>');
    expect(page).toContain('3 messages');
  });

  it('shows a message with its HTML in a sandboxed frame that runs no scripts', async () => {
    const m = mail({
      html: '<!DOCTYPE html><p>Hi <a href="http://shop.localhost:3000/verify">verify</a></p>',
      replyTo: ['help@shop.example'],
    });
    await post(m);
    const page = await (await fetch(`${base}${EMAIL_INBOX_PATH}/${m.id}`)).text();
    expect(page).toContain('<h2>Your order</h2>');
    expect(page).toContain('<dt>Reply-To</dt><dd>help@shop.example</dd>');
    const frame = /<iframe [^>]*>/.exec(page)?.[0] ?? '';
    expect(frame).toContain(`src="${EMAIL_INBOX_PATH}/${m.id}/html"`);
    expect(frame).toMatch(/ sandbox="[^"]*"/);
    expect(frame).not.toContain('allow-scripts');
    expect(frame).not.toContain('allow-same-origin');
    expect(page).toContain('<pre>Thanks for your order.</pre>');

    const body = await fetch(`${base}${EMAIL_INBOX_PATH}/${m.id}/html`);
    const csp = body.headers.get('content-security-policy') ?? '';
    expect(csp).toMatch(/^sandbox /);
    expect(csp).not.toContain('allow-scripts');
    expect(csp).not.toMatch(/script-src/);
    // Links open outside the frame, after the doctype so the document keeps its mode.
    expect(await body.text()).toBe(
      '<!DOCTYPE html><base target="_blank"><p>Hi <a href="http://shop.localhost:3000/verify">verify</a></p>',
    );
  });

  it('shows a text-only message without a frame', async () => {
    const m = mail();
    await post(m);
    const page = await (await fetch(`${base}${EMAIL_INBOX_PATH}/${m.id}`)).text();
    expect(page).not.toContain('<iframe');
    expect(page).not.toContain('Reply-To');
    expect((await fetch(`${base}${EMAIL_INBOX_PATH}/${m.id}/html`)).status).toBe(404);
    expect((await fetch(`${base}${EMAIL_INBOX_PATH}/missing-id`)).status).toBe(404);
    expect((await fetch(`${base}${EMAIL_INBOX_PATH}/%E0%A4%A`)).status).toBe(404);
  });

  it('tells open pages about each new message', async () => {
    const controller = new AbortController();
    const res = await fetch(`${base}${EMAIL_INBOX_PATH}/events`, { signal: controller.signal });
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const reader = res.body!.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    const m = mail();
    await post(m);
    let text = '';
    while (!text.includes('data:')) text += new TextDecoder().decode((await reader.read()).value);
    expect(text).toContain(`data: {"id":"${m.id}"}`);
    controller.abort();
  });
});

describe('startInboxServer', () => {
  it('serves the inbox on its own port for plat test', async () => {
    const inbox = createInbox({ app: 'shop' });
    const inboxServer = await startInboxServer(inbox);
    try {
      expect(inboxServer.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/__platform\/mail\/messages$/);
      const posted = await fetch(inboxServer.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 'm1',
          at: new Date().toISOString(),
          app: 'shop',
          stage: 'test',
          from: 'shop--test@mail.localhost',
          to: ['a@example.com'],
          replyTo: [],
          subject: 'Hi',
          text: 'Hello',
        }),
      });
      expect(posted.status).toBe(201);
      expect(
        ((await (await fetch(inboxServer.url)).json()) as { messages: unknown[] }).messages,
      ).toHaveLength(1);
      expect((await fetch(new URL('/elsewhere', inboxServer.url))).status).toBe(404);
    } finally {
      await inboxServer.stop();
    }
  });
});

describe('startLocalRouter public stores', () => {
  const files = new Map<string, { body: string; contentType?: string; cacheControl?: string; etag: string }>([
    [
      '_public/atlas/local/snapshots/fires/today 1.json',
      { body: '{"n":1}', contentType: 'application/json', cacheControl: 'public, max-age=60', etag: '"e1"' },
    ],
    ['_public/atlas/local/snapshots/raw.bin', { body: 'abcdef', etag: '"e2"' }],
  ]);
  const asked: Array<{ key: string; range?: string; ifNoneMatch?: string }> = [];
  const publicFiles: PublicFiles = async (key, conditions) => {
    asked.push({ key, ...conditions });
    const f = files.get(key);
    if (!f) return undefined;
    if (conditions.ifNoneMatch === f.etag) return { status: 304, headers: { etag: f.etag } };
    const m = conditions.range ? /^bytes=(\d+)-(\d+)$/.exec(conditions.range) : null;
    const body = m ? f.body.slice(Number(m[1]), Number(m[2]) + 1) : f.body;
    return {
      status: m ? 206 : 200,
      body: Readable.from([Buffer.from(body)]),
      headers: {
        etag: f.etag,
        contentLength: body.length,
        ...(m ? { contentRange: `bytes ${m[1]}-${m[2]}/${f.body.length}` } : {}),
        ...(f.contentType ? { contentType: f.contentType } : {}),
        ...(f.cacheControl ? { cacheControl: f.cacheControl } : {}),
      },
    };
  };
  const atlas = localRouteRecord({
    app: 'atlas',
    stage: 'local',
    deploymentId: 'd1',
    hasServer: true,
    hasStatic: false,
    serverRoutes: ['/api/'],
    spa: true,
    publicStores: ['snapshots'],
  });
  let router: Server;
  let base: string;

  beforeAll(async () => {
    router = await startLocalRouter({ port: 0, state: () => ({ record: atlas, publicFiles }) });
    base = `http://127.0.0.1:${(router.address() as AddressInfo).port}`;
  });
  afterAll(() => router?.close());

  it('decides like the edge, with the full key in the storage bucket', () => {
    expect(atlas.p).toEqual(['snapshots']);
    expect(
      localDecision({ record: atlas, publicFiles }, `${STORAGE_PATH}snapshots/a%20b.json?x=1`),
    ).toMatchObject({
      kind: 'storage',
      key: '_public/atlas/local/snapshots/a b.json',
    });
    expect(localDecision({ record: atlas }, `${STORAGE_PATH}snapshots/a.json`)).toMatchObject({
      kind: 'unavailable',
    });
    expect(localDecision({ record: atlas, publicFiles }, `${STORAGE_PATH}uploads/a.json`)).toEqual({
      kind: 'notfound',
    });
  });

  it('serves a file with its own headers and the edge’s', async () => {
    const res = await fetch(`${base}${STORAGE_PATH}snapshots/fires/today%201.json`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"n":1}');
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.headers.get('cache-control')).toBe('public, max-age=60');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toBe("script-src 'none'");
    expect(res.headers.get('etag')).toBe('"e1"');
  });

  it('defaults Cache-Control, and passes ranges and revalidation on', async () => {
    const raw = await fetch(`${base}${STORAGE_PATH}snapshots/raw.bin`, { headers: { range: 'bytes=1-2' } });
    expect(raw.status).toBe(206);
    expect(await raw.text()).toBe('bc');
    expect(raw.headers.get('content-range')).toBe('bytes 1-2/6');
    expect(raw.headers.get('cache-control')).toBe('no-cache');
    const again = await fetch(`${base}${STORAGE_PATH}snapshots/raw.bin`, {
      headers: { 'if-none-match': '"e2"' },
    });
    expect(again.status).toBe(304);
    const head = await fetch(`${base}${STORAGE_PATH}snapshots/raw.bin`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe('6');
  });

  it('answers 404 for missing files and other stores, and refuses writes', async () => {
    expect((await fetch(`${base}${STORAGE_PATH}snapshots/missing.json`)).status).toBe(404);
    expect((await fetch(`${base}${STORAGE_PATH}uploads/a.json`)).status).toBe(404);
    expect((await fetch(`${base}${STORAGE_PATH}snapshots/..%2Fx`)).status).toBe(404);
    expect(
      (await fetch(`${base}${STORAGE_PATH}snapshots/raw.bin`, { method: 'PUT', body: 'x' })).status,
    ).toBe(403);
    expect(asked.every((a) => a.key.startsWith('_public/atlas/local/snapshots/'))).toBe(true);
  });
});
