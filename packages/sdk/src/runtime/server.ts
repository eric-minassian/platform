/**
 * Web Function entry wrapper. `plat build` generates:
 *
 *   import handler from '<app>/src/server.ts';   // `toFetchHandler(...)`
 *   import { startServer } from '@ericminassian/platform/server';
 *   startServer(handler);
 *
 * and bundles it to `index.mjs`. startServer listens on
 * `AWS_LAMBDA_HTTP_ENDPOINT` (Web Function contract; `plat dev` sets it too),
 * adds `/__platform/*` routes (health, auth, realtime token), auto-instruments every request
 * (telemetry `req`/`err`/`span` lines, traces) and maps `x-platform-host` to
 * the public URL the app sees.
 *
 * CONTRACT: used by the CLI build. Keep stable.
 */
import {
  fingerprint,
  HEALTH_PATH,
  type HealthResponse,
  HOST_HEADER,
  PLATFORM_PATH_PREFIX,
  TRACE_HEADER,
  VIEWER_COUNTRY_HEADER,
} from '@ericminassian/platform-core';
import { authGate, handleAuthRoute } from './auth/index.ts';
import { getBindings, tryBindings } from './bindings.ts';
import { parseTraceparent, runWithContext, startRoot } from './context.ts';
import { createNodeServer, parseEndpoint } from './http.ts';
import { handleRealtimeRoute } from './realtime.ts';
import {
  emit,
  emitError,
  endRoot,
  installConsoleCapture,
  installFetchInstrumentation,
  toError,
} from './telemetry.ts';

/** A web-standard fetch: what `toFetchHandler` returns, or a bare function. */
export type FetchHandlerLike =
  | { fetch(request: Request): Response | Promise<Response> }
  | ((request: Request) => Response | Promise<Response>);

let cold = true;

/** The wrapped fetch (platform routes + instrumentation), without listening. Useful in tests. */
export function createPlatformFetch(handler: FetchHandlerLike): (request: Request) => Promise<Response> {
  const appFetch = typeof handler === 'function' ? handler : (req: Request) => handler.fetch(req);

  return async (incoming: Request): Promise<Response> => {
    const t0 = performance.now();
    const trace = incoming.headers.get(TRACE_HEADER) ?? parseTraceparent(incoming.headers.get('traceparent'));
    const ctx = startRoot(trace);
    const wasCold = cold;
    cold = false;

    return runWithContext(ctx, async () => {
      const request = publicRequest(incoming);
      const url = new URL(request.url);
      let response: Response;
      let errorEmitted = false;
      try {
        if (url.pathname.startsWith(PLATFORM_PATH_PREFIX)) {
          response = await platformRoute(request);
        } else {
          response = (await authGate(request)) ?? (await appFetch(request));
        }
      } catch (e) {
        // `toFetchHandler` answers the app's own failures; this is the wrapper's.
        emitError(e, 'http', { route: ctx.route ?? normalizePath(url.pathname) });
        errorEmitted = true;
        response = Response.json(
          { error: { code: 'internal', message: 'Internal Server Error', trace: ctx.trace } },
          { status: 500 },
        );
      }

      response = finalize(response, ctx.trace, ctx.cookies);
      const route = ctx.route ?? normalizePath(url.pathname);
      if (response.status >= 500 && !errorEmitted) {
        if (ctx.error !== undefined) emitError(ctx.error, 'http', { route });
        else {
          const e = new Error(`HTTP ${response.status} ${request.method} ${route}`);
          e.name = 'HttpError';
          emitError(e, 'http', { route });
        }
      }
      endRoot(ctx, 'req', {
        method: request.method,
        route,
        path: url.pathname,
        status: response.status,
        dur: Math.round((performance.now() - t0) * 10) / 10,
        ...(lengthOf(response) !== undefined ? { bytes: lengthOf(response)! } : {}),
        ...(incoming.headers.get(VIEWER_COUNTRY_HEADER)
          ? { country: incoming.headers.get(VIEWER_COUNTRY_HEADER)! }
          : {}),
        ...(ctx.user ? { user: fingerprint([ctx.user.id]) } : {}),
        ...(wasCold ? { cold: true } : {}),
      });
      return response;
    });
  };
}

