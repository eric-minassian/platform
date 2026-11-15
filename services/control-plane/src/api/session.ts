/**
 * Sign-in: `POST /v1/auth/cli` (exchange a GitHub token for a platform token)
 * and the console's GitHub OAuth round trip under `/auth/github/*`.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { CliLoginRequest, CliLoginResponse, MeResponse } from '@ericminassian/platform-core';
import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import {
  type AuthEnv,
  CONSOLE_COOKIE,
  issueToken,
  requireAuth,
  requireMember,
  TOKEN_TTL_SECONDS,
} from '../auth.ts';
import { memberFor } from '../authz.ts';
import { config, consoleUrl, getGithubApp } from '../config.ts';
import { ApiError, badRequest } from '../errors.ts';
import { authorizeUrl, exchangeCode, githubLogin } from '../github.ts';
import { readJson } from './context.ts';

const OAUTH_COOKIE = '__plat_oauth';

/** Only same-origin relative paths are allowed as post-login redirects. */
export function safeRedirect(path: string | undefined): string {
  return path?.startsWith('/') && !path.startsWith('//') && !path.includes('\\') ? path : '/';
}

export const cliAuth = new Hono<AuthEnv>()
  .post('/auth/cli', async (c) => {
    const body = await readJson<CliLoginRequest>(c);
    if (!body.githubToken) throw badRequest('githubToken is required');
    let github: string;
    try {
      github = await githubLogin(body.githubToken);
    } catch (err) {
      throw new ApiError(401, 'unauthenticated', err instanceof Error ? err.message : String(err));
    }
    const member = memberFor(config, github);
    if (!member) {
      throw new ApiError(
        403,
        'not_a_member',
        `${github} is not invited. Ask an admin to add you to platform.config.ts.`,
      );
    }
    const { token, expiresAt } = await issueToken(member.github, 'cli');
    const res: CliLoginResponse = { token, github: member.github, role: member.role, expiresAt };
    return c.json(res);
  })
  .get('/me', requireAuth, (c) => {
    const me = requireMember(c);
    const res: MeResponse = { github: me.github, role: me.role };
    return c.json(res);
  });

export const consoleAuth = new Hono()
  .get('/github/login', async (c) => {
    const app = await getGithubApp();
    if (!app) return c.text('GitHub sign-in is not configured yet (see docs/SETUP.md).', 503);
    const state = randomBytes(16).toString('hex');
    const redirect = safeRedirect(c.req.query('redirect'));
    setCookie(c, OAUTH_COOKIE, `${state}|${redirect}`, {
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      path: '/auth/github',
      maxAge: 600,
    });
    return c.redirect(authorizeUrl(app, `${consoleUrl()}/auth/github/callback`, state));
  })
  .get('/github/callback', async (c) => {
    const app = await getGithubApp();
    if (!app) return c.text('GitHub sign-in is not configured.', 503);
    const [expected, redirect] = (getCookie(c, OAUTH_COOKIE) ?? '').split('|');
    const state = c.req.query('state') ?? '';
    deleteCookie(c, OAUTH_COOKIE, { path: '/auth/github' });
    if (
      !expected ||
      expected.length !== state.length ||
      !timingSafeEqual(Buffer.from(expected), Buffer.from(state))
    ) {
      return c.text('Sign-in expired or was tampered with. Try again.', 400);
    }
    const code = c.req.query('code');
    if (!code) return c.text('GitHub did not return a code.', 400);
    let github: string;
    try {
      github = await githubLogin(await exchangeCode(app, code, `${consoleUrl()}/auth/github/callback`));
    } catch (err) {
      return c.text(`GitHub sign-in failed: ${err instanceof Error ? err.message : String(err)}`, 502);
    }
    const member = memberFor(config, github);
    if (!member) return c.redirect(`/login?denied=${encodeURIComponent(github)}`);
    const { token } = await issueToken(member.github, 'console');
    setCookie(c, CONSOLE_COOKIE, token, {
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: TOKEN_TTL_SECONDS.console,
    });
    return c.redirect(safeRedirect(redirect));
  })
  .post('/logout', (c) => {
    deleteCookie(c, CONSOLE_COOKIE, { path: '/' });
    return c.body(null, 204);
  });
