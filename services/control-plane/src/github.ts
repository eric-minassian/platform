/**
 * GitHub API calls: identify a user from a token, the console's OAuth round
 * trip (GitHub App user authorization), and opening issues as the GitHub App.
 */
import { createPrivateKey } from 'node:crypto';
import { Clock, Context, Effect, flow, Layer, Option, Schema } from 'effect';
import { HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/http';
import { SignJWT } from 'jose';
import type { GithubAppSettings } from './config.ts';

/** A GitHub call that failed; `message` is meant for the person signing in. */
export class GitHubError extends Schema.TaggedError<GitHubError, { readonly brand: unique symbol }>()(
  'GitHubError',
  {
    message: Schema.String,
  },
) {}

const API = 'https://api.github.com';
const TIMEOUT = '10 seconds';

const headers = (token: string) => ({
  authorization: `Bearer ${token}`,
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  'user-agent': 'platform-control-plane',
});

/** Where the console sends someone to sign in with the GitHub App. */
export function authorizeUrl(app: GithubAppSettings, redirectUri: string, state: string): string {
  const u = new URL('https://github.com/login/oauth/authorize');
  u.searchParams.set('client_id', app.clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('state', state);
  u.searchParams.set('allow_signup', 'false');
  return u.toString();
}

/** Transport, decoding and timeout failures, with the message they carry. */
const asGitHubError = <A, R>(
  effect: Effect.Effect<A, GitHubError | { readonly message: string }, R>,
): Effect.Effect<A, GitHubError, R> =>
  Effect.mapError(effect, (e) => (e instanceof GitHubError ? e : new GitHubError({ message: e.message })));

const fail = (message: string) => Effect.fail(new GitHubError({ message }));

export class GitHub extends Context.Service<
  GitHub,
  {
    /** The login of the user `token` belongs to. */
    login(token: string): Effect.Effect<string, GitHubError>;
    /** The user token for an OAuth `code` from the console's sign-in. */
    exchangeCode(
      app: GithubAppSettings,
      code: string,
      redirectUri: string,
    ): Effect.Effect<string, GitHubError>;
    /**
     * Opens an issue in `repo` as the GitHub App. None when the App has no key
     * configured or isn't installed on the repo.
     */
    openIssue(
      app: GithubAppSettings,
      repo: string,
      issue: { readonly title: string; readonly body: string; readonly labels?: ReadonlyArray<string> },
    ): Effect.Effect<Option.Option<string>, GitHubError>;
  }
>()('@ericminassian/platform-control-plane/GitHub') {
  static readonly layer: Layer.Layer<GitHub, never, HttpClient.HttpClient> = Layer.effect(
    GitHub,
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient;
      const api = (token: string) =>
        http.pipe(
          HttpClient.mapRequest(
            flow(HttpClientRequest.prependUrl(API), HttpClientRequest.setHeaders(headers(token))),
          ),
        );
      const json = <S extends Schema.Constraint>(schema: S) => HttpClientResponse.schemaBodyJson(schema);

      const login = Effect.fn('GitHub.login')(
        function* (token: string) {
          const res = yield* api(token).get('/user');
          if (res.status < 200 || res.status >= 300)
            return yield* fail(`GitHub rejected the token (${res.status})`);
          const { login: user } = yield* json(Schema.Struct({ login: Schema.optional(Schema.String) }))(res);
          if (!user) return yield* fail('GitHub returned no login');
          return user;
        },
        Effect.timeout(TIMEOUT),
        asGitHubError,
      );

      const exchangeCode = Effect.fn('GitHub.exchangeCode')(
        function* (app: GithubAppSettings, code: string, redirectUri: string) {
          const res = yield* HttpClientRequest.post('https://github.com/login/oauth/access_token').pipe(
            HttpClientRequest.acceptJson,
            HttpClientRequest.bodyJsonUnsafe({
              client_id: app.clientId,
              client_secret: app.clientSecret,
              code,
              redirect_uri: redirectUri,
            }),
            http.execute,
          );
          const body = yield* json(
            Schema.Struct({
              access_token: Schema.optional(Schema.String),
              error_description: Schema.optional(Schema.String),
            }),
          )(res);
          if (!body.access_token)
            return yield* fail(body.error_description ?? 'GitHub did not return an access token');
          return body.access_token;
        },
        Effect.timeout(TIMEOUT),
        asGitHubError,
      );

      /** A short-lived JWT that authenticates as the App itself (not an installation). */
      const appJwt = Effect.fnUntraced(function* (appId: string, privateKey: string) {
        const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
        return yield* Effect.tryPromise({
          // GitHub App keys are PKCS#1 PEM; node:crypto parses both PKCS#1 and PKCS#8.
          try: () =>
            new SignJWT({})
              .setProtectedHeader({ alg: 'RS256' })
              .setIssuer(appId)
              .setIssuedAt(now - 60)
              .setExpirationTime(now + 540)
              .sign(createPrivateKey(privateKey)),
          catch: (e) => new GitHubError({ message: `signing as the GitHub App failed: ${String(e)}` }),
        });
      });

      /**
       * Installation token scoped to `repo`. The installation is looked up per
       * repo (GET /repos/{repo}/installation) instead of being configured, so
       * nobody has to dig up an installation id, and repos owned by other
       * members work as soon as they install the App on their account.
       */
      const installationToken = Effect.fnUntraced(function* (app: GithubAppSettings, repo: string) {
        if (!app.appId || !app.privateKey) return Option.none<string>();
        const jwt = yield* appJwt(app.appId, app.privateKey);
        const found = yield* api(jwt).get(`/repos/${repo}/installation`);
        if (found.status === 404) return Option.none<string>();
        if (found.status < 200 || found.status >= 300)
          return yield* fail(`GitHub App installation lookup for ${repo} failed (${found.status})`);
        const { id } = yield* json(Schema.Struct({ id: Schema.Finite }))(found);
        const res = yield* HttpClientRequest.post(`/app/installations/${id}/access_tokens`).pipe(
          HttpClientRequest.bodyJsonUnsafe({ repositories: [repo.split('/')[1]] }),
          api(jwt).execute,
        );
        if (res.status < 200 || res.status >= 300)
          return yield* fail(`GitHub App token request failed (${res.status})`);
        const { token } = yield* json(Schema.Struct({ token: Schema.String }))(res);
        return Option.some(token);
      });

      const openIssue = Effect.fn('GitHub.openIssue')(
        function* (
          app: GithubAppSettings,
          repo: string,
          issue: { readonly title: string; readonly body: string; readonly labels?: ReadonlyArray<string> },
        ) {
          const token = yield* installationToken(app, repo);
          if (Option.isNone(token)) return Option.none<string>();
          const res = yield* HttpClientRequest.post(`/repos/${repo}/issues`).pipe(
            HttpClientRequest.bodyJsonUnsafe(issue),
            api(token.value).execute,
          );
          if (res.status < 200 || res.status >= 300)
            return yield* fail(`creating an issue in ${repo} failed (${res.status})`);
          const { html_url } = yield* json(Schema.Struct({ html_url: Schema.String }))(res);
          return Option.some(html_url);
        },
        Effect.timeout('30 seconds'),
        asGitHubError,
      );

      return GitHub.of({ login, exchangeCode, openIssue });
    }),
  );
}
