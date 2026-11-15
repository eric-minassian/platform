import { FetchHttpClient } from 'effect/http';
import { AtomHttpApi } from 'effect/reactivity';
import { Api } from '../../src/api.ts';

/**
 * The API client, generated from `src/api.ts`: paths, payloads, responses and
 * errors are checked against the server's definition. `query` and `mutation`
 * give atoms for `@effect/atom-react`. Requests carry the platform's session
 * cookie (same origin).
 */
// AtomHttpApi's method types carry a conditional that resolves to `never`, which this rule misreads.
// @effect-diagnostics-next-line leakingRequirements:off
export class ApiClient extends AtomHttpApi.Service<ApiClient>()('template-app/web/ApiClient', {
  api: Api,
  httpClient: FetchHttpClient.layer,
  baseUrl: window.location.origin,
}) {}
