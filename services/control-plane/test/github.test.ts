import { generateKeyPairSync } from 'node:crypto';
import { assert, describe, it } from '@effect/vitest';
import { Effect, Layer, Option } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { GitHub } from '../src/github.ts';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const app = { clientId: 'Iv1.x', clientSecret: 's', appId: '123', privateKey };

/** GitHub over a `fetch` that answers with `respond`, recording `METHOD url` of each call. */
const github = (respond: (url: string, init: RequestInit) => Response | Promise<Response>) => {
  const calls: string[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    return respond(url, init ?? {});
  };
  const layer = GitHub.layer.pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provideMerge(Layer.succeed(FetchHttpClient.Fetch, fetch as typeof globalThis.fetch)),
  );
  return {
    calls,
    use: <A, E>(f: (gh: GitHub['Service']) => Effect.Effect<A, E>) => Effect.provide(GitHub.use(f), layer),
  };
};

const bodyOf = async (init: RequestInit) => JSON.parse(await new Response(init.body).text()) as unknown;
const headerOf = (init: RequestInit, name: string) => new Headers(init.headers).get(name);

describe('GitHub', () => {
  it.effect('finds the installation for the repo, then opens the issue with an installation token', () =>
    Effect.gen(function* () {
      const { calls, use } = github(async (url, init) => {
        if (url.endsWith('/repos/eric/shop/installation')) return Response.json({ id: 42 });
        if (url.endsWith('/app/installations/42/access_tokens')) {
          assert.deepStrictEqual(await bodyOf(init), { repositories: ['shop'] });
          return Response.json({ token: 'inst-token' });
        }
        if (url.endsWith('/repos/eric/shop/issues')) {
          assert.strictEqual(headerOf(init, 'authorization'), 'Bearer inst-token');
          return Response.json({ html_url: 'https://github.com/eric/shop/issues/1' });
        }
        return new Response('unexpected', { status: 500 });
      });
      const url = yield* use((gh) => gh.openIssue(app, 'eric/shop', { title: 't', body: 'b' }));
      assert.deepStrictEqual(url, Option.some('https://github.com/eric/shop/issues/1'));
      assert.deepStrictEqual(calls, [
        'GET https://api.github.com/repos/eric/shop/installation',
        'POST https://api.github.com/app/installations/42/access_tokens',
        'POST https://api.github.com/repos/eric/shop/issues',
      ]);
    }),
  );

  it.effect('opens no issue when the App is not installed on the repo or has no key', () =>
    Effect.gen(function* () {
      const { use } = github(() => new Response('not found', { status: 404 }));
      assert.isTrue(
        Option.isNone(yield* use((gh) => gh.openIssue(app, 'eric/other', { title: 't', body: 'b' }))),
      );
      const keyless = { clientId: 'c', clientSecret: 's' };
      assert.isTrue(
        Option.isNone(yield* use((gh) => gh.openIssue(keyless, 'eric/shop', { title: 't', body: 'b' }))),
      );
    }),
  );

  it.effect('identifies the user a token belongs to, and says why it could not', () =>
    Effect.gen(function* () {
      const { use } = github((_url, init) =>
        headerOf(init, 'authorization') === 'Bearer good'
          ? Response.json({ login: 'ada' })
          : new Response('bad credentials', { status: 401 }),
      );
      assert.strictEqual(yield* use((gh) => gh.login('good')), 'ada');
      const error = yield* Effect.flip(use((gh) => gh.login('bad')));
      assert.deepStrictEqual([error._tag, error.message], ['GitHubError', 'GitHub rejected the token (401)']);
    }),
  );

  it.effect('exchanges an OAuth code, passing on GitHub’s reason when it refuses', () =>
    Effect.gen(function* () {
      const { use } = github(async (_url, init) => {
        const { code } = (await bodyOf(init)) as { code: string };
        return code === 'good'
          ? Response.json({ access_token: 'user-token' })
          : Response.json({ error_description: 'The code passed is incorrect or expired.' });
      });
      assert.strictEqual(yield* use((gh) => gh.exchangeCode(app, 'good', 'https://cb')), 'user-token');
      const error = yield* Effect.flip(use((gh) => gh.exchangeCode(app, 'stale', 'https://cb')));
      assert.strictEqual(error.message, 'The code passed is incorrect or expired.');
    }),
  );
});
