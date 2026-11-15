/**
 * The control plane API client, generated from `PlatformApi`: paths, payloads,
 * responses and errors are checked against the contract the server implements.
 * Pages read endpoints through `ApiClient.query` atoms (wrapped in `fresh`)
 * and change things through `ApiClient.mutation`, naming reactivity keys so
 * the queries showing what changed refetch.
 */
import { CSRF_HEADER, PlatformApi } from '@ericminassian/platform-core/platform-api';
import { Cause, Duration, Effect, Option, Schedule, Schema, SchemaIssue, Stream } from 'effect';
import { FetchHttpClient, HttpClient, HttpClientError, HttpClientRequest } from 'effect/http';
import { HttpApiClient } from 'effect/http-api';
import { AsyncResult, Atom, AtomHttpApi } from 'effect/reactivity';

/** The console is served by the control plane, so the API is same-origin and the session cookie rides along. */
const baseUrl = window.location.origin;

const signInUrl = (redirect: string): string => `/login?redirect=${encodeURIComponent(redirect)}`;

/** 5xx bodies aren't part of `PlatformApi`, but the server still sends its `{ error: { message } }` shape. */
const ServerErrorBody = Schema.Struct({ error: Schema.Struct({ message: Schema.String }) });

const consoleClient = (client: HttpClient.HttpClient): HttpClient.HttpClient =>
  client.pipe(
    // The console exports no spans: a `traceparent` would hand the server a parent span that doesn't exist.
    HttpClient.transform((effect) =>
      Effect.provideService(effect, HttpClient.TracerPropagationEnabled, false),
    ),
    // The server refuses cookie-authenticated writes without it (CSRF guard).
    HttpClient.mapRequest(HttpClientRequest.setHeader(CSRF_HEADER, '1')),
    HttpClient.tap((response) =>
      response.status === 401 && !location.pathname.startsWith('/login')
        ? Effect.sync(() => location.assign(signInUrl(location.pathname + location.search)))
        : Effect.void,
    ),
    // An undeclared status would surface as "undeclared status code"; keep the server's message instead.
    HttpClient.transformResponse(
      Effect.flatMap((response) =>
        response.status < 500
          ? Effect.succeed(response)
          : response.json.pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(ServerErrorBody)),
              Effect.match({ onFailure: () => undefined, onSuccess: (body) => body.error.message }),
              Effect.flatMap((description) =>
                Effect.fail(
                  new HttpClientError.HttpClientError({
                    reason: new HttpClientError.StatusCodeError({
                      request: response.request,
                      response,
                      description,
                    }),
                  }),
                ),
              ),
            ),
      ),
    ),
    // Reads retry a network failure or 5xx twice with backoff; writes never repeat.
    HttpClient.transform((effect, request) =>
      request.method === 'GET'
        ? Effect.retry(effect, {
            while: HttpClient.isTransientError,
            schedule: Schedule.exponential('1 second'),
            times: 2,
          })
        : effect,
    ),
  );

export class ApiClient extends AtomHttpApi.Service<ApiClient>()('platform-console/ApiClient', {
  api: PlatformApi,
  httpClient: FetchHttpClient.layer,
  transformClient: consoleClient,
  baseUrl,
}) {}

/** URLs of endpoints the browser calls itself, such as the live tail's `EventSource`. */
export const apiUrl = HttpApiClient.urlBuilder(PlatformApi, { baseUrl });

/** `/auth/logout` sits outside `/v1`, so it goes through the same HTTP client rather than `ApiClient`. */
export const logout = Atom.runtime(FetchHttpClient.layer).fn(() =>
  HttpClient.HttpClient.use((client) => consoleClient(client).post(new URL('/auth/logout', baseUrl))),
);

/** How long a query's data stays cached after its last reader unmounts. */
export const timeToLive = Duration.minutes(5);

/** Counts the times the browser came back online. */
const onlineSignal = Atom.readable((get) => {
  let count = 0;
  const update = () => get.setSelf(++count);
  window.addEventListener('online', update);
  get.addFinalizer(() => window.removeEventListener('online', update));
  return count;
});

/** Changes whenever the tab becomes visible again or the browser reconnects. */
const revalidateSignal = Atom.readable((get) => get(Atom.windowFocusSignal) + get(onlineSignal));

