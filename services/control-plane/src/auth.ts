/**
 * Authentication: platform tokens (CLI), console session cookies, and GitHub
 * Actions OIDC tokens (CI). All platform-issued tokens are HS256 JWTs signed
 * with the session key in SSM. Membership is re-checked on every request, so
 * removing someone from `platform.config.ts` revokes access on the next deploy.
 */
import { PLATFORM_DEFAULTS } from '@ericminassian/platform-core';
import {
  Authenticated,
  CSRF_HEADER,
  CurrentPrincipal,
  Forbidden,
  type Principal,
  Unauthenticated,
} from '@ericminassian/platform-core/platform-api';
import { Clock, Context, Effect, Layer, Option, Schema } from 'effect';
import { HttpServerRequest } from 'effect/http';
import { createRemoteJWKSet, decodeJwt, jwtVerify, SignJWT } from 'jose';
import { ciPrincipalFromClaims, type GithubOidcClaims, memberFor } from './authz.ts';
import { Settings } from './config.ts';

export const CONSOLE_COOKIE = '__plat_console';
const ISSUER = 'platform';
const GITHUB_OIDC_ISSUER = 'https://token.actions.githubusercontent.com';

export type TokenUse = 'cli' | 'console';

export const TOKEN_TTL_SECONDS: Record<TokenUse, number> = { cli: 30 * 86400, console: 7 * 86400 };

/** A token that doesn't verify; `message` is jose's reason. */
export class InvalidToken extends Schema.TaggedError<InvalidToken, { readonly brand: unique symbol }>()(
  'InvalidToken',
  { message: Schema.String },
) {}

const invalid = (e: unknown) => new InvalidToken({ message: e instanceof Error ? e.message : String(e) });

export class Tokens extends Context.Service<
  Tokens,
  {
    /** A platform token for a member: `cli` for `plat login`, `console` for the session cookie. */
    issue(
      github: string,
      use: TokenUse,
    ): Effect.Effect<{ readonly token: string; readonly expiresAt: string }>;
    /** The GitHub login a platform token was issued to. */
    verify(token: string, use: TokenUse): Effect.Effect<string, InvalidToken>;
    /** The claims of a GitHub Actions OIDC token minted for the platform's audience. */
    verifyGithubOidc(token: string): Effect.Effect<GithubOidcClaims, InvalidToken>;
  }
>()('@ericminassian/platform-control-plane/Tokens') {
  static readonly layer: Layer.Layer<Tokens, never, Settings> = Layer.effect(
    Tokens,
    Effect.gen(function* () {
      const settings = yield* Settings;
      // jose caches the key set and refetches it when GitHub rotates keys.
      const githubJwks = createRemoteJWKSet(new URL(`${GITHUB_OIDC_ISSUER}/.well-known/jwks`));

      const issue = Effect.fn('Tokens.issue')(function* (github: string, use: TokenUse) {
        const key = yield* settings.sessionKey;
        const exp = Math.floor((yield* Clock.currentTimeMillis) / 1000) + TOKEN_TTL_SECONDS[use];
        const token = yield* Effect.promise(() =>
          new SignJWT({ use })
            .setProtectedHeader({ alg: 'HS256' })
            .setIssuer(ISSUER)
            .setAudience(`platform-${use}`)
            .setSubject(github)
            .setIssuedAt()
            .setExpirationTime(exp)
            .sign(key),
        );
        return { token, expiresAt: new Date(exp * 1000).toISOString() };
      });

      const verify = Effect.fn('Tokens.verify')(function* (token: string, use: TokenUse) {
        const key = yield* settings.sessionKey;
        const { payload } = yield* Effect.tryPromise({
          try: () =>
            jwtVerify(token, key, { issuer: ISSUER, audience: `platform-${use}`, algorithms: ['HS256'] }),
          catch: invalid,
        });
        if (!payload.sub) return yield* new InvalidToken({ message: 'token has no subject' });
        return payload.sub;
      });

      const verifyGithubOidc = Effect.fn('Tokens.verifyGithubOidc')(function* (token: string) {
        const { payload } = yield* Effect.tryPromise({
          try: () =>
            jwtVerify(token, githubJwks, {
              issuer: GITHUB_OIDC_ISSUER,
              audience: PLATFORM_DEFAULTS.oidcAudience,
              algorithms: ['RS256'],
            }),
          catch: invalid,
        });
        return payload as GithubOidcClaims;
      });

      return Tokens.of({ issue, verify, verifyGithubOidc });
    }),
  );
}

/**
 * Dev-only escape hatch: every request acts as this member. Provided by
 * `src/dev.ts` alone, never read from the environment here, so it can't
 * reach Lambda.
 */
export const DevUser = Context.Reference<Option.Option<string>>(
  '@ericminassian/platform-control-plane/DevUser',
  {
    defaultValue: () => Option.none(),
  },
);

/** Methods a cross-site form can't send with a body, so the CSRF header isn't needed. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const notAMember = (github: string) =>
  new Forbidden({ code: 'not_a_member', message: `${github} is not a platform member` });

/** `Authenticated`: who is calling, from a bearer token or the console cookie. */
export const AuthenticatedLive: Layer.Layer<Authenticated, never, Settings | Tokens> = Layer.effect(
  Authenticated,
  Effect.gen(function* () {
    const settings = yield* Settings;
    const tokens = yield* Tokens;
    const devUser = yield* DevUser;
    const member = (github: string) => Option.fromNullishOr(memberFor(settings.platform, github));

    const fromBearer = Effect.fnUntraced(function* (token: string) {
      const iss = yield* Effect.try({
        try: () => decodeJwt(token).iss,
        catch: () => Unauthenticated.of('malformed bearer token'),
      });
      if (iss === GITHUB_OIDC_ISSUER) {
        const claims = yield* tokens
          .verifyGithubOidc(token)
          .pipe(Effect.mapError((e) => Unauthenticated.of(`invalid GitHub OIDC token: ${e.message}`)));
        const ci = ciPrincipalFromClaims(claims);
        if (!ci) return yield* Unauthenticated.of('GitHub OIDC token is missing repository claims');
        return ci;
      }
      const github = yield* tokens
        .verify(token, 'cli')
        .pipe(
          Effect.mapError(() => Unauthenticated.of('invalid or expired platform token; run `plat login`')),
        );
      return yield* Effect.fromOption(member(github)).pipe(Effect.mapError(() => notAMember(github)));
    });

    /** A cookie that doesn't verify, or of someone no longer a member, counts as signed out. */
    const fromCookie = (token: string) =>
      tokens.verify(token, 'console').pipe(
        Effect.map(member),
        Effect.orElseSucceed(() => Option.none()),
      );

    return Authenticated.of((httpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const bearer = request.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
        const cookie = request.cookies[CONSOLE_COOKIE];
        const principal: Option.Option<Principal> = Option.isSome(devUser)
          ? member(devUser.value)
          : bearer
            ? Option.some(yield* fromBearer(bearer))
            : cookie
              ? yield* fromCookie(cookie)
              : Option.none();
        if (Option.isNone(principal))
          return yield* Unauthenticated.of('sign in at the console or run `plat login`');
        const viaCookie = Option.isNone(devUser) && !bearer;
        if (viaCookie && !SAFE_METHODS.has(request.method) && request.headers[CSRF_HEADER] !== '1') {
          return yield* new Forbidden({
            code: 'csrf',
            message: `cookie-authenticated writes need the ${CSRF_HEADER} header`,
          });
        }
        return yield* Effect.provideService(httpEffect, CurrentPrincipal, principal.value);
      }),
    );
  }),
);