/** Rewrite the request onto the app's public origin (scheme/port from bindings, host from the router). */
function publicRequest(incoming: Request): Request {
  const b = tryBindings();
  if (!b) return incoming;
  const inUrl = new URL(incoming.url);
  const origin = new URL(b.url);
  const forwarded = incoming.headers.get(HOST_HEADER);
  if (forwarded && /^[a-z0-9.-]+$/i.test(forwarded.replace(/:\d+$/, '')))
    origin.hostname = forwarded.replace(/:\d+$/, '');
  const target = `${origin.origin}${inUrl.pathname}${inUrl.search}`;
  if (target === incoming.url) return incoming;
  const hasBody = incoming.method !== 'GET' && incoming.method !== 'HEAD';
  return new Request(target, {
    method: incoming.method,
    headers: incoming.headers,
    signal: incoming.signal,
    redirect: incoming.redirect,
    ...(hasBody ? { body: incoming.body, duplex: 'half' } : {}),
  });
}

async function platformRoute(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === HEALTH_PATH) {
    const b = getBindings();
    const body: HealthResponse = { ok: true, app: b.app, stage: b.stage, revision: b.revision };
    return Response.json(body, { headers: { 'cache-control': 'no-store' } });
  }
  const authResponse = await handleAuthRoute(request);
  if (authResponse) return authResponse;
  const realtimeResponse = await handleRealtimeRoute(request);
  if (realtimeResponse) return realtimeResponse;
  return Response.json({ error: { code: 'not_found', message: 'Not found' } }, { status: 404 });
}

function finalize(response: Response, trace: string, cookies: string[]): Response {
  const headers = new Headers(response.headers);
  headers.set(TRACE_HEADER, trace);
  if (!headers.has('cache-control')) headers.set('cache-control', 'private, no-store');
  for (const c of cookies) headers.append('set-cookie', c);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function lengthOf(r: Response): number | undefined {
  const v = r.headers.get('content-length');
  return v ? Number(v) : undefined;
}

// ---------------------------------------------------------------- route patterns

const ID_SEGMENT =
  /^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{12,}|[0-9a-hjkmnp-tv-z]{26}|(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{16,})$/i;

/** `/api/todos/42` → `/api/todos/:id`, for requests whose route pattern wasn't recorded (no route matched). */
export function normalizePath(path: string): string {
  return path
    .split('/')
    .map((seg) => (seg && ID_SEGMENT.test(seg) ? ':id' : seg))
    .join('/');
}

// ---------------------------------------------------------------- server

/** Start the HTTP server. Resolves once listening. */
export async function startServer(handler: FetchHandlerLike): Promise<{ close(): Promise<void> }> {
  installConsoleCapture();
  installFetchInstrumentation();
  const endpoint =
    process.env.AWS_LAMBDA_HTTP_ENDPOINT ??
    (process.env.PORT ? `127.0.0.1:${process.env.PORT}` : '127.0.0.1:8080');
  const { host, port } = parseEndpoint(endpoint);
  const server = createNodeServer(createPlatformFetch(handler));
  server.keepAliveTimeout = 65_000;

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  emit('env', { event: 'start', runtime: 'web', initMs: Math.round(performance.now()) });

  const close = () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeIdleConnections?.();
    });

  process.once('SIGTERM', () => {
    emit('env', { event: 'stop', runtime: 'web' });
    // Web Functions allow ~1 s for cleanup after SIGTERM.
    const force = setTimeout(() => process.exit(0), 900);
    force.unref();
    void close().then(() => process.exit(0));
  });
  process.on('unhandledRejection', (reason) => emitError(toError(reason), 'unhandled'));
  return { close };
}
