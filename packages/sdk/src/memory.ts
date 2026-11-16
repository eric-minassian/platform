import { randomUUID } from 'node:crypto';
import { checkEmailMessage, type EmailMessage, emailUsageDay, names } from '@ericminassian/platform-core';
import { Clock, Context, Effect, Layer, Option, Redacted } from 'effect';
import { HttpServerRequest } from 'effect/http';
import type { User } from './api.ts';
import { Db } from './db.ts';
import { makeRateLimits, memoryCounters, type RateLimitCheck, RateLimits } from './rate-limit.ts';
import { emailRefusals } from './runtime/email.ts';
import { encodeRealtimeEvents, realtimeChannelError } from './runtime/realtime.ts';
import { objectKey, type StoredObject } from './runtime/storage.ts';
import {
  AppInfo,
  Auth,
  delaySeconds,
  Email,
  EmailNotSent,
  Events,
  Jobs,
  Metrics,
  Queues,
  Realtime,
  Secrets,
  Storage,
  type Store,
} from './services.ts';

export interface SentMessage {
  readonly queue: string;
  readonly body: unknown;
  readonly delaySeconds?: number;
}

export interface PublishedEvent {
  readonly type: string;
  readonly detail: unknown;
}

/** A realtime event as subscribers would receive it (after a JSON round trip). */
export interface RealtimePublish {
  readonly channel: string;
  readonly event: unknown;
}

/** A message `Email.send` accepted, with its recipients normalized. */
export interface SentEmail {
  readonly id: string;
  readonly to: ReadonlyArray<string>;
  readonly replyTo: ReadonlyArray<string>;
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
}

export interface InvokedJob {
  readonly name: string;
  readonly payload: unknown;
}

export interface RecordedMetric {
  readonly name: string;
  readonly value: number;
  readonly unit?: string;
}

/** What `Platform.layerMemory` recorded, for assertions in tests. */
export class PlatformMemory extends Context.Service<
  PlatformMemory,
  {
    readonly sent: Effect.Effect<ReadonlyArray<SentMessage>>;
    readonly published: Effect.Effect<ReadonlyArray<PublishedEvent>>;
    readonly realtime: Effect.Effect<ReadonlyArray<RealtimePublish>>;
    /** Messages `Email.send` accepted, oldest first. */
    readonly emails: Effect.Effect<ReadonlyArray<SentEmail>>;
    readonly metrics: Effect.Effect<ReadonlyArray<RecordedMetric>>;
    /** Every `RateLimits` check, oldest first, with the key it counted and whether it fit. */
    readonly rateLimits: Effect.Effect<ReadonlyArray<RateLimitCheck>>;
    /** Jobs invoked with `Jobs.invoke`; nothing runs them. */
    readonly invoked: Effect.Effect<ReadonlyArray<InvokedJob>>;
  }
>()('@ericminassian/platform/PlatformMemory') {}

export interface MemoryOptions {
  /**
   * Users `Auth` recognizes. A request is signed in as the user whose `id` it
   * sends as a bearer token (`Authorization: Bearer <id>`).
   */
  readonly users?: ReadonlyArray<User>;
  readonly secrets?: Readonly<Record<string, string>>;
  readonly app?: Partial<AppInfo['Service']>;
  /**
   * The app's `realtime.channels` patterns. With them, `Realtime` rejects
   * undeclared channels like the deployed app does; without them it only
   * checks that channel names are well formed.
   */
  readonly realtime?: { readonly channels: ReadonlyArray<string> };
  /**
   * How `Email` behaves: `dailyLimit` caps recipients per UTC day (by the
   * effect `Clock`; unlimited by default), and `paused` refuses every send,
   * as SES does for a paused stage. Both fail with `EmailNotSent`.
   */
  readonly email?: { readonly dailyLimit?: number; readonly paused?: boolean };
}

/** Every platform service in memory, plus `PlatformMemory`. Each build starts empty. */
export const layerMemory = (
  options: MemoryOptions = {},
): Layer.Layer<
  | AppInfo
  | Auth
  | Db
  | Email
  | Events
  | Jobs
  | Metrics
  | Queues
  | RateLimits
  | Realtime
  | Secrets
  | Storage
  | PlatformMemory
