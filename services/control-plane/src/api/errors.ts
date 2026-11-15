/**
 * Error bodies the API answers outside its handlers, in the same
 * `{ error: { code, message } }` shape as every other error: a request that
 * fails its schema (400), a body that isn't JSON (415), a request no route
 * matches (404) and a defect (500).
 */
import { BadRequest, RequestValidation } from '@ericminassian/platform-core/platform-api';
import { Effect, type Layer, SchemaIssue } from 'effect';
import { HttpEffect, HttpRouter, HttpServerError, HttpServerRequest, HttpServerResponse } from 'effect/http';
import { HttpApiMiddleware } from 'effect/http-api';

/** What the formatter answers for a missing key without its own message; no real message contains NUL. */
const MISSING = '\u0000missing';

/**
 * One line describing why a request failed its schema. A message the schema
 * wrote (`repo must be "owner/name"`) is used as it is; Effect's generic ones
 * ("Expected string, got 1") are prefixed with the field, and a missing field
 * reads "<field> is required".
 */
export function describeSchemaIssue(issue: SchemaIssue.Issue): string {
  const authored = new Set<string>();
  const format = SchemaIssue.makeFormatterStandardSchemaV1({
    checkHook: (filter) => {
      const message = SchemaIssue.defaultCheckHook(filter);
      if (message !== undefined) authored.add(message);
      return message;
    },
    leafHook: (leaf) =>
      leaf._tag === 'MissingKey' && leaf.annotations?.messageMissingKey === undefined
        ? MISSING
        : SchemaIssue.defaultLeafHook(leaf),
  });
  return format(issue)
    .issues.map(({ path, message }) => {
      const at = (path ?? []).map((p) => String(typeof p === 'object' ? p.key : p)).join('.');
      if (message === MISSING) return `${at || 'value'} is required`;
      return at === '' || authored.has(message) ? message : `${at}: ${message}`;
    })
    .join('; ');
}

/**
 * `RequestValidation` (on every endpoint): a request that fails its schema
 * answers 400 `bad_request`. A response that fails its own schema is the
 * server's bug, so it stays a defect (a reported 500).
 */
export const RequestValidationLive: Layer.Layer<RequestValidation> =
  HttpApiMiddleware.layerSchemaErrorTransform(RequestValidation, (error) =>
    error.kind === 'Body' || error.kind === 'ResponseHeaders'
      ? Effect.fail(error)
      : Effect.fail(BadRequest.of(describeSchemaIssue(error.cause.issue))),
  );

const isRouteNotFound = (e: unknown): e is HttpServerError.HttpServerError =>
  HttpServerError.isHttpServerError(e) && e.reason._tag === 'RouteNotFound';

const internalError = HttpServerResponse.jsonUnsafe(
  { error: { code: 'internal', message: 'internal error' } },
  { status: 500 },
);

/** Effect answers a body that isn't JSON with a plain-text 415; the API answers JSON errors only. */
const unsupportedMediaType = HttpServerResponse.jsonUnsafe(
  {
    error: {
      code: 'unsupported_media_type',
      message: 'send the body as JSON (content-type: application/json)',
    },
  },
  { status: 415 },
);

/**
 * Unknown routes answer 404 `not_found` naming the method and path. A defect
 * answers Effect's empty 500 once it has been reported; it gets the API's
 * error body on its way out.
 */
export const RouterErrorsLive = HttpRouter.middleware(
  (httpEffect) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      return yield* httpEffect.pipe(
        Effect.catchIf(isRouteNotFound, () =>
          Effect.succeed(
            HttpServerResponse.jsonUnsafe(
              {
                error: {
                  code: 'not_found',
                  message: `no route for ${request.method} ${request.url.split('?')[0]}`,
                },
              },
              { status: 404 },
            ),
          ),
        ),
        HttpEffect.withPreResponseHandler((_request, response) =>
          Effect.succeed(
            response.status === 500 && response.body._tag === 'Empty'
              ? internalError
              : response.status === 415
                ? unsupportedMediaType
                : response,
          ),
        ),
      );
    }),
  { global: true },
);
