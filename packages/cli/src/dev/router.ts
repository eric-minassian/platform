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
import { decide, HOST_HEADER, type RouteRecord } from '@eric-minassian/platform-core';

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

export interface LocalRouterState {
  record: RouteRecord;
  server?: Target;
  webDev?: Target;
  /** A frontend dev server is configured but not accepting connections yet. */
  webDevStarting?: boolean;
  staticDir?: string;
}

export type LocalDecision =
  | { kind: 'server'; target: Target }
  | { kind: 'webdev'; target: Target }
  | { kind: 'file'; path: string }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'notfound' };

/** Pure routing decision, shared by the router and tests. */
export function localDecision(state: LocalRouterState, uri: string): LocalDecision {
  const pathname = uri.split('?')[0] ?? '/';
  const d = decide(state.record, pathname);
  if (d.t === 'notfound') return { kind: 'notfound' };
  if (d.t === 'server') {
    return state.server
      ? { kind: 'server', target: state.server }
      : { kind: 'unavailable', reason: 'the web server is starting' };
  }
  if (state.webDev) return { kind: 'webdev', target: state.webDev };
  if (state.webDevStarting) return { kind: 'unavailable', reason: 'the frontend dev server is starting' };
  if (!state.staticDir)
    return { kind: 'unavailable', reason: 'no frontend: set web.static or web.dev in platform.json' };
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
  serverRoutes: string[];
  spa: boolean;
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
  };
}

export type Interceptor = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean> | boolean;

export interface LocalRouterOptions {
  port: number;
  host?: string;
  state: () => LocalRouterState;
  /** Handled before routing (local sign-in, dev endpoints). Return true when handled. */
  intercept?: Interceptor[];
  onRequest?: (line: { method: string; url: string; status: number; ms: number; kind: string }) => void;
}

export function startLocalRouter(opts: LocalRouterOptions): Promise<Server> {
  const server = createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
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
    try {
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
        case 'unavailable':
          return text(res, 503, `${d.reason}\n`);
        case 'notfound':
          return text(res, 404, 'Not found\n');
      }
    } catch (err) {
      if (!res.headersSent) text(res, 502, `plat dev router error: ${(err as Error).message}\n`);
      else res.destroy();
    }
  });

  server.on('upgrade', (req, socket, head) => {
    const d = localDecision(opts.state(), req.url ?? '/');
    // Web Functions don't do WebSockets; only the frontend dev server (HMR) gets upgrades.
    if (d.kind !== 'webdev') {
      socket.end('HTTP/1.1 501 Not Implemented\r\n\r\n');
      return;
    }
    tunnel(req, socket as Socket, head, d.target);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host ?? '127.0.0.1', () => resolve(server));
  });
}

/** Headers the edge would add, so apps see their public host. */
export function forwardedHeaders(
  req: IncomingMessage,
  toServer: boolean,
): Record<string, string | string[] | undefined> {
  const headers: Record<string, string | string[] | undefined> = { ...req.headers };
  const host = req.headers.host ?? 'localhost';
  if (toServer) {
    headers[HOST_HEADER] = host;
    headers['x-forwarded-host'] = host;
    headers['x-forwarded-proto'] = 'http';
  }
  return headers;
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

function tunnel(req: IncomingMessage, socket: Socket, head: Buffer, target: Target): void {
  const up = connect(target.port, target.host, () => {
    const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
    for (let i = 0; i < req.rawHeaders.length; i += 2)
      lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
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
