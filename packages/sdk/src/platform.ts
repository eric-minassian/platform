import { Layer } from 'effect';
import type { Authentication } from './api.ts';
import { Db } from './db.ts';
import { AuthenticationLayer } from './http.ts';
import { type MemoryOptions, layerMemory as memory, type PlatformMemory } from './memory.ts';
import {
  AppInfo,
  Auth,
  Email,
  Events,
  Jobs,
  Metrics,
  Queues,
  Realtime,
  Secrets,
  Storage,
} from './services.ts';

export {
  type InvokedJob,
  type MemoryOptions,
  PlatformMemory as Memory,
  type PublishedEvent,
  type RealtimePublish,
  type RecordedMetric,
  type SentEmail,
  type SentMessage,
} from './memory.ts';

/** Every platform service an app can use. */
export type Services =
  | AppInfo
  | Auth
  | Authentication
  | Db
  | Email
  | Events
  | Jobs
  | Metrics
  | Queues
  | Realtime
  | Secrets
  | Storage;

/** The stage's real resources, through its bindings. Provide it once, at the entry point. */
export const layer: Layer.Layer<Services> = Layer.mergeAll(
  AppInfo.layer,
  Db.layer,
  Email.layer,
  Events.layer,
  Jobs.layer,
  Metrics.layer,
  Queues.layer,
  Realtime.layer,
  Secrets.layer,
  Storage.layer,
).pipe(Layer.provideMerge(AuthenticationLayer.pipe(Layer.provideMerge(Auth.layer))));

/**
 * Every service in memory, for unit tests: no emulator, no AWS. `Memory`
 * exposes what was sent (queue messages and email), published (events and
 * realtime), invoked and counted.
 */
export const layerMemory = (options?: MemoryOptions): Layer.Layer<Services | PlatformMemory> =>
  AuthenticationLayer.pipe(Layer.provideMerge(memory(options)));
