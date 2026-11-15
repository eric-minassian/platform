/**
 * Authentication: platform tokens (CLI), console session cookies, and GitHub
 * Actions OIDC tokens (CI). All platform-issued tokens are HS256 JWTs signed
 * with the session key in SSM. Membership is re-checked on every request, so
 * removing someone from `platform.config.ts` revokes access on the next deploy.
 */

import { PLATFORM_DEFAULTS } from '@eric-minassian/platform-core';
import type { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { createRemoteJWKSet, decodeJwt, jwtVerify, SignJWT } from 'jose';
import { ciPrincipalFromClaims, type GithubOidcClaims, memberFor, type Principal } from './authz.ts';
import { config, getSessionKey } from './config.ts';
import { ApiError } from './errors.ts';

export const CONSOLE_COOKIE = '__plat_console';
const ISSUER = 'platform';
const GITHUB_OIDC_ISSUER = 'https://token.actions.githubusercontent.com';
const githubJwks = createRemoteJWKSet(new URL(`${GITHUB_OIDC_ISSUER}/.well-known/jwks`));

export type TokenUse = 'cli' | 'console';

export const TOKEN_TTL_SECONDS: Record<TokenUse, number> = { cli: 30 * 86400, console: 7 * 86400 };

export async function issueToken(
  github: string,
  use: TokenUse,
): Promise<{ token: string; expiresAt: string }> {
  const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS[use];
  const token = await new SignJWT({ use })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(ISSUER)
    .setAudience(`platform-${use}`)
    .setSubject(github)
    .setIssuedAt()
    .setExpirationTime(exp)
    .sign(await getSessionKey());
  return { token, expiresAt: new Date(exp * 1000).toISOString() };
}

async function verifyPlatformToken(token: string, use: TokenUse): Promise<string> {
  const { payload } = await jwtVerify(token, await getSessionKey(), {
    issuer: ISSUER,
    audience: `platform-${use}`,
    algorithms: ['HS256'],
  });
  if (!payload.sub) throw new Error('token has no subject');
  return payload.sub;
}

async function verifyGithubOidc(token: string): Promise<GithubOidcClaims> {
  const { payload } = await jwtVerify(token, githubJwks, {
    issuer: GITHUB_OIDC_ISSUER,
    audience: PLATFORM_DEFAULTS.oidcAudience,
    algorithms: ['RS256'],
  });
  return payload as GithubOidcClaims;
}

/** Dev-only escape hatch, set programmatically by `src/dev.ts` (never by env, so it can't reach Lambda). */
let devUser: string | undefined;
export function setDevAuth(github: string | undefined): void {
  devUser = github;
}

export type AuthVia = 'bearer' | 'cookie' | 'dev';

export async function authenticate(c: Context): Promise<{ principal: Principal; via: AuthVia } | null> {
  if (devUser) {
    const m = memberFor(config, devUser);
    return m ? { principal: m, via: 'dev' } : null;
  }
  const header = c.req.header('authorization');
  const bearer = header?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (bearer) {
    let iss: string | undefined;
    try {
      iss = decodeJwt(bearer).iss;
    } catch {
      throw new ApiError(401, 'unauthenticated', 'malformed bearer token');
    }
    if (iss === GITHUB_OIDC_ISSUER) {
      const claims = await verifyGithubOidc(bearer).catch((e: Error) => {
        throw new ApiError(401, 'unauthenticated', `invalid GitHub OIDC token: ${e.message}`);
      });
      const ci = ciPrincipalFromClaims(claims);
      if (!ci) throw new ApiError(401, 'unauthenticated', 'GitHub OIDC token is missing repository claims');
      return { principal: ci, via: 'bearer' };
    }
    const github = await verifyPlatformToken(bearer, 'cli').catch(() => {
      throw new ApiError(401, 'unauthenticated', 'invalid or expired platform token; run `plat login`');
    });
    const member = memberFor(config, github);
    if (!member) throw new ApiError(403, 'not_a_member', `${github} is not a platform member`);
    return { principal: member, via: 'bearer' };
  }
  const cookie = getCookie(c, CONSOLE_COOKIE);
  if (cookie) {
    const github = await verifyPlatformToken(cookie, 'console').catch(() => null);
    const member = github ? memberFor(config, github) : null;
    if (member) return { principal: member, via: 'cookie' };
  }
  return null;
}

/** Header the console sends on every request; cross-site forms can't set it (CSRF guard). */
export const CSRF_HEADER = 'x-platform-csrf';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export type AuthEnv = { Variables: { principal: Principal } };

/** Requires some principal; routes narrow to members/CI as needed. */
export const requireAuth: MiddlewareHandler<AuthEnv> = async (c, next) => {
  const auth = await authenticate(c);
  if (!auth) throw new ApiError(401, 'unauthenticated', 'sign in at the console or run `plat login`');
  if (auth.via === 'cookie' && !SAFE_METHODS.has(c.req.method) && c.req.header(CSRF_HEADER) !== '1') {
    throw new ApiError(403, 'csrf', `cookie-authenticated writes need the ${CSRF_HEADER} header`);
  }
  c.set('principal', auth.principal);
  await next();
};

export function requireMember(c: Context<AuthEnv>) {
  const p = c.get('principal');
  if (p.kind !== 'member') throw new ApiError(403, 'members_only', 'this endpoint needs a member token');
  return p;
}

export function requireAdmin(c: Context<AuthEnv>) {
  const p = requireMember(c);
  if (p.role !== 'admin') throw new ApiError(403, 'admins_only', 'this endpoint is for platform admins');
  return p;
}
