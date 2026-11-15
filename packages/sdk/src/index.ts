/**
 * @ericminassian/platform — the only thing app code imports. Cloud-neutral
 * interfaces backed by AWS (DynamoDB, SQS, EventBridge, S3, SSM, Cognito)
 * through bindings the engine injects. Under `plat dev` the same code talks to
 * the AWS Emulator, so there is exactly one implementation.
 *
 * This is the promise API, for apps not written with Effect (the control
 * plane). Effect apps, and the template, use `@ericminassian/platform/effect`,
 * which is built on it.
 *
 * CONTRACT: used by the control plane and the Effect SDK. Keep signatures stable.
 */
export type { PlatformUser } from '@ericminassian/platform-core';
export { type AppInfo, app } from './app.ts';
export { type Auth, auth } from './auth/index.ts';
export { setRoute } from './context.ts';
export { InvalidCursorError } from './cursor.ts';
export {
  type Collection,
  type CollectionOptions,
  type Db,
  db,
  type KeyValue,
  type Page,
  type QueryOptions,
} from './db.ts';
export { type Events, events } from './events.ts';
export { type Queue, queue } from './queue.ts';
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
export { type Secrets, secrets } from './secrets.ts';
export { type Store, type StoredObject, storage } from './storage.ts';
export { log, metrics } from './telemetry.ts';
export { invokeJob } from './worker.ts';

export interface Metrics {
  count(name: string, n?: number): void;
  value(name: string, value: number, unit?: string): void;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown> | unknown): void;
}
