import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openIssue } from '../src/github.ts';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const app = { clientId: 'Iv1.x', clientSecret: 's', appId: '123', privateKey };

afterEach(() => vi.unstubAllGlobals());

describe('openIssue', () => {
  it('finds the installation for the repo, then opens the issue with an installation token', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.endsWith('/repos/eric/shop/installation')) return Response.json({ id: 42 });
      if (url.endsWith('/app/installations/42/access_tokens')) {
        expect(JSON.parse(String(init?.body))).toEqual({ repositories: ['shop'] });
        return Response.json({ token: 'inst-token' });
      }
      if (url.endsWith('/repos/eric/shop/issues')) {
        expect((init?.headers as Record<string, string>).authorization).toBe('Bearer inst-token');
        return Response.json({ html_url: 'https://github.com/eric/shop/issues/1' });
      }
      return new Response('unexpected', { status: 500 });
    });
    expect(await openIssue(app, 'eric/shop', { title: 't', body: 'b' })).toBe(
      'https://github.com/eric/shop/issues/1',
    );
    expect(calls).toEqual([
      'GET https://api.github.com/repos/eric/shop/installation',
      'POST https://api.github.com/app/installations/42/access_tokens',
      'POST https://api.github.com/repos/eric/shop/issues',
    ]);
  });

  it('returns null when the App is not installed on the repo or has no key', async () => {
    vi.stubGlobal('fetch', async () => new Response('not found', { status: 404 }));
    expect(await openIssue(app, 'eric/other', { title: 't', body: 'b' })).toBeNull();
    expect(
      await openIssue({ clientId: 'c', clientSecret: 's' }, 'eric/shop', { title: 't', body: 'b' }),
    ).toBeNull();
  });
});
