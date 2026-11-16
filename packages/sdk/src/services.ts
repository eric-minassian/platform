import type { EmailMessage } from '@ericminassian/platform-core';
import { Context, Data, Duration, Effect, Layer, Option, Redacted, Schema } from 'effect';
import { HttpServerRequest } from 'effect/http';
import type { User } from './api.ts';
import type {
  ChannelEvent,
  ChannelName,
  EventDetail,
  EventType,
  PublicStoreName,
  QueueBody,
  QueueName,
  SecretName,
  StoreName,
} from './register.ts';
import { app } from './runtime/app.ts';
import { getUser } from './runtime/auth/index.ts';
import { EmailRefused, sendEmail } from './runtime/email.ts';
import { events } from './runtime/events.ts';
import { queue } from './runtime/queue.ts';
import { realtime } from './runtime/realtime.ts';
import { secrets } from './runtime/secrets.ts';
import { type StoredObject, storage } from './runtime/storage.ts';
import { metrics } from './runtime/telemetry.ts';
import { invokeJob } from './runtime/worker.ts';

/** Facts about the running stage. */
export class AppInfo extends Context.Service<
  AppInfo,
  {
    readonly name: string;
    /** `prod`, `pr-12`, `local`, `test`. */
    readonly stage: string;
    readonly host: string;
    /** Public origin, e.g. `https://todo.ericminassian.com`. */
    readonly url: string;
    readonly revision: string;
    /** Under `plat dev` / `plat test`. */
    readonly isLocal: boolean;
  }
>()('@ericminassian/platform/AppInfo') {
  static readonly layer: Layer.Layer<AppInfo> = Layer.sync(AppInfo, () =>
    AppInfo.of({
      name: app.name,
      stage: app.stage,
      host: app.host,
      url: app.url,
      revision: app.revision,
      isLocal: app.isLocal,
    }),
  );
}

/** The platform session behind the current HTTP request (`auth: true`). */
export class Auth extends Context.Service<
  Auth,
  {
    /** The signed-in user, from the session cookie or a bearer ID token. Refreshes an expired session. */
    readonly currentUser: Effect.Effect<Option.Option<User>, never, HttpServerRequest.HttpServerRequest>;
  }
>()('@ericminassian/platform/Auth') {
  static readonly layer: Layer.Layer<Auth> = Layer.succeed(
    Auth,
    Auth.of({
      currentUser: HttpServerRequest.HttpServerRequest.pipe(
        Effect.flatMap((request) => Effect.orDie(HttpServerRequest.toWeb(request))),
        Effect.flatMap((request) => Effect.promise(() => getUser(request))),
        Effect.map(Option.fromNullishOr),
      ),
    }),
  );
}

export interface SendOptions {
  /** Hold the message before it becomes visible (up to 15 minutes). */
  readonly delay?: Duration.Input;
}

/** Queues declared under `queues` in `plat.config.ts`; bodies have the declared types. */
export class Queues extends Context.Service<
  Queues,
  {
    send<K extends QueueName>(queue: K, body: QueueBody<K>, options?: SendOptions): Effect.Effect<void>;
    sendBatch<K extends QueueName>(queue: K, bodies: Iterable<QueueBody<K>>): Effect.Effect<void>;
  }
>()('@ericminassian/platform/Queues') {
  static readonly layer: Layer.Layer<Queues> = Layer.succeed(
    Queues,
    Queues.of({
      send: (name, body, options) =>
        Effect.promise(() =>
          queue(name).send(
            body,
            options?.delay === undefined ? undefined : { delaySeconds: delaySeconds(options.delay) },
          ),
        ),
      sendBatch: (name, bodies) => Effect.promise(() => queue(name).sendBatch([...bodies])),
    }),
  );
}

export const delaySeconds = (delay: Duration.Input): number => Math.round(Duration.toSeconds(delay));

/** This stage's event bus; event types are the ones under `events` in `plat.config.ts`. */
export class Events extends Context.Service<
  Events,
  { publish<K extends EventType>(type: K, detail: EventDetail<K>): Effect.Effect<void> }
>()('@ericminassian/platform/Events') {
  static readonly layer: Layer.Layer<Events> = Layer.succeed(
    Events,
    Events.of({ publish: (type, detail) => Effect.promise(() => events.publish(type, detail)) }),
  );
}

/**
 * Live updates to browsers on the channels under `realtime.channels` in
 * `plat.config.ts`; events have the declared types. Browsers subscribe with
 * `RealtimeClient` from `@ericminassian/platform/client`.
 */
