import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setRoute } from '../src/context.ts';
import { createNodeServer, parseEndpoint } from '../src/http.ts';
import { normalizePath } from '../src/server.ts';
import { captureTelemetry, createPlatformFetch, resetPlatform, useTestBindings } from '../src/testing.ts';

const AUTH = {
  mode: 'cognito' as const,
  userPoolId: 'us-east-1_pool',
  clientId: 'client123',
  issuer: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_pool',
  jwksUri: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_pool/.well-known/jwks.json',
  loginUrl: 'https://login.example.com',
  required: false,
};

function app() {
  const h = new Hono();
  h.get('/api/todos/:id', (c) => c.json({ id: c.req.param('id'), url: c.req.url }));
  h.get('/api/cached', (c) => c.text('ok', 200, { 'cache-control': 'public, max-age=60' }));
  h.get('/api/boom', () => {
    throw new Error('kaboom 42');
  });
  h.get('/api/teapot', () => {
    throw new Response('short and stout', { status: 418 });
  });
  h.get('/api/bad', (c) => c.text('upstream down', 503));
  return h;
}

describe('createPlatformFetch', () => {
  let tel: ReturnType<typeof captureTelemetry>;
  beforeEach(() => {
    useTestBindings({
      url: 'https://todo.example.com',
      host: 'todo.example.com',
      app: 'todo',
      stage: 'prod',
      revision: 'd1',
    });
    tel = captureTelemetry();
  });
  afterEach(() => {
    tel.stop();
    resetPlatform();
  });

  it('serves health, propagates trace and records the route pattern', async () => {
    const f = createPlatformFetch(app());
    const health = await f(new Request('http://127.0.0.1:8080/__platform/health'));
    expect(await health.json()).toEqual({ ok: true, app: 'todo', stage: 'prod', revision: 'd1' });

    const trace = 'c'.repeat(32);
    const res = await f(
      new Request('http://127.0.0.1:8080/api/todos/42', { headers: { 'x-platform-trace': trace } }),
    );
    expect(res.headers.get('x-platform-trace')).toBe(trace);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(await res.json()).toEqual({ id: '42', url: 'https://todo.example.com/api/todos/42' });
    const req = tel.events.filter((e) => e.t === 'req').at(-1);
    expect(req).toMatchObject({
      method: 'GET',
      route: '/api/todos/:id',
      path: '/api/todos/42',
      status: 200,
      trace,
      app: 'todo',
    });
  });

  it('honors x-platform-host for the public URL and keeps app cache headers', async () => {
    const f = createPlatformFetch(app());
    const res = await f(
      new Request('http://x/api/todos/1', { headers: { 'x-platform-host': 'todo--pr-3.example.com' } }),
    );
    expect(((await res.json()) as { url: string }).url).toBe('https://todo--pr-3.example.com/api/todos/1');
    const cached = await f(new Request('http://x/api/cached'));
    expect(cached.headers.get('cache-control')).toBe('public, max-age=60');
  });

  it('turns thrown errors into 500s with telemetry and passes thrown Responses through', async () => {
    const f = createPlatformFetch(app());
    const res = await f(new Request('http://x/api/boom'));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { trace: string } };
    expect(body.error.trace).toMatch(/^[0-9a-f]{32}$/);
    expect(tel.events.find((e) => e.t === 'err')).toMatchObject({
      source: 'http',
      message: 'kaboom 42',
      route: '/api/boom',
    });

    const tea = await f(new Request('http://x/api/teapot'));
    expect(tea.status).toBe(418);
    expect(await tea.text()).toBe('short and stout');
  });

  it('records 5xx responses as errors', async () => {
    const f = createPlatformFetch(app());
    expect((await f(new Request('http://x/api/bad'))).status).toBe(503);
    expect(tel.events.find((e) => e.t === 'err')).toMatchObject({ name: 'HttpError', route: '/api/bad' });
  });

  it('supports bare functions, setRoute and unknown platform paths', async () => {
    const f = createPlatformFetch((req) => {
      setRoute('/custom/:x');
      return new Response(new URL(req.url).pathname);
    });
    expect(await (await f(new Request('http://x/custom/abc'))).text()).toBe('/custom/abc');
    expect(tel.events.find((e) => e.t === 'req')).toMatchObject({ route: '/custom/:x' });
    expect((await f(new Request('http://x/__platform/nope'))).status).toBe(404);
  });

  it('gates every app route when auth is required', async () => {
    useTestBindings({ url: 'https://todo.example.com', auth: { ...AUTH, required: true } });
    const f = createPlatformFetch(app());
    const html = await f(new Request('http://x/settings?tab=1', { headers: { accept: 'text/html' } }));
    expect(html.status).toBe(302);
    expect(html.headers.get('location')).toBe('/__platform/auth/login?redirect=%2Fsettings%3Ftab%3D1');
    const api = await f(new Request('http://x/api/todos/1'));
    expect(api.status).toBe(401);
    // Platform routes stay open.
    expect((await f(new Request('http://x/__platform/health'))).status).toBe(200);
    expect((await f(new Request('http://x/__platform/auth/me'))).status).toBe(401);
  });
});

describe('normalizePath', () => {
  it('replaces id-like segments', () => {
    expect(normalizePath('/api/todos/42')).toBe('/api/todos/:id');
    expect(normalizePath('/u/0b8f1a2e-1111-4222-8333-944445555666/x')).toBe('/u/:id/x');
    expect(normalizePath('/d/d01jabcdefghjkmnpqrstvwxyz')).toBe('/d/:id');
    expect(normalizePath('/api/settings')).toBe('/api/settings');
  });
});

describe('node http adapter', () => {
  it('streams bodies and keeps multiple Set-Cookie headers', async () => {
    const server = createNodeServer(async (req) => {
      const body = await req.text();
      const headers = new Headers({ 'content-type': 'text/plain' });
      headers.append('set-cookie', 'a=1; Path=/');
      headers.append('set-cookie', 'b=2; Path=/');
      return new Response(`${req.method} ${new URL(req.url).pathname} ${body}`, { status: 201, headers });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/echo?x=1`, { method: 'POST', body: 'hello' });
    expect(res.status).toBe(201);
    expect(await res.text()).toBe('POST /echo hello');
    expect(res.headers.getSetCookie()).toEqual(['a=1; Path=/', 'b=2; Path=/']);
    server.close();
  });

  it('parses listen endpoints', () => {
    expect(parseEndpoint('127.0.0.1:9001')).toEqual({ host: '127.0.0.1', port: 9001 });
    expect(parseEndpoint('[::1]:80')).toEqual({ host: '::1', port: 80 });
    expect(() => parseEndpoint('nope')).toThrow();
  });
});
