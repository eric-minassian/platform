/**
 * `@ericminassian/platform`: what app code imports. Every platform resource
 * as an Effect service, the web server and worker entry points, and an
 * in-memory platform for unit tests. Backed by AWS (DynamoDB, SQS,
 * EventBridge, S3, SSM, Cognito, AppSync Events, SES) through the bindings
 * the engine injects; under `plat dev` the same code talks to the AWS
 * Emulator, and email goes to a local inbox.
 *
 *   // src/server.ts
 *   export default toFetchHandler(HttpLive.pipe(Layer.provide(Platform.layer)));
 *
 *   // src/worker.ts
 *   export default defineWorker({ layer: Platform.layer, queues: { ... }, ... });
 *
 * The browser-safe pieces an `HttpApi` definition needs (`Authentication`,
 * `CurrentUser`, `User`) are in `@ericminassian/platform/api`; browsers
 * subscribe to realtime channels with `@ericminassian/platform/client`.
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
  RateLimited,
  Unauthorized,
  User,
} from './api.ts';
export { type ClientInfo, clientInfo } from './client-info.ts';
export {
  type Collection,
  type CollectionOptions,
  ConditionFailed,
  Db,
  DocumentExists,
  DocumentNotFound,
  type DocumentSchema,
  type GetOptions,
  type Increments,
  type KeyValue,
  type Page,
  type QueryAllOptions,
  type QueryOptions,
  TransactionCanceled,
  type TransactWrite,
  type TransactWrites,
} from './db.ts';
export { AuthenticationLayer, toFetchHandler } from './http.ts';
export { observability } from './observability.ts';
export * as Platform from './platform.ts';
export {
  type RateLimitCheck,
  type RateLimitMiddleware,
  type RateLimitOptions,
  type RateLimitPolicy,
  type RateLimitResult,
  RateLimits,
} from './rate-limit.ts';
export type {
  ChannelEvent,
  ChannelName,
  ChannelSubscription,
  CronName,
  EventDetail,
  EventType,
  PublicStoreName,
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
  Email,
  type EmailMessage,
  EmailNotSent,
  Events,
  Jobs,
  Metrics,
  type PublicStore,
  Queues,
  Realtime,
  Secrets,
  type SendOptions,
  Storage,
  type Store,
  type StoredObject,
  type StoreFor,
} from './services.ts';
export { traced } from './traced.ts';
export { defineWorker, type WorkerDefinition } from './worker.ts';
