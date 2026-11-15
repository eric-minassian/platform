import { createReadStream, existsSync, statSync } from 'node:fs';
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { connect, type Socket } from 'node:net';
import { extname, join, normalize, sep } from 'node:path';
import {
  APPSYNC_REALTIME_PATH,
  decide,
  type HealthResponse,
  HOST_HEADER,
  type RealtimeClientConfig,
  type RealtimeEdgeEntry,
  type RealtimeSubscribe,
  type RouteRecord,
  VIEWER_ADDRESS_HEADER,
} from '@ericminassian/platform-core';
import { isInboxPath, type LocalInbox } from './mail.ts';

/**
 * `plat dev`'s stand-in for the CloudFront router: the same `decide()` the
 * edge function runs, against a local route record. Server routes go to the
 * local web server; static routes go to the frontend dev server (original URL,
 * so it can do HMR and its own SPA fallback) or to files in `web.static`.
 */
export interface Target {
  host: string;
  port: number;
}

/**
 * The stage's realtime, as the edge serves it: the config browsers read at
 * `REALTIME_PATH`, and the emulator's realtime endpoint WebSockets go to.
 */
export interface LocalRealtime {
  config: RealtimeClientConfig;
  target: Target;
}

export interface LocalRouterState {
  record: RouteRecord;
  server?: Target;
  webDev?: Target;
  /** A frontend dev server is configured but not accepting connections yet. */
  webDevStarting?: boolean;
  staticDir?: string;
  realtime?: LocalRealtime;
}

export type LocalDecision =
  | { kind: 'server'; target: Target }
  | { kind: 'webdev'; target: Target }
  | { kind: 'file'; path: string }
  | { kind: 'health'; body: HealthResponse }
  | { kind: 'realtime'; realtime: LocalRealtime }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'notfound' };

/** Pure routing decision, shared by the router and tests. */
export function localDecision(state: LocalRouterState, uri: string): LocalDecision {
  const pathname = uri.split('?')[0] ?? '/';
  const d = decide(state.record, pathname);
  if (d.t === 'notfound') return { kind: 'notfound' };
  if (d.t === 'health') {
    const { app, stage, d: revision } = state.record;
    return { kind: 'health', body: { ok: true, app, stage, revision } };
  }
  if (d.t === 'realtime') {
    return state.realtime
      ? { kind: 'realtime', realtime: state.realtime }
      : { kind: 'unavailable', reason: 'realtime is not set up in the emulator' };
  }
  if (d.t === 'server') {
    return state.server
      ? { kind: 'server', target: state.server }
      : { kind: 'unavailable', reason: 'the web server is starting' };
  }
  if (state.webDev) return { kind: 'webdev', target: state.webDev };
  if (state.webDevStarting) return { kind: 'unavailable', reason: 'the frontend dev server is starting' };
  if (!state.staticDir)
    return { kind: 'unavailable', reason: 'no frontend: set web.static or web.dev in plat.config.ts' };
  const prefix = `/${state.record.s ?? ''}`;
  const rel = d.key.startsWith(prefix) ? d.key.slice(prefix.length) : d.key;
  const file = safeJoin(state.staticDir, decodeURIComponent(rel));
  return file ? { kind: 'file', path: file } : { kind: 'notfound' };
}

/** Local route record for an app (mirrors what the engine writes to the KVS). */
export function localRouteRecord(opts: {
  app: string;
  stage: string;
  deploymentId: string;
  hasServer: boolean;
  hasStatic: boolean;
  serverRoutes: readonly string[];
  spa: boolean;
  realtime?: { namespace: string; subscribe: RealtimeSubscribe };
}): RouteRecord {
  return {
    v: 1,
    app: opts.app,
    stage: opts.stage,
    d: opts.deploymentId,
    ...(opts.hasServer ? { o: 'local-server' } : {}),
    ...(opts.hasStatic ? { s: 'local' } : {}),
    ...(opts.hasServer && opts.hasStatic ? { r: opts.serverRoutes } : {}),
    spa: opts.spa ? 1 : 0,
    ...(opts.realtime
      ? { rt: { n: opts.realtime.namespace, m: opts.realtime.subscribe === 'signed-in' ? 's' : 'p' } }
      : {}),
  };
}

/**
 * The stage's local realtime from the platform's realtime entry (what the
 * edge reads from its route store): the config it answers, and where the
 * emulator's realtime endpoint (`host:port`) listens.
 */
export function localRealtime(
  entry: RealtimeEdgeEntry,
  stage: { namespace: string; subscribe: RealtimeSubscribe },
): LocalRealtime {
  const config: RealtimeClientConfig = {
    v: 1,
    host: entry.h,
    namespace: stage.namespace,
    subscribe: stage.subscribe,
    // Like the edge: signed-in stages never hand out the key.
    ...(stage.subscribe === 'public' ? { apiKey: entry.k } : {}),
  };
  return { config, target: parseHostPort(entry.o) };
}

function parseHostPort(domain: string): Target {
  const url = new URL(`http://${domain}`);
  return { host: url.hostname, port: url.port ? Number(url.port) : 80 };
}

export type Interceptor = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean> | boolean;

export interface LocalRouterOptions {
  port: number;
  host?: string;
  state: () => LocalRouterState;
  /**
   * The local inbox, served at `EMAIL_INBOX_PATH` on every host ahead of
   * routing: the path exists only locally, where mail is captured, not sent.
   */
  inbox?: Pick<LocalInbox, 'handle'>;
  /** Handled before routing (local sign-in, dev endpoints). Return true when handled. */
  intercept?: Interceptor[];
  onRequest?: (line: { method: string; url: string; status: number; ms: number; kind: string }) => void;
}

