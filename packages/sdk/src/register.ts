import type { AppConfig, PayloadOf } from '@ericminassian/platform-core';

/**
 * Each app's `plat.config.ts` registers its config here:
 *
 *   declare module '@ericminassian/platform/config' {
 *     interface Register { app: typeof app }
 *   }
 *
 * Queue, event, cron, store, secret and channel names (and declared payload
 * types) are then checked wherever the SDK takes one. Without it they're
 * plain strings.
 */
export interface Register {
  // Module augmentation needs an interface, and an empty one would accept any
  // value; this never-set member keeps it an object type with no usable keys.
  readonly [unregistered]?: never;
}
declare const unregistered: unique symbol;

type App = Register extends { app: infer A extends AppConfig } ? A : never;
type Registered = [App] extends [never] ? false : true;

type Keys<O> = O extends object ? Extract<keyof O, string> : never;
type Items<A> = A extends readonly (infer S extends string)[] ? S : never;

type Queues = App extends { queues: infer Q } ? Q : never;
type Events = App extends { events: infer E } ? E : readonly [];
type Channels = App extends { realtime: { channels: infer C } } ? C : never;
type Stores = App extends { storage: infer S } ? S : never;
type ChannelPattern = Keys<Channels>;
/** The concrete channels a declared pattern covers: `board` → `board`; `boards/*` → `boards/${string}`. */
type ChannelsOf<P extends string> = P extends `${infer Prefix}/*` ? `${Prefix}/${string}` : P;

/** Payloads the config doesn't type: handlers choose their own (`QueueMessage<MyJob>`). */
// oxlint-disable-next-line typescript/no-explicit-any -- handlers choose their own payload types
export type AnyPayload = any;

export type QueueName = Registered extends true ? Keys<Queues> : string;
export type EventType = Registered extends true
  ? Events extends readonly string[]
    ? Items<Events>
    : Keys<Events>
  : string;
export type CronName = Registered extends true ? (App extends { crons: infer C } ? Keys<C> : never) : string;
export type StoreName = Registered extends true
  ? Stores extends readonly string[]
    ? Items<Stores>
    : Keys<Stores>
  : string;
/** Stores declared with `public: true`, whose files the edge serves. */
export type PublicStoreName = Registered extends true
  ? Stores extends readonly string[]
    ? never
    : { [K in Keys<Stores>]: Stores[K] extends { public: true } ? K : never }[Keys<Stores>]
  : string;
export type SecretName = Registered extends true
  ? App extends { secrets: infer S }
    ? Items<S>
    : never
  : string;

/** Body type declared with `queue<T>()` in `plat.config.ts`. */
export type QueueBody<K extends string> = Registered extends true
  ? K extends Keys<Queues>
    ? PayloadOf<Queues[K]>
    : unknown
  : AnyPayload;

/** Detail type declared with `event<T>()` in `plat.config.ts`. */
export type EventDetail<K extends string> = Registered extends true
  ? Events extends readonly string[]
    ? unknown
    : K extends keyof Events
      ? PayloadOf<Events[K]>
      : unknown
  : AnyPayload;

/** A channel the server and worker can publish to: one declared under `realtime.channels`, or below a `prefix/*` one. */
export type ChannelName = Registered extends true ? ChannelsOf<ChannelPattern> : string;

/** What a browser can subscribe to: a channel, or a declared `prefix/*` pattern (every channel below it). */
export type ChannelSubscription = Registered extends true ? SubscriptionsOf<ChannelPattern> : string;
type SubscriptionsOf<P extends string> = ChannelsOf<P> | Extract<P, `${string}/*`>;

/** Event type declared with `channel<T>()` for a channel (a union when several declared patterns cover it). */
export type ChannelEvent<C extends string> = Registered extends true
  ? { [P in ChannelPattern]: C extends ChannelsOf<P> ? PayloadOf<Channels[P]> : never }[ChannelPattern]
  : AnyPayload;
