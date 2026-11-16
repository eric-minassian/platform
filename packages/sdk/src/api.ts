/**
 * The browser-safe half of the SDK (`@ericminassian/platform/api`).
 * An app's `HttpApi` definition imports it, and so does the web client generated
 * from that definition, so nothing here may reach Node or AWS code.
 *
 *   export class TodosApi extends HttpApiGroup.make('todos')
 *     .add(...)
 *     .middleware(Authentication) {}
 *
 * The server side (`AuthenticationLayer`, part of `Platform.layer`) resolves the
 * session and provides `CurrentUser` to every endpoint behind the middleware.
 */
import { loginPath, logoutPath, UNAUTHORIZED_BODY } from '@ericminassian/platform-core/auth';
import { Context, Duration, Schema } from 'effect';
import { HttpApiMiddleware } from 'effect/http-api';

/** A signed-in user. `id` is stable and shared across all platform apps. */
export const User = Schema.Struct({
  id: Schema.String,
  email: Schema.optionalKey(Schema.String),
  emailVerified: Schema.optionalKey(Schema.Boolean),
  name: Schema.optionalKey(Schema.String),
  /** Cognito groups, e.g. `foo:admin`. */
  groups: Schema.Array(Schema.String),
});
export type User = typeof User.Type;

/** The signed-in user, provided by `Authentication` to the endpoints behind it. */
export class CurrentUser extends Context.Service<CurrentUser, User>()(
  '@ericminassian/platform/CurrentUser',
) {}

/** 401 for a signed-out request. Encodes to the same body as the platform's own 401s. */
export class Unauthorized extends Schema.TaggedError<Unauthorized, { readonly brand: unique symbol }>()(
  UNAUTHORIZED_BODY._tag,
  { message: Schema.String, loginUrl: Schema.String },
  { httpApiStatus: 401 },
) {
  static readonly signedOut = (): Unauthorized =>
    new Unauthorized({ message: UNAUTHORIZED_BODY.message, loginUrl: UNAUTHORIZED_BODY.loginUrl });
}

/**
 * A `Db` query got a cursor it didn't issue: malformed, edited, or from another
 * query. List it in the `error` of an endpoint that takes a cursor to answer 400.
 */
export class InvalidCursor extends Schema.TaggedError<InvalidCursor, { readonly brand: unique symbol }>()(
  'InvalidCursor',
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}

/** The body of a `RateLimited` 429. */
const RateLimitedBody = Schema.TaggedStruct('RateLimited', {
  message: Schema.String,
  retryAfter: Schema.Int,
}).annotate({ httpApiStatus: 429 });

/** Optional when decoding, so a proxy that drops the header can't turn a 429 into a decode error. */
const RetryAfterHeader = Schema.Struct({ 'retry-after': Schema.optionalKey(Schema.String) });

/**
 * 429 for a request over a rate limit (`RateLimits`), with a `Retry-After`
 * header. List it in an endpoint's `error` to answer with it, or declare a
 * middleware with it for `RateLimits.middleware`:
 *
 *   class WriteLimit extends HttpApiMiddleware.Service<WriteLimit>()('WriteLimit', { error: RateLimited }) {}
 */
export class RateLimited extends Schema.TaggedError<RateLimited, { readonly brand: unique symbol }>()(
  'RateLimited',
  {
    message: Schema.String,
    /** Whole seconds until a retry can succeed, as in the `Retry-After` header. */
    retryAfter: Schema.Int,
  },
  {
    httpApiStatus: 429,
    // What HttpApiSchema.encodeToWithHeaders would attach, on the class itself, so the one
    // class both is the error handlers fail with and carries the header on the wire.
    '~httpApiWithHeaders': {
      body: RateLimitedBody,
      headers: RetryAfterHeader,
      bodyCodec: RateLimitedBody,
      headersCodec: RetryAfterHeader,
      transformation: {
        decode: ({ body }: { readonly body: unknown }) => {
          const { message, retryAfter } = body as typeof RateLimitedBody.Type;
          return new RateLimited({ message, retryAfter });
        },
        encode: (value: unknown) => {
          const { message, retryAfter } = value as RateLimited;
          return {
            body: { _tag: 'RateLimited', message, retryAfter },
            headers: { 'retry-after': String(retryAfter) },
          };
        },
      },
    },
  },
) {
  /** A `RateLimited` asking the client to wait `retryAfter`, rounded up to whole seconds (at least 1). */
  static readonly after = (retryAfter: Duration.Input): RateLimited => {
    const seconds = Math.max(1, Math.ceil(Duration.toSeconds(retryAfter)));
    return new RateLimited({
      message: `Too many requests. Try again in ${seconds} second${seconds === 1 ? '' : 's'}.`,
      retryAfter: seconds,
    });
  };
}

/**
 * Requires a signed-in user (the platform session cookie, or a bearer ID token)
 * and provides it as `CurrentUser`. Fails with `Unauthorized` otherwise.
 */
export class Authentication extends HttpApiMiddleware.Service<Authentication, { provides: CurrentUser }>()(
  '@ericminassian/platform/Authentication',
  { error: Unauthorized },
) {}

/** Path that starts sign-in and returns to `redirect` (a same-origin path) afterwards. */
export const loginUrl: (redirect?: string) => string = loginPath;
/** Path that signs out, then goes to `redirect`. */
export const logoutUrl: (redirect?: string) => string = logoutPath;
