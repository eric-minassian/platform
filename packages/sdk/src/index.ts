/**
 * `@ericminassian/platform`: what app code imports. Every platform resource
 * as an Effect service, the web server and worker entry points, and an
 * in-memory platform for unit tests. Backed by AWS (DynamoDB, SQS,
 * EventBridge, S3, SSM, Cognito) through the bindings the engine injects; under
 * `plat dev` the same code talks to the AWS Emulator.
 *
 *   // src/server.ts
 *   export default toFetchHandler(HttpLive.pipe(Layer.provide(Platform.layer)));
 *
 *   // src/worker.ts
 *   export default defineWorker({ layer: Platform.layer, queues: { ... }, ... });
 *
 * The browser-safe pieces an `HttpApi` definition needs (`Authentication`,
 * `CurrentUser`, `User`) are in `@ericminassian/platform/api`.
 *
 * CONTRACT: documented in templates/app/AGENTS.md and used by every app.
 */
export type { PlatformUser } from '@ericminassian/platform-core';
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
export type {
  CronName,
  EventDetail,
  EventType,
  QueueBody,
  QueueName,
  Register,
  SecretName,
  StoreName,
} from './register.ts';
export type { JobContext, LogsBatch, PlatformEvent, QueueMessage } from './runtime/worker.ts';
export {
  AppInfo,
  Auth,
  Events,
  Jobs,
  Metrics,
  Queues,
  Secrets,
  type SendOptions,
  Storage,
  type Store,
  type StoredObject,
} from './services.ts';
export { defineWorker, type WorkerDefinition } from './worker.ts';
