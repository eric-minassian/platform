/**
 * The Effect SDK (`@ericminassian/platform/effect`): every platform resource
 * as an Effect service, the web server and worker entry points, and an
 * in-memory platform for unit tests.
 *
 *   // src/server.ts
 *   export default toFetchHandler(HttpLive.pipe(Layer.provide(Platform.layer)));
 *
 *   // src/worker.ts
 *   export default defineWorker({ layer: Platform.layer, queues: { ... }, ... });
 *
 * The browser-safe pieces an `HttpApi` definition needs (`Authentication`,
 * `CurrentUser`, `User`) are in `@ericminassian/platform/effect/api`.
 *
 * CONTRACT: documented in templates/app/AGENTS.md and used by every Effect app.
 */

export type { JobContext, LogsBatch, PlatformEvent, QueueMessage } from '../worker.ts';
export {
  Authentication,
  CurrentUser,
  InvalidCursor,
  loginUrl,
  logoutUrl,
  Unauthorized,
  User,
} from './api.ts';
export {
  type Collection,
  type CollectionOptions,
  Db,
  DocumentExists,
  DocumentNotFound,
  type DocumentSchema,
  type KeyValue,
  type Page,
  type QueryOptions,
} from './db.ts';
export { AuthenticationLayer, toFetchHandler } from './http.ts';
export { observability } from './observability.ts';
export * as Platform from './platform.ts';
export {
  AppInfo,
  Auth,
  Events,
  Metrics,
  Queues,
  Secrets,
  type SendOptions,
  Storage,
  type Store,
  type StoredObject,
} from './services.ts';
export { defineWorker, type EffectWorkerDefinition } from './worker.ts';