export class Realtime extends Context.Service<
  Realtime,
  {
    /** Push `event` to every browser subscribed to `channel`. Not stored: absent browsers never see it. */
    publish<C extends ChannelName>(channel: C, event: ChannelEvent<C>): Effect.Effect<void>;
    /** Several events to one channel, in order. */
    publishMany<C extends ChannelName>(channel: C, events: Iterable<ChannelEvent<C>>): Effect.Effect<void>;
  }
>()('@ericminassian/platform/Realtime') {
  static readonly layer: Layer.Layer<Realtime> = Layer.succeed(
    Realtime,
    Realtime.of({
      publish: (channel, event) => Effect.promise(() => realtime.publish(channel, event)),
      publishMany: (channel, batch) => Effect.promise(() => realtime.publishMany(channel, batch)),
    }),
  );
}

/**
 * Why `Email.send` didn't send:
 * - `daily-limit`: the stage's recipients today would pass `email.dailyLimit`.
 * - `paused`: SES paused the stage's sending (its bounce or complaint rate,
 *   the owner in the console, or AWS). It stays paused until resumed.
 * - `rejected`: the message is invalid, or SES refused it.
 *
 * In a queue handler, letting it fail the job retries the message and then
 * dead-letters it.
 */
export class EmailNotSent extends Schema.TaggedError<EmailNotSent, { readonly brand: unique symbol }>()(
  'EmailNotSent',
  { reason: Schema.Literals(['daily-limit', 'paused', 'rejected']), message: Schema.String },
) {}

export type { EmailMessage } from '@ericminassian/platform-core';

/** Any other failure of a send; becomes a defect. */
class EmailFailure extends Data.TaggedError('EmailFailure')<{ readonly cause: unknown }> {}

/**
 * Transactional email (`email` in `plat.config.ts`) from the stage's own
 * address: `<app>@mail.platform.ericminassian.com` in prod,
 * `<app>--<stage>@…` elsewhere, with `email.name` as the display name. The
 * address takes no mail, so set `replyTo` where replies should go.
 *
 * - Every recipient counts against `email.dailyLimit` per UTC day (previews
 *   and `plat dev` get at most 50).
 * - Deployed stages skip recipients at reserved test domains (`example.com`,
 *   `*.test`, …) with a log line: they can never receive mail.
 * - Under `plat dev` and `plat test` nothing is sent: messages appear in the
 *   local inbox at `/__platform/mail`.
 *
 * Send from a queue handler where you can, so a failure retries instead of
 * failing a request.
 */
export class Email extends Context.Service<
  Email,
  {
    /** Sends one message. `id` is SES's message id (a generated one locally, or when every recipient was skipped). */
    send(message: EmailMessage): Effect.Effect<{ readonly id: string }, EmailNotSent>;
  }
>()('@ericminassian/platform/Email') {
  static readonly layer: Layer.Layer<Email> = Layer.succeed(
    Email,
    Email.of({
      send: (message) =>
        Effect.tryPromise({
          try: () => sendEmail(message),
          catch: (cause) =>
            cause instanceof EmailRefused
              ? new EmailNotSent({ reason: cause.reason, message: cause.message })
              : new EmailFailure({ cause }),
        }).pipe(Effect.catchTag('EmailFailure', (e) => Effect.die(e.cause))),
    }),
  );
}

export type { StoredObject } from './runtime/storage.ts';

/** A file store declared under `storage` in `plat.config.ts`. */
export interface Store {
  /**
   * Writes the file. `contentType` defaults to one from the key's extension;
   * `cacheControl` goes with the file wherever it's served, and the edge
   * caches a public store's files by it (`public, max-age=31536000, immutable`
   * for a key that never changes). Without it, browsers revalidate.
   */
  put(
    key: string,
    body: Uint8Array | string,
    options?: { readonly contentType?: string; readonly cacheControl?: string },
  ): Effect.Effect<void>;
  get(key: string): Effect.Effect<Option.Option<Uint8Array>>;
  getText(key: string): Effect.Effect<Option.Option<string>>;
  delete(key: string): Effect.Effect<void>;
  list(
    prefix?: string,
    options?: { readonly cursor?: string; readonly limit?: number },
  ): Effect.Effect<{ readonly objects: ReadonlyArray<StoredObject>; readonly cursor?: string | undefined }>;
  /**
   * URL the browser can `PUT` the file to directly. It must send the same
   * `Content-Type` and `Cache-Control` headers as given here.
   */
  uploadUrl(
    key: string,
    options?: {
      readonly contentType?: string;
      readonly cacheControl?: string;
      readonly expiresIn?: Duration.Input;
    },
  ): Effect.Effect<string>;
  downloadUrl(
    key: string,
    options?: { readonly expiresIn?: Duration.Input; readonly filename?: string },
  ): Effect.Effect<string>;
}

