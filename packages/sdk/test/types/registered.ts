// The SDK against the registered config in ./plat.config.ts. Every
// expected error below is a mistake the registered config must catch.
import {
  type ChannelEvent,
  Db,
  defineWorker,
  Events,
  Platform,
  type QueueMessage,
  Queues,
  Realtime,
  Secrets,
  Storage,
} from '@ericminassian/platform';
import { RealtimeClient, type RealtimeStatus } from '@ericminassian/platform/client';
import { Context, Effect, Schema, Stream } from 'effect';
import type { BoardEvent, Cursor, EmailJob, Notice } from './plat.config.ts';

export const usage = Effect.gen(function* () {
  const queues = yield* Queues;
  yield* queues.send('emails', { to: 'a@example.com' }, { delay: '30 seconds' });
  yield* queues.sendBatch('plain', [1, 'two']);
  // @ts-expect-error body doesn't match queue<EmailJob>()
  yield* queues.send('emails', { email: 'a@example.com' });
  // @ts-expect-error undeclared queue
  yield* queues.send('emailz', {});

  const events = yield* Events;
  yield* events.publish('todo.created', { id: '1' });
  // @ts-expect-error detail doesn't match event<TodoCreated>()
  yield* events.publish('todo.created', { id: 1 });
  // @ts-expect-error undeclared event
  yield* events.publish('todo.deleted', {});

  const storage = yield* Storage;
  storage.store('uploads');
  // @ts-expect-error undeclared store
  storage.store('upload');
  const secrets = yield* Secrets;
  yield* secrets.get('STRIPE_KEY');
  // @ts-expect-error undeclared secret
  yield* secrets.getOptional('STRIPE');

  const realtime = yield* Realtime;
  yield* realtime.publish('board', { stroke: [1, 2] });
  yield* realtime.publish(`boards/${'b1' as string}`, { stroke: [] });
  yield* realtime.publishMany(`user/${'u1' as string}`, [{ text: 'hi' }]);
  // @ts-expect-error event doesn't match channel<BoardEvent>()
  yield* realtime.publish('board', { text: 'hi' });
  // @ts-expect-error event doesn't match channel<Notice>()
  yield* realtime.publish('user/u1', { stroke: [] });
  // @ts-expect-error undeclared channel
  yield* realtime.publish('boardz', { stroke: [] });
  // @ts-expect-error `board` is exact, not a prefix
  yield* realtime.publish('board/b1', { stroke: [] });
  // A channel under two declared patterns takes either declared type.
  const both: ChannelEvent<'boards/cursors/c1'> = { x: 1, y: 2 } satisfies Cursor;
  const alsoBoard: ChannelEvent<'boards/cursors/c1'> = { stroke: [] } satisfies BoardEvent;
  return [both, alsoBoard];
});

export const browserStreams = Effect.gen(function* () {
  const board: Stream.Stream<BoardEvent> = RealtimeClient.subscribe('board');
  const below: Stream.Stream<BoardEvent | Cursor> = RealtimeClient.subscribe('boards/*');
  const notices: Stream.Stream<Notice> = RealtimeClient.subscribe('user/u1');
  // @ts-expect-error the stream's type disagrees with channel<BoardEvent>()
  const wrong: Stream.Stream<Notice> = RealtimeClient.subscribe('board');
  // @ts-expect-error undeclared channel
  RealtimeClient.subscribe('nowhere');
  const status: Stream.Stream<RealtimeStatus> = RealtimeClient.status;
  yield* Stream.runDrain(Stream.merge(Stream.merge(board, below), notices));
  yield* Stream.runDrain(status);
  return wrong;
});

const handlers = {
  queues: {
    emails: (message: QueueMessage<EmailJob>) => Effect.succeed(message.body.to.toUpperCase()),
    plain: () => Effect.void,
  },
  events: { 'todo.created': () => Effect.void },
  crons: { cleanup: () => Effect.void },
};

export const complete = defineWorker({
  layer: Platform.layer,
  queues: {
    emails: (message) => Effect.map(Queues, () => message.body.to),
    plain: () => Effect.void,
  },
  events: { 'todo.created': (event) => Effect.succeed(event.detail.id) },
  crons: { cleanup: () => Effect.void },
  invoke: { anything: (payload: { id: string }) => Effect.succeed(payload.id) },
});

export const missingHandler = defineWorker({
  layer: Platform.layer,
  // @ts-expect-error `plain` has no handler
  queues: { emails: () => Effect.void },
  events: handlers.events,
  crons: handlers.crons,
});

class Unknown extends Context.Service<Unknown, object>()('Unknown') {}

export const unprovided = defineWorker({
  layer: Platform.layerMemory(),
  ...handlers,
  // @ts-expect-error the layer doesn't provide `Unknown`
  crons: { cleanup: () => Effect.asVoid(Unknown) },
});

export const wrongPayload = defineWorker({
  layer: Platform.layer,
  ...handlers,
  queues: {
    // @ts-expect-error the handler's type disagrees with queue<EmailJob>()
    emails: (message: QueueMessage<{ email: string }>) => Effect.succeed(message.body.email),
    plain: () => Effect.void,
  },
});

const Note = Schema.Struct({ ownerId: Schema.String, noteId: Schema.String });

export const cursors = Effect.gen(function* () {
  const notes = (yield* Db).collection('notes', { schema: Note, partition: 'ownerId', sort: 'noteId' });
  const firstPage: Effect.Effect<unknown> = notes.query({ ownerId: 'a' }, { limit: 10 });
  // @ts-expect-error a query given a cursor can fail with InvalidCursor
  const nextPage: Effect.Effect<unknown> = notes.query({ ownerId: 'a' }, { cursor: 'c' });
  // @ts-expect-error the key needs every key field
  yield* notes.get({ ownerId: 'a' });
  return [firstPage, nextPage];
});