export function startLocalRouter(opts: LocalRouterOptions): Promise<Server> {
  const route = async (req: IncomingMessage, res: ServerResponse) => {
    const started = Date.now();
    let kind = 'intercept';
    res.once('finish', () =>
      opts.onRequest?.({
        method: req.method ?? 'GET',
        url: req.url ?? '/',
        status: res.statusCode,
        ms: Date.now() - started,
        kind,
      }),
    );
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (opts.inbox && isInboxPath(url.pathname)) {
      kind = 'mail';
      await opts.inbox.handle(req, res, url);
      return;
    }
    for (const fn of opts.intercept ?? []) if (await fn(req, res, url)) return;
    const d = localDecision(opts.state(), req.url ?? '/');
    kind = d.kind;
    switch (d.kind) {
      case 'server':
        return proxy(req, res, d.target, true);
      case 'webdev':
        return proxy(req, res, d.target, false);
      case 'file':
        return serveFile(res, d.path);
      case 'health':
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        return res.end(JSON.stringify(d.body));
      case 'realtime':
        // A WebSocket arrives as an `upgrade` (below); anything else reads the config.
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        return res.end(JSON.stringify(d.realtime.config));
      case 'unavailable':
        return text(res, 503, `${d.reason}\n`);
      case 'notfound':
        return text(res, 404, 'Not found\n');
    }
  };
  const server = createServer((req, res) => {
    route(req, res).catch((err: unknown) => {
      if (!res.headersSent) text(res, 502, `plat dev router error: ${(err as Error).message}\n`);
      else res.destroy();
    });
  });

  server.on('upgrade', (req, socket, head) => {
    const d = localDecision(opts.state(), req.url ?? '/');
    // Web Functions don't do WebSockets: upgrades go to the frontend dev server (HMR), or to
    // AppSync for realtime, rewritten like the edge does (AppSync's path and host, no cookies).
    if (d.kind === 'webdev') return tunnel(req, socket as Socket, head, d.target);
    if (d.kind === 'realtime') {
      const { target } = d.realtime;
      return tunnel(req, socket as Socket, head, target, {
        path: APPSYNC_REALTIME_PATH,
        host: `${target.host}:${target.port}`,
        drop: ['cookie', 'authorization'],
      });
    }
    socket.end('HTTP/1.1 501 Not Implemented\r\n\r\n');
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host ?? '127.0.0.1', () => resolve(server));
  });
}

/** Headers the edge would add, so apps see their public host and the client's address. */
export function forwardedHeaders(
  req: IncomingMessage,
  toServer: boolean,
): Record<string, string | string[] | undefined> {
  const headers: Record<string, string | string[] | undefined> = { ...req.headers };
  const host = req.headers.host ?? 'localhost';
  if (toServer) {
    // CloudFront replaces the `CloudFront-*` headers a client sends; never pass one through.
    for (const name of Object.keys(headers)) if (name.startsWith('cloudfront-')) delete headers[name];
    headers[HOST_HEADER] = host;
    headers['x-forwarded-host'] = host;
    headers['x-forwarded-proto'] = 'http';
    const address = viewerAddress(req.socket.remoteAddress, req.socket.remotePort);
    if (address) headers[VIEWER_ADDRESS_HEADER] = address;
  }
  return headers;
}

/** `ip:port` the way CloudFront writes it: IPv6 unbracketed, an IPv4 client as plain IPv4. */
export function viewerAddress(ip: string | undefined, port: number | undefined): string | undefined {
  if (!ip || port === undefined) return undefined;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1];
  return `${mapped ?? ip}:${port}`;
}

function proxy(req: IncomingMessage, res: ServerResponse, target: Target, toServer: boolean): Promise<void> {
  return new Promise((resolve) => {
    const upstream = httpRequest(
      {
        host: target.host,
        port: target.port,
        method: req.method,
        path: req.url,
        headers: forwardedHeaders(req, toServer),
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.statusMessage, up.headers);
        up.pipe(res);
        up.once('end', resolve);
      },
    );
    upstream.once('error', (err) => {
      if (!res.headersSent)
        text(res, 502, `upstream ${target.host}:${target.port} unavailable: ${err.message}\n`);
      resolve();
    });
    req.pipe(upstream);
  });
}

/** Request rewrites for a tunneled upgrade: another path and Host, minus some headers. */
interface TunnelRewrite {
  path?: string;
  host?: string;
  /** Lowercase header names. */
  drop?: readonly string[];
}

function tunnel(
  req: IncomingMessage,
  socket: Socket,
  head: Buffer,
  target: Target,
  rewrite: TunnelRewrite = {},
): void {
  const up = connect(target.port, target.host, () => {
    const lines = [`${req.method} ${rewrite.path ?? req.url} HTTP/${req.httpVersion}`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i]!;
      const lower = name.toLowerCase();
      if (rewrite.drop?.includes(lower)) continue;
      lines.push(`${name}: ${rewrite.host && lower === 'host' ? rewrite.host : req.rawHeaders[i + 1]}`);
    }
    up.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  const close = () => {
    up.destroy();
    socket.destroy();
  };
  up.once('error', close);
  socket.once('error', close);
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json',
};

function serveFile(res: ServerResponse, path: string): void {
  if (!existsSync(path) || !statSync(path).isFile()) {
    text(res, 404, 'Not found\n');
    return;
  }
  res.writeHead(200, {
    'content-type': MIME[extname(path)] ?? 'application/octet-stream',
    'cache-control': 'no-cache',
  });
  createReadStream(path).pipe(res);
}

function text(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(body);
}

/** Join without escaping `root` (path traversal). */
export function safeJoin(root: string, rel: string): string | null {
  const full = normalize(join(root, rel));
  const base = normalize(root.endsWith(sep) ? root : root + sep);
  return full === normalize(root) || full.startsWith(base) ? full : null;
}
