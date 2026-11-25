import {
  APP_CONFIG_FILE,
  AUTH_COOKIES,
  AUTH_ROUTES,
  AUTH_SCOPES,
  type AuthBindings,
  type Bindings,
  loginPath,
  type PlatformUser,
  safeRedirect,
  UNAUTHORIZED_BODY,
} from '@ericminassian/platform-core';
import { getBindings } from '../bindings.ts';
import { currentContext } from '../context.ts';
import { log } from '../telemetry.ts';
import { clearCookie, parseCookies, serializeCookie } from './cookies.ts';
import { challengeFor, createVerifier, decodeFlow, encodeFlow, randomState } from './pkce.ts';
import {
  exchangeCode,
  isExpiredError,
  localSignIn,
  refreshTokens,
  type Tokens,
  verifyToken,
} from './tokens.ts';

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
  return Response.json(UNAUTHORIZED_BODY, { status: 401, headers: { 'cache-control': 'no-store' } });
}

/** The signed-in user for this request (session cookie or bearer ID token), or null. */
export const getUser = (request: Request): Promise<PlatformUser | null> => resolveUser(request);

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
  if (wantsHtml) return redirect(loginPath(url.pathname + url.search));
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
    // The login page's form posts application/x-www-form-urlencoded.
    const form = new URLSearchParams(await request.text());
    const email = (form.get('email') ?? '').trim().toLowerCase();
    const name = (form.get('name') ?? '').trim();
    const back = safeRedirect(form.get('redirect') ?? '/');
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

/**
 * `plat dev`'s stand-in for managed login, in the same style (the engine's
 * `login-branding.ts`): the app's name over a form without a card, the
 * console's greys, and the device's light or dark mode.
 */
function loginPage(b: Bindings, back: string, error?: string): string {
  const app = escapeHtml(b.app);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><title>Sign in · ${app} (local)</title>
<style>:root{color-scheme:light dark;--bg:light-dark(#fff,#0a0a0a);--fg:light-dark(#171717,#ededed);--muted:light-dark(#5f5f5f,#a1a1a1);--input:light-dark(#00000029,#ffffff2e);--ring:light-dark(#0068d6,#52a8ff);--bad:light-dark(#cd2b31,#ff6166)}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}
form{display:grid;gap:1rem;width:min(22rem,100vw - 2rem)}
.app{margin:0 0 1rem;text-align:center;font-size:2.25rem;font-weight:600;letter-spacing:-.02em;line-height:1.2}
h1{margin:0;font-size:1.5rem;line-height:1.2}p{margin:-.5rem 0 0;color:var(--muted)}.err{margin:0;color:var(--bad)}
label{display:grid;gap:.25rem;font-weight:600;font-size:.9375rem}
input{font:inherit;font-weight:400;padding:.375rem .75rem;border:1px solid var(--input);border-radius:6px;background:var(--bg);color:inherit}
input:focus{outline:2px solid var(--ring);outline-offset:-2px}
button{font:inherit;font-weight:600;padding:.375rem;border:0;border-radius:6px;background:var(--fg);color:var(--bg);cursor:pointer}</style></head><body>
<form method="post" action="${AUTH_ROUTES.login}">
<div class="app">${app}</div><h1>Sign in</h1><p>Local development: any email works. Users live in the AWS Emulator.</p>
${error ? `<p class="err" role="alert">${escapeHtml(error)}</p>` : ''}
<label>Email address<input name="email" type="email" placeholder="you@example.com" required autofocus></label>
<label>Name (optional)<input name="name"></label>
<input type="hidden" name="redirect" value="${escapeHtml(back)}">
<button type="submit">Sign in</button></form></body></html>`;
}
