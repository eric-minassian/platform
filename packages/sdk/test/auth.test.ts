import { safeRedirect } from '@ericminassian/platform-core';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loginUrl, logoutUrl } from '../src/api.ts';
import { parseCookies, serializeCookie } from '../src/runtime/auth/cookies.ts';
import { getUser, unauthorized } from '../src/runtime/auth/index.ts';
import { challengeFor, decodeFlow, encodeFlow } from '../src/runtime/auth/pkce.ts';
import { acceptedIssuers } from '../src/runtime/auth/tokens.ts';
import { captureTelemetry, createPlatformFetch, resetPlatform, useTestBindings } from '../src/testing.ts';

describe('cookie + pkce helpers', () => {
  it('parses and serializes cookies', () => {
    expect(parseCookies('a=1; b=hello%20world; a=2; bad')).toEqual({ a: '1', b: 'hello world' });
    expect(serializeCookie('x', 'v v', { maxAge: 10, secure: true })).toBe(
      'x=v%20v; Path=/; Max-Age=10; HttpOnly; Secure; SameSite=Lax',
    );
  });

  it('computes the S256 challenge as base64url(sha256(verifier))', async () => {
    const verifier = 'dBjftJeZ4CVP-mJ92K9WdkTTu6tLiGb6UqxCC6XqP2c';
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    expect(challengeFor(verifier)).toBe(Buffer.from(digest).toString('base64url'));
    expect(challengeFor(verifier)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('round-trips flow state and only allows same-origin redirects', () => {
    expect(decodeFlow(encodeFlow({ v: 'a', s: 'b', r: '/x' }))).toEqual({ v: 'a', s: 'b', r: '/x' });
    expect(decodeFlow('garbage')).toBeNull();
    expect(safeRedirect('/ok?a=1')).toBe('/ok?a=1');
    expect(safeRedirect('//evil.com')).toBe('/');
    expect(safeRedirect('https://evil.com')).toBe('/');
    expect(safeRedirect('/\\evil')).toBe('/');
    expect(safeRedirect('/\t/evil.com')).toBe('/');
    expect(safeRedirect('/\n/evil.com')).toBe('/');
    expect(safeRedirect(' /x')).toBe('/');
  });
});

describe('token issuers', () => {
  const pool = 'us-east-1_abc';
  const cognito = `https://cognito-idp.us-east-1.amazonaws.com/${pool}`;

  it('takes only Cognito in AWS', () => {
    expect(
      acceptedIssuers({ mode: 'cognito', issuer: cognito, jwksUri: `${cognito}/.well-known/jwks.json` }),
    ).toBe(cognito);
  });

  it("takes Cognito's or the emulator's own issuer locally", () => {
    const emulator = `https://127.0.0.1:4566/${pool}`;
    expect(
      acceptedIssuers({ mode: 'local', issuer: cognito, jwksUri: `${emulator}/.well-known/jwks.json` }),
    ).toEqual([cognito, emulator]);
  });
});

describe('cognito hosted-login flow', () => {
  const ISSUER = 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_test';
  const JWKS = `${ISSUER}/.well-known/jwks.json`;
  const LOGIN = 'https://login.example.com';
  let privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
  let jwk: Record<string, unknown>;
  const realFetch = globalThis.fetch;
  const tokenCalls: URLSearchParams[] = [];
  let nextIdToken = '';
  let tel: ReturnType<typeof captureTelemetry>;

  const sign = (claims: Record<string, unknown>, expSeconds: number) =>
    new SignJWT({
      token_use: 'id',
      email: 'eric@example.com',
      name: 'Eric',
      'cognito:groups': ['todo:admin'],
      ...claims,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(ISSUER)
      .setAudience('client123')
      .setSubject('user-1')
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + expSeconds)
      .sign(privateKey);

  beforeAll(async () => {
    const pair = await generateKeyPair('RS256');
    privateKey = pair.privateKey;
    jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === JWKS) return Response.json({ keys: [jwk] });
      if (url === `${LOGIN}/oauth2/token`) {
        tokenCalls.push(new URLSearchParams(init?.body as URLSearchParams));
        return Response.json({ id_token: nextIdToken, refresh_token: 'refresh-1', access_token: 'a' });
      }
      return realFetch(input, init);
    };
  });
  afterAll(() => {
    globalThis.fetch = realFetch;
  });
  beforeEach(() => {
    tokenCalls.length = 0;
    tel = captureTelemetry();
    useTestBindings({
      url: 'https://todo.example.com',
      auth: {
        mode: 'cognito',
        userPoolId: 'us-east-1_test',
        clientId: 'client123',
        issuer: ISSUER,
        jwksUri: JWKS,
        loginUrl: LOGIN,
        required: false,
      },
    });
  });
  afterEach(() => {
    tel.stop();
    resetPlatform();
  });

  const cookieHeader = (res: Response) =>
    res.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');

  it('signs in with PKCE, sets session cookies and resolves the user', async () => {
    const f = createPlatformFetch((req) => getUser(req).then((u) => (u ? Response.json(u) : unauthorized())));
    const login = await f(new Request('https://todo.example.com/__platform/auth/login?redirect=/dash'));
    expect(login.status).toBe(302);
    const location = new URL(login.headers.get('location')!);
    expect(location.origin + location.pathname).toBe(`${LOGIN}/oauth2/authorize`);
    expect(location.searchParams.get('redirect_uri')).toBe(
      'https://todo.example.com/__platform/auth/callback',
    );
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');
    const flowCookie = login.headers.getSetCookie()[0]!;
    expect(flowCookie).toMatch(/^__plat_flow=.*HttpOnly; Secure; SameSite=Lax$/);

    // Wrong state is rejected.
    const bad = await f(
      new Request('https://todo.example.com/__platform/auth/callback?code=c&state=wrong', {
        headers: { cookie: cookieHeader(login) },
      }),
    );
    expect(bad.status).toBe(400);

    nextIdToken = await sign({}, 3600);
    const cb = await f(
      new Request(
        `https://todo.example.com/__platform/auth/callback?code=the-code&state=${location.searchParams.get('state')}`,
        {
          headers: { cookie: cookieHeader(login) },
        },
      ),
    );
    expect(cb.status).toBe(302);
    expect(cb.headers.get('location')).toBe('/dash');
    expect(tokenCalls[0]?.get('grant_type')).toBe('authorization_code');
    expect(tokenCalls[0]?.get('code_verifier')).toBeTruthy();
    const session = cookieHeader(cb);
    expect(session).toContain('__plat_id=');
    expect(session).toContain('__plat_rt=refresh-1');

    const me = await f(
      new Request('https://todo.example.com/__platform/auth/me', { headers: { cookie: session } }),
    );
    expect(await me.json()).toEqual({
      id: 'user-1',
      email: 'eric@example.com',
      name: 'Eric',
      groups: ['todo:admin'],
    });
    const app = await f(new Request('https://todo.example.com/anything', { headers: { cookie: session } }));
    expect(((await app.json()) as { id: string }).id).toBe('user-1');
    expect(tel.events.find((e) => e.t === 'req' && e.route === '/anything')).toHaveProperty('user');
  });

  it('refreshes an expired id token and sets the new cookie on the response', async () => {
    const expired = await sign({}, -60);
    nextIdToken = await sign({}, 3600);
    const f = createPlatformFetch((req) => getUser(req).then((u) => Response.json({ user: u?.id ?? null })));
    const res = await f(
      new Request('https://todo.example.com/x', {
        headers: { cookie: `__plat_id=${expired}; __plat_rt=r0` },
      }),
    );
    expect(await res.json()).toEqual({ user: 'user-1' });
    expect(tokenCalls[0]?.get('grant_type')).toBe('refresh_token');
    expect(res.headers.getSetCookie().some((c) => c.startsWith('__plat_id='))).toBe(true);
  });

  it('rejects tokens for another client and logs out to the hosted logout', async () => {
    const other = await new SignJWT({ token_use: 'id' })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(ISSUER)
      .setAudience('someone-else')
      .setSubject('u')
      .setExpirationTime('1h')
      .sign(privateKey);
    const f = createPlatformFetch(() => new Response('x'));
    expect(
      (
        await f(
          new Request('https://todo.example.com/__platform/auth/me', {
            headers: { cookie: `__plat_id=${other}` },
          }),
        )
      ).status,
    ).toBe(401);
    const out = await f(new Request('https://todo.example.com/__platform/auth/logout'));
    expect(out.headers.get('location')).toBe(
      `${LOGIN}/logout?client_id=client123&logout_uri=${encodeURIComponent('https://todo.example.com/')}`,
    );
    expect(out.headers.getSetCookie().every((c) => c.includes('Max-Age=0'))).toBe(true);
  });

  it('builds login/logout paths', () => {
    expect(loginUrl('/a?b=1')).toBe('/__platform/auth/login?redirect=%2Fa%3Fb%3D1');
    expect(logoutUrl('//evil')).toBe('/__platform/auth/logout?redirect=%2F');
  });
});
