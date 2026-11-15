import type { AppConfig, PayloadOf } from '@ericminassian/platform-core';

/**
 * Each app's `plat.config.ts` registers its config here:
 *
 *   declare module '@ericminassian/platform/config' {
 *     interface Register { app: typeof app }
 *   }
 *
 * Queue, event, cron, store and secret names (and declared payload types) are
 * then checked wherever the SDK takes one. Without it they're plain strings.
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

type Queues = App extends { queues: infer Q } ? Q : Record<never, never>;
type Events = App extends { events: infer E } ? E : readonly [];

/** Payloads the config doesn't type: handlers choose their own (`QueueMessage<MyJob>`). */
// biome-ignore lint/suspicious/noExplicitAny: handlers choose their own payload types
export type AnyPayload = any;

export type QueueName = Registered extends true ? Keys<Queues> : string;
export type EventType = Registered extends true
  ? Events extends readonly string[]
    ? Items<Events>
    : Keys<Events>
  : string;
export type CronName = Registered extends true ? (App extends { crons: infer C } ? Keys<C> : never) : string;
export type StoreName = Registered extends true
  ? App extends { storage: infer S }
    ? Items<S>
    : never
  : string;
export type SecretName = Registered extends true
  ? App extends { secrets: infer S }
    ? Items<S>
    : never
  : string;

/** Body type declared with `queue<T>()` in `plat.config.ts`. */
export type QueueBody<K extends string> = Registered extends true
  ? K extends keyof Queues
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
