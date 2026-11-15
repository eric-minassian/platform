/**
 * Sign-in: `POST /v1/auth/cli` (exchange a GitHub token for a platform token),
 * `GET /v1/me`, and the console's GitHub OAuth round trip under `/auth/*`,
 * which answers redirects, cookies and plain text rather than API JSON.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { safeRedirect } from '@ericminassian/platform-core/auth';
import { Forbidden, PlatformApi, Unauthenticated } from '@ericminassian/platform-core/platform-api';
import { Duration, Effect, Option } from 'effect';
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/http';
import { HttpApiBuilder } from 'effect/http-api';
import { CONSOLE_COOKIE, TOKEN_TTL_SECONDS, Tokens } from '../auth.ts';
import { memberFor } from '../authz.ts';
import { Settings } from '../config.ts';
import { authorizeUrl, GitHub } from '../github.ts';
import { Access } from './access.ts';

const OAUTH_COOKIE = '__plat_oauth';

export const SessionLive = HttpApiBuilder.group(
  PlatformApi,
  'session',
  Effect.fn(function* (handlers) {
    const access = yield* Access;
    const github = yield* GitHub;
    const settings = yield* Settings;
    const tokens = yield* Tokens;

    return handlers.handleAll({
      cliLogin: ({ payload }) =>
        Effect.gen(function* () {
          const login = yield* github
            .login(payload.githubToken)
            .pipe(Effect.mapError((e) => Unauthenticated.of(e.message)));
          const member = memberFor(settings.platform, login);
          if (!member) {
            return yield* new Forbidden({
              code: 'not_a_member',
              message: `${login} is not invited. Ask an admin to add you to platform.config.ts.`,
            });
          }
          const { token, expiresAt } = yield* tokens.issue(member.github, 'cli');
          return { token, github: member.github, role: member.role, expiresAt };
        }),
      me: () => Effect.map(access.member, (me) => ({ github: me.github, role: me.role })),
    });
  }),
);

const text = (body: string, status: number) => HttpServerResponse.text(body, { status });

/** One query parameter (the first, if repeated). */
const queryParam = (name: string) =>
  Effect.map(HttpServerRequest.ParsedSearchParams, (params) => {
    const value = params[name];
    return Array.isArray(value) ? value[0] : value;
  });

/** Constant-time comparison of the state GitHub returned with the one the login set. */
const sameState = (expected: string, actual: string) =>
  expected.length > 0 &&
  expected.length === actual.length &&
  timingSafeEqual(Buffer.from(expected), Buffer.from(actual));

/** The console's sign-in with the GitHub App, which sets the session cookie `Authenticated` reads. */
export const ConsoleSignInLive = HttpRouter.use(
  Effect.fnUntraced(function* (router) {
    const github = yield* GitHub;
    const settings = yield* Settings;
    const tokens = yield* Tokens;
    const callbackUrl = `${settings.consoleUrl}/auth/github/callback`;

    yield* router.add(
      'GET',
      '/auth/github/login',
      Effect.gen(function* () {
        const app = yield* settings.githubApp;
        if (Option.isNone(app)) return text('GitHub sign-in is not configured yet (see docs/SETUP.md).', 503);
        const state = randomBytes(16).toString('hex');
        const redirect = safeRedirect(yield* queryParam('redirect'));
        return HttpServerResponse.redirect(authorizeUrl(app.value, callbackUrl, state)).pipe(
          HttpServerResponse.setCookieUnsafe(OAUTH_COOKIE, `${state}|${redirect}`, {
            httpOnly: true,
            secure: true,
            sameSite: 'lax',
            path: '/auth/github',
            maxAge: '10 minutes',
          }),
        );
      }),
    );

    const callback = Effect.gen(function* () {
      const app = yield* settings.githubApp;
      if (Option.isNone(app)) return text('GitHub sign-in is not configured.', 503);
      const request = yield* HttpServerRequest.HttpServerRequest;
      const [expected = '', redirect] = (request.cookies[OAUTH_COOKIE] ?? '').split('|');
      if (!sameState(expected, (yield* queryParam('state')) ?? '')) {
        return text('Sign-in expired or was tampered with. Try again.', 400);
      }
      const code = yield* queryParam('code');
      if (!code) return text('GitHub did not return a code.', 400);
      const login = yield* github.exchangeCode(app.value, code, callbackUrl).pipe(
        Effect.flatMap((userToken) => github.login(userToken)),
        Effect.result,
      );
      if (login._tag === 'Failure') return text(`GitHub sign-in failed: ${login.failure.message}`, 502);
      const member = memberFor(settings.platform, login.success);
      if (!member) return HttpServerResponse.redirect(`/login?denied=${encodeURIComponent(login.success)}`);
      const { token } = yield* tokens.issue(member.github, 'console');
      return HttpServerResponse.redirect(safeRedirect(redirect)).pipe(
        HttpServerResponse.setCookieUnsafe(CONSOLE_COOKIE, token, {
          httpOnly: true,
          secure: true,
          sameSite: 'lax',
          path: '/',
          maxAge: Duration.seconds(TOKEN_TTL_SECONDS.console),
        }),
      );
    });
    // The login round trip's cookie is spent whatever the outcome.
    yield* router.add(
      'GET',
      '/auth/github/callback',
      Effect.map(callback, HttpServerResponse.expireCookieUnsafe(OAUTH_COOKIE, { path: '/auth/github' })),
    );

    yield* router.add(
      'POST',
      '/auth/logout',
      HttpServerResponse.empty({ status: 204 }).pipe(
        HttpServerResponse.expireCookieUnsafe(CONSOLE_COOKIE, { path: '/' }),
      ),
    );
  }),
);
