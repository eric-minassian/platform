import { AsyncLocalStorage } from 'node:async_hooks';
import { newSpanId, newTraceId, type PlatformUser } from '@ericminassian/platform-core';

/** Per-request / per-job context carried through async calls. */
export interface RequestContext {
  trace: string;
  /** Span id of the root (request or job). */
  span: string;
  /** performance.now() when the root started, for span offsets. */
  startedAt: number;
  /** Set-Cookie values produced while handling the request (e.g. token refresh). */
  cookies: string[];
  /** Matched route pattern, set by the router integration. */
  route?: string;
  /** Resolved user (undefined = not looked up yet, null = signed out). */
  user?: PlatformUser | null;
  /** Job name for error attribution in workers. */
  job?: string;
  /** Error a framework handled itself (e.g. a Hono app's onError), for telemetry. */
  error?: unknown;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function currentContext(): RequestContext | undefined {
  return storage.getStore();
}

export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function newContext(trace?: string | null): RequestContext {
  return { trace: trace || newTraceId(), span: newSpanId(), startedAt: performance.now(), cookies: [] };
}

/** Trace id of the current request/job, or a fresh one outside any context. */
export function currentTrace(): string {
  return storage.getStore()?.trace ?? newTraceId();
}

/** Parse a W3C `traceparent` header (`00-<32 hex trace>-<16 hex span>-<flags>`). */
export function parseTraceparent(header: string | null | undefined): string | undefined {
  if (!header) return undefined;
  const m = /^[\da-f]{2}-([\da-f]{32})-[\da-f]{16}-[\da-f]{2}$/i.exec(header.trim());
  return m?.[1]?.toLowerCase();
}

/**
 * Record the route pattern (e.g. `/api/todos/:id`) for the current request's
 * telemetry. Hono apps get this automatically; other frameworks can call it.
 */
export function setRoute(pattern: string): void {
  const ctx = storage.getStore();
  if (ctx) ctx.route = pattern;
}