/** A store declared with `public: true`: the edge serves its files on the app's host. */
export interface PublicStore extends Store {
  /**
   * `https://<host>/__platform/storage/<store>/<key>`: anyone with it can read
   * the file. Browsers can build the same path with `storageUrl` from
   * `@ericminassian/platform/client`.
   */
  publicUrl(key: string): Effect.Effect<string>;
}

/** What `Storage.store(name)` gives: a `PublicStore` for a store declared `public: true`. */
export type StoreFor<Name extends string> = Name extends PublicStoreName ? PublicStore : Store;

export class Storage extends Context.Service<
  Storage,
  { store<Name extends StoreName>(name: Name): StoreFor<Name> }
>()('@ericminassian/platform/Storage') {
  static readonly layer: Layer.Layer<Storage> = Layer.succeed(
    Storage,
    Storage.of({
      store: (name) => {
        const s = storage(name);
        const store: PublicStore = {
          put: (key, body, options) => Effect.promise(() => s.put(key, body, options)),
          get: (key) =>
            Effect.map(
              Effect.promise(() => s.get(key)),
              Option.fromUndefinedOr,
            ),
          getText: (key) =>
            Effect.map(
              Effect.promise(() => s.getText(key)),
              Option.fromUndefinedOr,
            ),
          delete: (key) => Effect.promise(() => s.delete(key)),
          list: (prefix, options) => Effect.promise(() => s.list(prefix, options)),
          uploadUrl: (key, options) =>
            Effect.promise(() =>
              s.uploadUrl(key, {
                ...(options?.contentType ? { contentType: options.contentType } : {}),
                ...(options?.cacheControl ? { cacheControl: options.cacheControl } : {}),
                ...(options?.expiresIn ? { expiresInSeconds: Duration.toSeconds(options.expiresIn) } : {}),
              }),
            ),
          downloadUrl: (key, options) =>
            Effect.promise(() =>
              s.downloadUrl(key, {
                ...(options?.filename ? { filename: options.filename } : {}),
                ...(options?.expiresIn ? { expiresInSeconds: Duration.toSeconds(options.expiresIn) } : {}),
              }),
            ),
          // A private store has no `publicUrl` in its type; called anyway, it's a defect.
          publicUrl: (key) => Effect.sync(() => s.publicUrl(key)),
        };
        return store;
      },
    }),
  );
}

/** Secrets declared under `secrets` in `plat.config.ts` (`plat secrets set`, `.env.local` locally). */
export class Secrets extends Context.Service<
  Secrets,
  {
    /** The value; a defect naming the `plat secrets set` command when it isn't set. */
    get(name: SecretName): Effect.Effect<Redacted.Redacted>;
    getOptional(name: SecretName): Effect.Effect<Option.Option<Redacted.Redacted>>;
  }
>()('@ericminassian/platform/Secrets') {
  static readonly layer: Layer.Layer<Secrets> = Layer.succeed(
    Secrets,
    Secrets.of({
      get: (name) =>
        Effect.map(
          Effect.promise(() => secrets.get(name)),
          (v) => Redacted.make(v),
        ),
      getOptional: (name) =>
        Effect.map(
          Effect.promise(() => secrets.getOptional(name)),
          (v) => Option.map(Option.fromUndefinedOr(v), (s) => Redacted.make(s)),
        ),
    }),
  );
}

/** Direct jobs on this stage's worker: the `invoke` handlers in `defineWorker`. */
export class Jobs extends Context.Service<
  Jobs,
  {
    /**
     * Runs the worker's `invoke[name]` handler with `payload`, asynchronously:
     * this returns once the job is queued, and the job's failures show up in
     * the worker's telemetry, not here.
     */
    invoke(name: string, payload: unknown): Effect.Effect<void>;
  }
>()('@ericminassian/platform/Jobs') {
  static readonly layer: Layer.Layer<Jobs> = Layer.succeed(
    Jobs,
    Jobs.of({ invoke: (name, payload) => Effect.promise(() => invokeJob(name, payload)) }),
  );
}

/** Custom metrics: free, and shown in the console and `plat metrics`. */
export class Metrics extends Context.Service<
  Metrics,
  {
    count(name: string, n?: number): Effect.Effect<void>;
    value(name: string, value: number, unit?: string): Effect.Effect<void>;
  }
>()('@ericminassian/platform/Metrics') {
  static readonly layer: Layer.Layer<Metrics> = Layer.succeed(
    Metrics,
    Metrics.of({
      count: (name, n = 1) => Effect.sync(() => metrics.count(name, n)),
      value: (name, value, unit) => Effect.sync(() => metrics.value(name, value, unit)),
    }),
  );
}