> =>
  Layer.mergeAll(
    Db.layerMemory(),
    Layer.effectContext(
      Effect.sync(() => {
        const sent: SentMessage[] = [];
        const published: PublishedEvent[] = [];
        const realtimeEvents: RealtimePublish[] = [];
        // A throw inside Effect.sync is a defect, like a misnamed channel in the deployed app.
        const publishRealtime = (channel: string, events: ReadonlyArray<unknown>) =>
          Effect.sync(() => {
            const problem = realtimeChannelError(channel, options.realtime?.channels ?? [channel]);
            if (problem) throw new Error(problem);
            for (const e of encodeRealtimeEvents(channel, events))
              realtimeEvents.push({ channel, event: JSON.parse(e) });
          });
        const recorded: RecordedMetric[] = [];
        const invoked: InvokedJob[] = [];
        const limitChecks: RateLimitCheck[] = [];
        const users = new Map((options.users ?? []).map((u) => [u.id, u]));
        const secrets = new Map(Object.entries(options.secrets ?? {}));
        const appInfo = AppInfo.of({
          name: 'test-app',
          stage: 'test',
          host: 'test-app.localhost',
          url: 'http://test-app.localhost:3000',
          revision: 'dtest',
          isLocal: true,
          ...options.app,
        });

        const emails: SentEmail[] = [];
        /** Recipients per UTC day, like the stage's usage rows. */
        const emailUsage = new Map<string, number>();
        const sendEmail = (message: EmailMessage) =>
          Effect.gen(function* () {
            const checked = checkEmailMessage(message);
            if (!checked.ok) return yield* new EmailNotSent({ reason: 'rejected', message: checked.message });
            if (options.email?.paused) {
              const tenant = names.emailTenant(appInfo.name, appInfo.stage);
              return yield* new EmailNotSent({
                reason: 'paused',
                message: emailRefusals.paused(tenant, appInfo.stage),
              });
            }
            const day = emailUsageDay(yield* Clock.currentTimeMillis);
            const used = emailUsage.get(day) ?? 0;
            const limit = options.email?.dailyLimit;
            const k = checked.to.length;
            if (limit !== undefined && used + k > limit)
              return yield* new EmailNotSent({
                reason: 'daily-limit',
                message: emailRefusals.dailyLimit(limit, k),
              });
            emailUsage.set(day, used + k);
            const id = randomUUID();
            emails.push({
              id,
              to: checked.to,
              replyTo: checked.replyTo,
              subject: message.subject,
              text: message.text,
              ...(message.html !== undefined ? { html: message.html } : {}),
            });
            return { id };
          });

        return Context.make(AppInfo, appInfo).pipe(
          Context.add(
            Auth,
            Auth.of({
              currentUser: Effect.map(HttpServerRequest.HttpServerRequest, (request) => {
                const token = /^Bearer\s+(.+)$/i.exec(request.headers.authorization ?? '')?.[1];
                return Option.fromUndefinedOr(token === undefined ? undefined : users.get(token));
              }),
            }),
          ),
          Context.add(
            Queues,
            Queues.of({
              send: (queue, body, opts) =>
                Effect.sync(() => {
                  sent.push({
                    queue,
                    body,
                    ...(opts?.delay === undefined ? {} : { delaySeconds: delaySeconds(opts.delay) }),
                  });
                }),
              sendBatch: (queue, bodies) =>
                Effect.sync(() => {
                  for (const body of bodies) sent.push({ queue, body });
                }),
            }),
          ),
          Context.add(
            Events,
            Events.of({
              publish: (type, detail) => Effect.sync(() => void published.push({ type, detail })),
            }),
          ),
          Context.add(
            Realtime,
            Realtime.of({
              publish: (channel, event) => publishRealtime(channel, [event]),
              publishMany: (channel, events) => publishRealtime(channel, [...events]),
            }),
          ),
          Context.add(Email, Email.of({ send: sendEmail })),
          Context.add(
            RateLimits,
            makeRateLimits(memoryCounters(), (check) => void limitChecks.push(check)),
          ),
          Context.add(Storage, Storage.of({ store: memoryStores() })),
          Context.add(
            Secrets,
            Secrets.of({
              get: (name) =>
                Effect.suspend(() => {
                  const value = secrets.get(name);
                  return value === undefined
                    ? Effect.die(new Error(`Secret ${name} is not set in Platform.layerMemory({ secrets })`))
                    : Effect.succeed(Redacted.make(value));
                }),
              getOptional: (name) =>
                Effect.sync(() =>
                  Option.map(Option.fromUndefinedOr(secrets.get(name)), (v) => Redacted.make(v)),
                ),
            }),
          ),
          Context.add(
            Metrics,
            Metrics.of({
              count: (name, n = 1) =>
                Effect.sync(() => void recorded.push({ name, value: n, unit: 'count' })),
              value: (name, value, unit) =>
                Effect.sync(() => void recorded.push({ name, value, ...(unit ? { unit } : {}) })),
            }),
          ),
          Context.add(
            Jobs,
            Jobs.of({ invoke: (name, payload) => Effect.sync(() => void invoked.push({ name, payload })) }),
          ),
          Context.add(
            PlatformMemory,
            PlatformMemory.of({
              sent: Effect.sync(() => [...sent]),
              published: Effect.sync(() => [...published]),
              realtime: Effect.sync(() => [...realtimeEvents]),
              emails: Effect.sync(() => [...emails]),
              metrics: Effect.sync(() => [...recorded]),
              rateLimits: Effect.sync(() => [...limitChecks]),
              invoked: Effect.sync(() => [...invoked]),
            }),
          ),
        );
      }),
    ),
  );

/** Stores in memory. Keys are validated like S3 keys; signed URLs are `memory://<store>/<key>`. */
function memoryStores(): (name: string) => Store {
  const stores = new Map<string, Map<string, Uint8Array>>();
  return (name) => {
    const objects = stores.get(name) ?? new Map<string, Uint8Array>();
    stores.set(name, objects);
    const key = (k: string) => objectKey('', k);
    const get = (k: string) => Effect.sync(() => Option.fromUndefinedOr(objects.get(key(k))));
    return {
      put: (k, body) =>
        Effect.sync(
          () => void objects.set(key(k), typeof body === 'string' ? new TextEncoder().encode(body) : body),
        ),
      get,
      getText: (k) =>
        Effect.map(
          get(k),
          Option.map((bytes) => new TextDecoder().decode(bytes)),
        ),
      delete: (k) => Effect.sync(() => void objects.delete(key(k))),
      list: (prefix = '', opts) =>
        Effect.sync(() => {
          const all: StoredObject[] = [...objects.entries()]
            .filter(([k]) => k.startsWith(prefix.replace(/^\/+/, '')) && (!opts?.cursor || k > opts.cursor))
            .toSorted(([a], [b]) => (a < b ? -1 : 1))
            .map(([k, bytes]) => ({ key: k, size: bytes.byteLength }));
          const page = all.slice(0, opts?.limit ?? 1000);
          return page.length < all.length ? { objects: page, cursor: page.at(-1)!.key } : { objects: page };
        }),
      uploadUrl: (k) => Effect.sync(() => `memory://${name}/${key(k)}`),
      downloadUrl: (k) => Effect.sync(() => `memory://${name}/${key(k)}`),
    };
  };
}