/**
 * Keeps a query fresh while it's on screen: cached data older than
 * `staleTime` (default 15s) is refetched in the background when the page
 * mounts, the tab regains focus or the browser reconnects, and `every` polls
 * (paused while the tab is hidden). `every` can depend on the data, to poll
 * only while it's changing.
 */
export function fresh<A, E>(
  self: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
  options: {
    readonly staleTime?: Duration.Input;
    readonly every?: Duration.Input | ((value: A) => Duration.Input | undefined);
  } = {},
): Atom.Atom<AsyncResult.AsyncResult<A, E>> {
  const revalidated = Atom.swr(self, {
    staleTime: options.staleTime ?? Duration.seconds(15),
    revalidateOnFocus: true,
    focusSignal: revalidateSignal,
  });
  const { every } = options;
  if (every === undefined) return revalidated;
  const interval = (result: AsyncResult.AsyncResult<A, E>): Duration.Input | undefined => {
    if (typeof every !== 'function') return every;
    const value = AsyncResult.value(result);
    return value._tag === 'Some' ? every(value.value) : undefined;
  };
  return Atom.transform(
    revalidated,
    (get) => {
      // Depending on the signal re-arms the timer when a hidden tab comes back.
      get(revalidateSignal);
      const result = get(revalidated);
      // Atom.withRefresh would also fire while a slow request is in flight and restart it.
      const next = result.waiting ? undefined : interval(result);
      if (next !== undefined) {
        const timer = setTimeout(
          () => {
            if (document.visibilityState === 'visible') get.refresh(revalidated);
          },
          Duration.toMillis(Duration.fromInputUnsafe(next)),
        );
        get.addFinalizer(() => clearTimeout(timer));
      }
      return result;
    },
    { initialValueTarget: revalidated },
  );
}

/**
 * A cursor-paged endpoint as an atom of the pages loaded so far, starting
 * with the first; writing to it loads the next one. `cursor` reads the next
 * page's cursor from a page: there is no next page without one.
 *
 * Loaded pages stay cached for `timeToLive` after the last reader unmounts.
 * Unlike `fresh` queries they aren't refetched on focus or reconnect, since a
 * refetch (a refresh, or new parameters) starts again from the first page.
 */
export function pages<P, E>(
  load: (cursor: string | undefined) => Effect.Effect<P, E, ApiClient>,
  cursor: (page: P) => string | undefined,
) {
  return Atom.setIdleTTL(
    ApiClient.runtime.pull(
      Stream.paginate(undefined as string | undefined, (next) =>
        Effect.map(load(next), (page) => [[page], Option.fromNullishOr(cursor(page))] as const),
      ),
    ),
    timeToLive,
  );
}

/** The pages a `pages` atom has loaded (the last ones it had, when loading another failed). */
export const loadedPages = <P, E>(result: Atom.PullResult<P, E>): ReadonlyArray<P> =>
  Option.match(AsyncResult.value(result), { onNone: () => [], onSome: ({ items }) => items });

/** A settled mutation's failure; none while a new attempt is in flight. */
export const failure = <A, E>(result: AsyncResult.AsyncResult<A, E>): Cause.Cause<E> | undefined =>
  result._tag === 'Failure' && !result.waiting ? result.cause : undefined;

/** A settled mutation's success. */
export const succeeded = <A, E>(result: AsyncResult.AsyncResult<A, E>): boolean =>
  result._tag === 'Success' && !result.waiting;

const issues = SchemaIssue.makeFormatterStandardSchemaV1();

/** What to show for a failed request: the server's message when it sent one. */
export function errorMessage(error: unknown): string {
  if (Cause.isCause(error)) return errorMessage(Cause.squash(error));
  // A payload the client refuses to send reads like the server's 400 for it, without the schema path.
  if (Schema.isSchemaError(error)) {
    return issues(error.issue)
      .issues.map((issue) => issue.message)
      .join('; ');
  }
  if (HttpClientError.isHttpClientError(error)) {
    const { reason } = error;
    if (reason._tag === 'StatusCodeError') return reason.description ?? `HTTP ${reason.response.status}`;
    if (reason._tag === 'TransportError' && reason.cause instanceof Error) return reason.cause.message;
  }
  return error instanceof Error ? error.message : String(error);
}
