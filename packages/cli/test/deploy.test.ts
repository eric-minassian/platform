import type { DeploymentRecord } from '@ericminassian/platform-core';
import { describe, expect, it } from 'vitest';
import { ApiClient, ApiError } from '../src/api.ts';
import { presignedPostForm, waitForDeployment } from '../src/deploy.ts';
import { EXIT } from '../src/util/output.ts';

describe('presigned uploads', () => {
  it('puts policy fields first and the file last', async () => {
    const form = presignedPostForm(
      {
        url: 'https://bucket.s3.amazonaws.com',
        fields: { key: 'a/b/server.zip', Policy: 'p', 'X-Amz-Signature': 's' },
      },
      new Uint8Array([1, 2, 3]),
      'server.zip',
    );
    const entries = [...form.entries()];
    expect(entries.map(([k]) => k)).toEqual(['key', 'Policy', 'X-Amz-Signature', 'file']);
    const file = entries.at(-1)![1] as File;
    expect(file.name).toBe('server.zip');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });
});

function fakeApi(responses: Array<Partial<DeploymentRecord>>, calls: string[] = []) {
  let i = 0;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${url} ${new Headers(init?.headers).get('authorization')}`);
    const body = responses[Math.min(i++, responses.length - 1)];
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return new ApiClient({ baseUrl: 'https://api.test', token: 'tok', fetch: fetchImpl });
}

describe('waitForDeployment', () => {
  it('streams new events and stops at a terminal status', async () => {
    const e = (msg: string) => ({ ts: 1, level: 'info' as const, msg });
    const calls: string[] = [];
    const api = fakeApi(
      [
        { id: 'd1', status: 'running', events: [e('a')] },
        { id: 'd1', status: 'running', events: [e('a'), e('b')] },
        { id: 'd1', status: 'succeeded', events: [e('a'), e('b'), e('c')], url: 'https://shop.example.com' },
      ],
      calls,
    );
    const seen: string[] = [];
    const d = await waitForDeployment(api, 'd1', {
      timeoutMs: 5_000,
      pollMs: 1,
      onEvent: (ev) => seen.push(ev.msg),
    });
    expect(d.status).toBe('succeeded');
    expect(seen).toEqual(['a', 'b', 'c']);
    expect(calls[0]).toBe('GET https://api.test/v1/deployments/d1 Bearer tok');
  });

  it('times out', async () => {
    const api = fakeApi([{ id: 'd1', status: 'running', events: [] }]);
    await expect(waitForDeployment(api, 'd1', { timeoutMs: 5, pollMs: 2 })).rejects.toThrow(/timed out/);
  });
});

describe('ApiClient', () => {
  it('maps API errors to exit codes and hints', async () => {
    const api = new ApiClient({
      baseUrl: 'https://api.test',
      token: 't',
      fetch: async () =>
        new Response(JSON.stringify({ error: { code: 'forbidden', message: 'not your app' } }), {
          status: 403,
        }),
    });
    const err = (await api.getApp('x').catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toBe('not your app');
    expect(err.exitCode).toBe(EXIT.auth);
  });

  it('unwraps list responses and builds query strings', async () => {
    const urls: string[] = [];
    const api = new ApiClient({
      baseUrl: 'https://api.test/',
      token: 't',
      fetch: (async (url: string) => {
        urls.push(url);
        return new Response(JSON.stringify({ stages: [{ stage: 'prod' }] }));
      }) as unknown as typeof fetch,
    });
    expect(await api.listStages('shop')).toEqual([{ stage: 'prod' }]);
    await api.logs('shop', { stage: 'prod', from: 10, filter: 'err or' });
    expect(urls).toEqual([
      'https://api.test/v1/apps/shop/stages',
      'https://api.test/v1/apps/shop/logs?stage=prod&from=10&q=err+or',
    ]);
  });

  it('parses server-sent events', async () => {
    const sse = 'data: {"message":"one"}\n\n: keepalive\n\ndata: {"message":"two"}\n\n';
    const api = new ApiClient({
      baseUrl: 'https://api.test',
      token: 't',
      fetch: async () => new Response(sse, { headers: { 'content-type': 'text/event-stream' } }),
    });
    const got: unknown[] = [];
    for await (const line of api.tailLogs('shop', { stage: 'prod' })) got.push(line);
    expect(got).toEqual([{ message: 'one' }, { message: 'two' }]);
  });
});
