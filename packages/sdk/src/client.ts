/**
 * `@ericminassian/platform/client`: realtime for the browser, as streams over
 * the page's one WebSocket.
 *
 *   import { RealtimeClient } from '@ericminassian/platform/client';
 *
 *   RealtimeClient.subscribe('board').pipe(Stream.runForEach(draw));
 *   RealtimeClient.status.pipe(Stream.filter((s) => s === 'connected'), Stream.runForEach(refetch));
 *
 * Channel names and event types come from `realtime.channels` in
 * `plat.config.ts` when the web project's TypeScript program includes it.
 * Browser-safe: nothing here reaches Node or AWS code.
 *
 * CONTRACT: documented in templates/app/AGENTS.md. Keep stable.
 */
import { Effect, Queue, Stream } from 'effect';
import { createRealtimeClient, type RealtimeEnv, type RealtimeStatus } from './realtime-client.ts';
import type { ChannelEvent, ChannelSubscription } from './register.ts';

export type { RealtimeStatus } from './realtime-client.ts';
export type { ChannelEvent, ChannelSubscription } from './register.ts';

/** The page's own WebSocket, fetch, location, document and timers. */
function browserEnv(): RealtimeEnv {
  const g = globalThis as unknown as {
    WebSocket: RealtimeEnv['WebSocket'];
    fetch: RealtimeEnv['fetch'];
    location: RealtimeEnv['location'];
    document?: RealtimeEnv['document'];
  };
  if (typeof g.WebSocket !== 'function' || !g.location)
    throw new Error('@ericminassian/platform/client runs in the browser (it needs WebSocket and location)');
  return {
    WebSocket: g.WebSocket,
    fetch: (url, init) => g.fetch(url, init),
    location: g.location,
    ...(g.document ? { document: g.document } : {}),
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
    now: () => Date.now(),
    random: () => Math.random(),
    report: (message, error) => (error === undefined ? console.warn(message) : console.error(message, error)),
  };
}

let client: ReturnType<typeof createRealtimeClient> | undefined;
/** One connection per page, created on first use, so importing this module (e.g. while server-rendering) touches nothing. */
const page = () => {
  client ??= createRealtimeClient(browserEnv());
  return client;
};

export const RealtimeClient = {
  /**
   * Events published to `channel` (or below a declared `prefix/*`) while the
   * stream runs; it subscribes when it starts and unsubscribes when it ends.
   * Events aren't stored: pair it with `status` to re-read on reconnect.
   */
  subscribe: <C extends ChannelSubscription>(channel: C): Stream.Stream<ChannelEvent<C>> =>
    Stream.callback<ChannelEvent<C>>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => page().subscribe(channel, (event) => void Queue.offerUnsafe(queue, event))),
        (unsubscribe) => Effect.sync(unsubscribe),
      ),
    ),

  /**
   * The connection's status: the current one first, then every change.
   * `connected` is when to re-read what the page shows; `unauthorized` means
   * a `signed-in` app and nobody signed in.
   */
  status: Stream.callback<RealtimeStatus>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const c = page();
        Queue.offerUnsafe(queue, c.status);
        return c.onStatus((status) => void Queue.offerUnsafe(queue, status));
      }),
      (stop) => Effect.sync(stop),
    ),
  ),
};
