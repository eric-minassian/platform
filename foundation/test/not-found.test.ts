import { newDeploymentId } from '@ericminassian/platform-core';
import { describe, expect, it } from 'vitest';
import { answer, notFoundPageKey, type ReadPage } from '../src/not-found.ts';

const deployment = newDeploymentId();

describe('not-found origin', () => {
  it('finds the 404 page of the deployment the router’s path names', () => {
    expect(notFoundPageKey(`/site/prod/${deployment}/missing/index.html`)).toBe(
      `site/prod/${deployment}/404.html`,
    );
    expect(notFoundPageKey(`/site/pr-3/${deployment}/a.png`)).toBe(`site/pr-3/${deployment}/404.html`);
    // Paths the router never makes: no file, a bad name, no deployment id.
    expect(notFoundPageKey(`/site/prod/${deployment}`)).toBeUndefined();
    expect(notFoundPageKey(`/Site/prod/${deployment}/x`)).toBeUndefined();
    expect(notFoundPageKey('/site/prod/latest/x')).toBeUndefined();
    expect(notFoundPageKey('/__platform/not-found')).toBeUndefined();
  });

  it('answers with the build’s 404 page, or a plain one, always as a 404 the edge keeps', async () => {
    const asked: string[] = [];
    const read: ReadPage = async (key) => {
      asked.push(key);
      return key.startsWith('site/') ? { body: '<h1>Not here</h1>', contentType: 'text/html' } : undefined;
    };
    const page = await answer({ rawPath: `/site/prod/${deployment}/nope/index.html` }, read);
    expect(page).toEqual({
      statusCode: 404,
      headers: { 'content-type': 'text/html', 'cache-control': 'public, max-age=0, s-maxage=86400' },
      body: '<h1>Not here</h1>',
    });
    const plain = await answer({ rawPath: `/shop/prod/${deployment}/a.png` }, read);
    expect([plain.statusCode, plain.headers['content-type'], plain.body]).toEqual([
      404,
      'text/plain; charset=utf-8',
      'Not found.',
    ]);
    // A path it can't place reads nothing.
    expect((await answer({ rawPath: '/x' }, read)).body).toBe('Not found.');
    expect(asked).toEqual([`site/prod/${deployment}/404.html`, `shop/prod/${deployment}/404.html`]);
  });
});
