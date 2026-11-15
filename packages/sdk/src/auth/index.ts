import {
  APP_CONFIG_FILE,
  AUTH_COOKIES,
  AUTH_ROUTES,
  AUTH_SCOPES,
  type AuthBindings,
  type Bindings,
  type PlatformUser,
} from '@ericminassian/platform-core';
import { getBindings } from '../bindings.ts';
import { currentContext } from '../context.ts';
import { log } from '../telemetry.ts';
import { clearCookie, parseCookies, serializeCookie } from './cookies.ts';
import { challengeFor, createVerifier, decodeFlow, encodeFlow, randomState, safeRedirect } from './pkce.ts';
import {
  exchangeCode,
  isExpiredError,
  localSignIn,
  refreshTokens,
  type Tokens,
  verifyToken,
} from './tokens.ts';

export interface Auth {
  /** The signed-in user for this request, or null. */
  getUser(request: Request): Promise<PlatformUser | null>;
  /** Like getUser but throws a 401 Response when signed out. */
  requireUser(request: Request): Promise<PlatformUser>;
  /** Path to start sign-in, returning to `redirect` afterwards. */
  loginUrl(redirect?: string): string;
  logoutUrl(redirect?: string): string;
}

const SESSION_MAX_AGE = 30 * 24 * 3600;
const FLOW_MAX_AGE = 600;

function authBindings(): AuthBindings {
  const a = getBindings().auth;
  if (!a) throw new Error(`Auth is not enabled for this app. Add \`auth: true\` to ${APP_CONFIG_FILE}.`);
  return a;
}

function secure(b: Bindings): boolean {
  return b.url.startsWith('https:');
}

export function sessionCookies(b: Bindings, tokens: Tokens): string[] {
  const opts = { maxAge: SESSION_MAX_AGE, secure: secure(b) };
  const out = [serializeCookie(AUTH_COOKIES.id, tokens.idToken, opts)];
  if (tokens.refreshToken) out.push(serializeCookie(AUTH_COOKIES.refresh, tokens.refreshToken, opts));
  return out;
}

export function clearSessionCookies(b: Bindings): string[] {
  return [
    clearCookie(AUTH_COOKIES.id, { secure: secure(b) }),
    clearCookie(AUTH_COOKIES.refresh, { secure: secure(b) }),
  ];
}

function bearer(request: Request): string | undefined {
  const h = request.headers.get('authorization');
  const m = h ? /^Bearer\s+(.+)$/i.exec(h) : null;
  return m?.[1];
}

async function resolveUser(request: Request): Promise<PlatformUser | null> {
  const ctx = currentContext();
  if (ctx && ctx.user !== undefined) return ctx.user;
  const b = getBindings();
  const a = authBindings();
  const cookies = parseCookies(request.headers.get('cookie'));
  const idToken = cookies[AUTH_COOKIES.id] ?? bearer(request);
  const refresh = cookies[AUTH_COOKIES.refresh];
  let user: PlatformUser | null = null;
  let expired = !idToken;
  if (idToken) {
    try {
      user = await verifyToken(a, idToken);
    } catch (e) {
      expired = isExpiredError(e);
      if (!expired) log.debug('auth: rejected session token', { reason: (e as Error).message });
    }
  }
  if (!user && expired && refresh) {
    try {
      const tokens = await refreshTokens(a, refresh);
      user = await verifyToken(a, tokens.idToken);
      ctx?.cookies.push(...sessionCookies(b, tokens));
    } catch (e) {
      log.debug('auth: refresh failed', { reason: (e as Error).message });
      ctx?.cookies.push(...clearSessionCookies(b));
    }
  }
  if (ctx) ctx.user = user;
  return user;
}

export function unauthorized(): Response {
  return Response.json(
    { error: { code: 'unauthorized', message: 'Sign in required', loginUrl: AUTH_ROUTES.login } },
    { status: 401, headers: { 'cache-control': 'no-store' } },
  );
}

export const auth: Auth = {
  getUser: (request) => resolveUser(request),
  async requireUser(request) {
    const user = await resolveUser(request);
    if (!user) throw unauthorized();
    return user;
  },
  loginUrl: (redirect = '/') => `${AUTH_ROUTES.login}?redirect=${encodeURIComponent(safeRedirect(redirect))}`,
  logoutUrl: (redirect = '/') =>
    `${AUTH_ROUTES.logout}?redirect=${encodeURIComponent(safeRedirect(redirect))}`,
};

/**
 * `auth.required`: redirect signed-out browsers to sign-in and 401 everything
 * else. Returns a Response to short-circuit, or null to continue.
 */
export async function authGate(request: Request): Promise<Response | null> {
  const a = getBindings().auth;
  if (!a?.required) return null;
  if (await resolveUser(request)) return null;
  const url = new URL(request.url);
  const wantsHtml = request.method === 'GET' && (request.headers.get('accept') ?? '').includes('text/html');
  if (wantsHtml) return redirect(auth.loginUrl(url.pathname + url.search));
  return unauthorized();
}

