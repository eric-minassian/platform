import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DEV_UPLOAD_PATH } from '@ericminassian/platform-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { localRouteRecord, startLocalRouter } from '../src/dev/router.ts';
import { allowedOrigin, relayUpload } from '../src/dev/upload-relay.ts';

const record = localRouteRecord({
  app: 'shop',
  stage: 'local',
  deploymentId: 'd1',
  hasServer: true,
  hasStatic: false,
  serverRoutes: ['/api/'],
  spa: false,
});

describe('plat dev upload relay', () => {
  let emulator: Server;
  let router: Server;
  let base: string;
  let endpoint: string;
  let port: number;
  const received: Array<{ url: string; headers: IncomingHttpHeaders; body: string }> = [];

  beforeAll(async () => {
    // Stands in for the emulator's S3: records what reached it and answers like a PUT.
    emulator = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      req.on('end', () => {
        received.push({ url: req.url ?? '', headers: req.headers, body });
        const status = req.url?.includes('fail') ? 403 : 200;
        res.writeHead(status, { etag: '"abc"', 'x-amz-request-id': 'r1', 'set-cookie': 'x=1' }).end();
      });
    });
    await new Promise<void>((r) => emulator.listen(0, '127.0.0.1', r));
    endpoint = `http://127.0.0.1:${(emulator.address() as AddressInfo).port}`;

    router = await startLocalRouter({
      port: 0,
      state: () => ({ record }),
      intercept: [
        async (req, res, url) => {
          if (url.pathname !== DEV_UPLOAD_PATH) return false;
          await relayUpload(req, res, url, { endpoint, port });
          return true;
        },
      ],
    });
    port = (router.address() as AddressInfo).port;
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    router?.close();
    emulator?.close();
  });

  const relayUrl = (to: string) => `${base}${DEV_UPLOAD_PATH}?to=${encodeURIComponent(to)}`;
  const signed = () =>
    `${endpoint}/storage-bucket/app/local/covers/a.png?X-Amz-Signature=s1&X-Amz-Expires=900`;

  it('forwards the upload to the presigned URL without the browser’s headers', async () => {
    const origin = `http://shop.localhost:${port}`;
    const res = await fetch(relayUrl(signed()), {
      method: 'PUT',
      headers: { origin, 'content-type': 'image/png', cookie: 'session=1', referer: `${origin}/x` },
      body: 'png-bytes',
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe(origin);
    expect(res.headers.get('etag')).toBe('"abc"');
    expect(res.headers.get('set-cookie')).toBeNull();

    const got = received.at(-1)!;
    expect(got.url).toBe('/storage-bucket/app/local/covers/a.png?X-Amz-Signature=s1&X-Amz-Expires=900');
    expect(got.body).toBe('png-bytes');
    expect(got.headers['content-type']).toBe('image/png');
    expect(got.headers.host).toBe(new URL(endpoint).host);
    for (const dropped of ['origin', 'cookie', 'referer']) expect(got.headers).not.toHaveProperty(dropped);
  });

  it('passes the emulator’s answer through', async () => {
    const res = await fetch(relayUrl(`${endpoint}/storage-bucket/fail.png?X-Amz-Signature=s2`), {
      method: 'PUT',
      body: 'x',
    });
    expect(res.status).toBe(403);
  });

  it('relays only presigned URLs on the emulator', async () => {
    const before = received.length;
    for (const to of ['https://example.com/steal?X-Amz-Signature=s', 'not a url']) {
      const res = await fetch(relayUrl(to), { method: 'PUT', body: 'x' });
      expect(res.status).toBe(400);
    }
    expect((await fetch(`${base}${DEV_UPLOAD_PATH}`, { method: 'PUT', body: 'x' })).status).toBe(400);
    expect(received.length).toBe(before);
  });

  it('answers preflights from the app’s local hosts only', async () => {
    const preflight = (origin: string) =>
      fetch(relayUrl(signed()), {
        method: 'OPTIONS',
        headers: {
          origin,
          'access-control-request-method': 'PUT',
          'access-control-request-headers': 'content-type',
        },
      });
    const ok = await preflight(`http://localhost:${port}`);
    expect(ok.status).toBe(204);
    expect(ok.headers.get('access-control-allow-origin')).toBe(`http://localhost:${port}`);
    expect(ok.headers.get('access-control-allow-methods')).toBe('PUT');
    expect(ok.headers.get('access-control-allow-headers')).toBe('content-type');
    expect((await preflight('https://evil.example')).status).toBe(403);
    expect((await preflight('http://localhost:1')).status).toBe(403);
  });

  it('refuses other origins and methods', async () => {
    const put = await fetch(relayUrl(signed()), {
      method: 'PUT',
      headers: { origin: 'https://evil.example' },
      body: 'x',
    });
    expect(put.status).toBe(403);
    expect((await fetch(relayUrl(signed()))).status).toBe(405);
  });

  it('allows localhost and its subdomains at the router’s port', () => {
    expect(allowedOrigin('http://localhost:3000', 3000)).toBe('http://localhost:3000');
    expect(allowedOrigin('http://shop--pr-1.localhost:3000', 3000)).toBe('http://shop--pr-1.localhost:3000');
    expect(allowedOrigin('http://localhost:3001', 3000)).toBeUndefined();
    expect(allowedOrigin('https://localhost:3000', 3000)).toBeUndefined();
    expect(allowedOrigin('http://localhost.evil.com:3000', 3000)).toBeUndefined();
    expect(allowedOrigin(undefined, 3000)).toBeUndefined();
  });
});
