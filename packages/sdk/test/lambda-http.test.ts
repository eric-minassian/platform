import { Writable } from 'node:stream';
import { ORIGIN_HEADER, originSecret } from '@ericminassian/platform-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FunctionUrlEvent, LambdaStreaming, ResponsePrelude } from '../src/runtime/lambda-http.ts';
import { requestModeHandler } from '../src/runtime/server.ts';
import { captureTelemetry, resetPlatform, useTestBindings } from '../src/testing.ts';

/**
 * The Lambda runtime's response streaming, as far as the handler can tell: like the real one, it
 * only sends the prelude with the first write.
 */
function fakeStreaming() {
  const sent: Array<{ prelude?: ResponsePrelude; body: Buffer }> = [];
  const streaming: LambdaStreaming = {
    streamifyResponse: (handler) => handler,
    HttpResponseStream: {
      from: (_stream, prelude) => {
        const response: { prelude?: ResponsePrelude; body: Buffer } = { body: Buffer.alloc(0) };
        sent.push(response);
        return new Writable({
          write(chunk: Buffer | string, _encoding, done) {
            response.prelude ??= prelude;
            response.body = Buffer.concat([response.body, Buffer.from(chunk)]);
            done();
          },
        });
      },
    },
  };
  return { streaming, sent };
}

const event = (over: Partial<FunctionUrlEvent> & { method?: string } = {}): FunctionUrlEvent => ({
  rawPath: '/api/echo',
  rawQueryString: 'a=1&a=2',
  headers: { host: 'abc.lambda-url.us-east-1.on.aws', 'x-platform-host': 'todo.example.com' },
  requestContext: {
    domainName: 'abc.lambda-url.us-east-1.on.aws',
    http: { method: over.method ?? 'GET' },
  },
  ...over,
});

describe('request mode', () => {
  let tel: ReturnType<typeof captureTelemetry>;
  let secret: string;
  beforeEach(async () => {
    const bindings = useTestBindings({ url: 'https://todo.example.com', host: 'todo.example.com' });
    secret = await originSecret(bindings.stageKey!);
    tel = captureTelemetry();
  });
  afterEach(() => {
    tel.stop();
    resetPlatform();
  });

  const fromEdge = (headers: Record<string, string> = {}) => ({
    host: 'abc.lambda-url.us-east-1.on.aws',
    'x-platform-host': 'todo.example.com',
    [ORIGIN_HEADER]: secret,
    ...headers,
  });

  it('turns the function URL event into the request the app sees', async () => {
    let seen: Request | undefined;
    let body: string | undefined;
    const { streaming } = fakeStreaming();
    const handler = requestModeHandler(async (req) => {
      seen = req;
      body = await req.text();
      return new Response('ok');
    }, streaming);

    await handler(
      event({
        method: 'POST',
        headers: fromEdge({ 'content-type': 'application/json', accept: 'a/b, c/d' }),
        cookies: ['session=s1', 'theme=dark'],
        body: Buffer.from('{"title":"ü"}').toString('base64'),
        isBase64Encoded: true,
      }),
      new Writable(),
      {},
    );
    expect(seen?.method).toBe('POST');
    // The public URL, from the router's host header, with the query string as sent.
    expect(seen?.url).toBe('https://todo.example.com/api/echo?a=1&a=2');
    expect(seen?.headers.get('cookie')).toBe('session=s1; theme=dark');
    expect(seen?.headers.get('accept')).toBe('a/b, c/d');
    expect(body).toBe('{"title":"ü"}');
    // The secret never reaches app code.
    expect(seen?.headers.has(ORIGIN_HEADER)).toBe(false);
  });

  it('streams status, headers, cookies and a binary body back', async () => {
    const { streaming, sent } = fakeStreaming();
    const bytes = new Uint8Array([0, 255, 1, 254, 10, 13]);
    const handler = requestModeHandler(() => {
      const headers = new Headers({ 'content-type': 'application/octet-stream', vary: 'accept' });
      headers.append('vary', 'cookie');
      headers.append('set-cookie', 'a=1; Path=/; HttpOnly');
      headers.append('set-cookie', 'b=2; Path=/');
      return new Response(bytes, { status: 201, headers });
    }, streaming);

    await handler(event({ headers: fromEdge() }), new Writable(), {});
    const [res] = sent;
    expect(res?.prelude?.statusCode).toBe(201);
    expect(res?.prelude?.headers).toMatchObject({
      'content-type': 'application/octet-stream',
      vary: 'accept, cookie',
    });
    expect(res?.prelude?.headers['set-cookie']).toBeUndefined();
    expect(res?.prelude?.cookies).toEqual(['a=1; Path=/; HttpOnly', 'b=2; Path=/']);
    expect(new Uint8Array(res!.body)).toEqual(bytes);
  });

  it('sends the status of a response without a body', async () => {
    const { streaming, sent } = fakeStreaming();
    const handler = requestModeHandler(() => new Response(null, { status: 204 }), streaming);
    await handler(event({ headers: fromEdge() }), new Writable(), {});
    expect(sent[0]?.prelude?.statusCode).toBe(204);
    expect(sent[0]?.body.length).toBe(0);
  });

  it('answers 403 to requests that did not come through the router, before any app code', async () => {
    const { streaming, sent } = fakeStreaming();
    let called = false;
    const handler = requestModeHandler(() => {
      called = true;
      return new Response('ok');
    }, streaming);

    await handler(event(), new Writable(), {});
    await handler(
      event({ headers: fromEdge({ [ORIGIN_HEADER]: `${secret.slice(0, -1)}x` }) }),
      new Writable(),
      {},
    );
    await handler(event({ headers: fromEdge({ [ORIGIN_HEADER]: 'short' }) }), new Writable(), {});
    expect(called).toBe(false);
    expect(sent.map((r) => r.prelude?.statusCode)).toEqual([403, 403, 403]);
    expect(sent[0]?.body.toString()).toBe('Forbidden');
    expect(tel.events.filter((e) => e.t === 'req')).toEqual([]);

    await handler(event({ headers: fromEdge() }), new Writable(), {});
    expect(called).toBe(true);
  });

  it('reports its start, and its first request as cold', async () => {
    const { streaming } = fakeStreaming();
    const handler = requestModeHandler(() => new Response('ok'), streaming);
    expect(tel.events.find((e) => e.t === 'env')).toMatchObject({
      event: 'start',
      runtime: 'web',
      compute: 'request',
    });
    await handler(event({ headers: fromEdge() }), new Writable(), {});
    await handler(event({ headers: fromEdge() }), new Writable(), {});
    const reqs = tel.events.filter((e) => e.t === 'req');
    expect(reqs).toHaveLength(2);
    expect(reqs[0]).toMatchObject({ route: '/api/echo', status: 200 });
    expect(reqs[1]).not.toHaveProperty('cold');
  });

  it('refuses to run outside Lambda’s streaming runtime', () => {
    expect(() => requestModeHandler(() => new Response('ok'), undefined)).toThrow(/response streaming/);
  });
});