function redirect(location: string, cookies: string[] = [], status = 302): Response {
  const headers = new Headers({ location, 'cache-control': 'no-store' });
  for (const c of cookies) headers.append('set-cookie', c);
  return new Response(null, { status, headers });
}

// ---------------------------------------------------------------- /__platform/auth/*

/** Handles the auth routes; returns null for other paths. */
export async function handleAuthRoute(request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  const route = Object.values(AUTH_ROUTES).find((p) => p === url.pathname);
  if (!route) return null;
  const b = getBindings();
  const a = b.auth;
  if (!a)
    return Response.json({ error: { code: 'not_found', message: 'Auth is not enabled' } }, { status: 404 });

  if (route === AUTH_ROUTES.me) {
    const user = await resolveUser(request);
    return user ? Response.json(user, { headers: { 'cache-control': 'no-store' } }) : unauthorized();
  }
  if (route === AUTH_ROUTES.logout) {
    const back = safeRedirect(url.searchParams.get('redirect'));
    if (a.mode === 'local') return redirect(back, clearSessionCookies(b));
    const target = new URL(`${a.loginUrl.replace(/\/$/, '')}/logout`);
    target.searchParams.set('client_id', a.clientId);
    target.searchParams.set('logout_uri', `${b.url}/`);
    return redirect(target.toString(), clearSessionCookies(b));
  }
  if (a.mode === 'local') return localRoute(request, b, a, route);

  const callbackUrl = `${b.url}${AUTH_ROUTES.callback}`;
  if (route === AUTH_ROUTES.login) {
    const verifier = createVerifier();
    const state = randomState();
    const flow = encodeFlow({ v: verifier, s: state, r: safeRedirect(url.searchParams.get('redirect')) });
    const target = new URL(`${a.loginUrl.replace(/\/$/, '')}/oauth2/authorize`);
    target.search = new URLSearchParams({
      client_id: a.clientId,
      response_type: 'code',
      scope: AUTH_SCOPES.join(' '),
      redirect_uri: callbackUrl,
      state,
      code_challenge: challengeFor(verifier),
      code_challenge_method: 'S256',
    }).toString();
    return redirect(target.toString(), [
      serializeCookie(AUTH_COOKIES.flow, flow, {
        maxAge: FLOW_MAX_AGE,
        secure: secure(b),
        path: '/__platform/auth',
      }),
    ]);
  }
  // callback
  const flow = decodeFlow(parseCookies(request.headers.get('cookie'))[AUTH_COOKIES.flow]);
  const code = url.searchParams.get('code');
  const clearFlow = clearCookie(AUTH_COOKIES.flow, { secure: secure(b), path: '/__platform/auth' });
  if (url.searchParams.get('error')) {
    return redirect(flow?.r ?? '/', [clearFlow]);
  }
  if (!flow || !code || url.searchParams.get('state') !== flow.s) {
    return new Response('Sign-in expired or was tampered with. Please try again.', {
      status: 400,
      headers: { 'set-cookie': clearFlow, 'cache-control': 'no-store' },
    });
  }
  const tokens = await exchangeCode(a, code, flow.v, callbackUrl);
  return redirect(flow.r, [...sessionCookies(b, tokens), clearFlow]);
}

async function localRoute(request: Request, b: Bindings, a: AuthBindings, route: string): Promise<Response> {
  const url = new URL(request.url);
  if (route === AUTH_ROUTES.login && request.method === 'POST') {
    const form = await request.formData();
    const email = String(form.get('email') ?? '')
      .trim()
      .toLowerCase();
    const name = String(form.get('name') ?? '').trim();
    const back = safeRedirect(String(form.get('redirect') ?? '/'));
    if (!/^[^\s@]+@[^\s@]+$/.test(email)) return html(loginPage(b, back, 'Enter an email address.'), 400);
    const tokens = await localSignIn(a, email, name || undefined);
    return redirect(back, sessionCookies(b, tokens), 303);
  }
  if (route === AUTH_ROUTES.login) return html(loginPage(b, safeRedirect(url.searchParams.get('redirect'))));
  // No hosted UI locally; callback is never used.
  return redirect('/');
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function loginPage(b: Bindings, back: string, error?: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in · ${escapeHtml(b.app)} (local)</title>
<style>body{font:16px system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f6f7f9;color:#111}
form{background:#fff;padding:2rem;border-radius:12px;box-shadow:0 1px 3px #0002;display:grid;gap:.75rem;min-width:18rem}
input,button{font:inherit;padding:.6rem .75rem;border-radius:8px;border:1px solid #ccd}button{background:#111;color:#fff;border:0;cursor:pointer}
small{color:#667}.err{color:#b00}</style></head><body>
<form method="post" action="${AUTH_ROUTES.login}">
<strong>Sign in to ${escapeHtml(b.app)}</strong><small>Local development: any email works. Users live in the AWS Emulator.</small>
${error ? `<span class="err">${escapeHtml(error)}</span>` : ''}
<input name="email" type="email" placeholder="you@example.com" required autofocus>
<input name="name" placeholder="Name (optional)">
<input type="hidden" name="redirect" value="${escapeHtml(back)}">
<button type="submit">Sign in</button></form></body></html>`;
}
