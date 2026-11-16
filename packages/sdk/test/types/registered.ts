// The SDK against the registered config in ./plat.config.ts. Every
// expected error below is a mistake the registered config must catch.
import {
  type ChannelEvent,
  type ConditionFailed,
  Db,
  type DocumentNotFound,
  defineService,
  defineWorker,
  Email,
  type EmailNotSent,
  Events,
  Platform,
  type QueueMessage,
  Queues,
  RateLimited,
  type RateLimitResult,
  RateLimits,
  Realtime,
  Secrets,
  Storage,
  traced,
} from '@ericminassian/platform';
import { RealtimeClient, type RealtimeStatus, storageUrl } from '@ericminassian/platform/client';
import { Context, Effect, Layer, Schema, Stream } from 'effect';
import type { HttpServerRequest } from 'effect/http';
import { HttpApiMiddleware } from 'effect/http-api';
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
  const uploads = storage.store('uploads');
  yield* uploads.uploadUrl('a.png', { contentType: 'image/png', cacheControl: 'no-cache' });
  // A private store isn't served from the edge.
  const privateHasNoUrl: 'publicUrl' extends keyof typeof uploads ? false : true = true;
  // @ts-expect-error undeclared store
  storage.store('upload');
  const snapshots = storage.store('snapshots');
  yield* snapshots.put('fires.json', '{}', { cacheControl: 'public, max-age=60' });
  const fires: string = yield* snapshots.publicUrl('fires.json');
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
  return [both, alsoBoard, fires, privateHasNoUrl];
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

export const browserFiles = (): string[] => [
  storageUrl('snapshots', 'fires/latest.json'),
  // @ts-expect-error a private store isn't served from the edge
  storageUrl('uploads', 'a.png'),
];

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

export const email = Effect.gen(function* () {
  const mail = yield* Email;
  const sent: Effect.Effect<{ readonly id: string }, EmailNotSent> = mail.send({
    to: ['a@example.com', 'b@example.com'],
    subject: 'Welcome',
    text: 'Hello',
    html: '<p>Hello</p>',
    replyTo: 'support@example.com',
  });
  // @ts-expect-error a send can fail with EmailNotSent
  const unchecked: Effect.Effect<{ readonly id: string }> = mail.send({
    to: 'a@example.com',
    subject: 'x',
    text: 'y',
  });
  // @ts-expect-error a message needs a subject
  yield* mail.send({ to: 'a@example.com', text: 'Hello' });
  // @ts-expect-error a message needs a text body
  yield* mail.send({ to: 'a@example.com', subject: 'Hi', html: '<p>Hi</p>' });
  const handled: Effect.Effect<string> = sent.pipe(
    Effect.map(({ id }) => id),
    Effect.catchTag('EmailNotSent', (e) =>
      Effect.succeed(e.reason satisfies 'daily-limit' | 'paused' | 'rejected'),
    ),
  );
  return [unchecked, handled];
});

export const ingest = defineService({
  layer: Platform.layer,
  run: Effect.forever(
    Effect.gen(function* () {
      const queues = yield* Queues;
      yield* queues.send('emails', { to: 'a@example.com' });
    }).pipe(traced('relay')),
  ),
});

export const unprovidedService = defineService({
  layer: Platform.layerMemory(),
  // @ts-expect-error the layer doesn't provide `Unknown`
  run: Effect.asVoid(Unknown),
});

class Dropped extends Schema.TaggedError<Dropped>()('Dropped', {}) {}

// `traced` keeps the effect's success, error and requirement types.
export const tracedTypes: Effect.Effect<string, Dropped, Queues> = Effect.flatMap(Queues, () =>
  Effect.fail(new Dropped()),
).pipe(Effect.as('done'), traced('typed'));

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

export const consistentReads = Effect.gen(function* () {
  const notes = (yield* Db).collection('notes', {
    schema: Note,
    partition: 'ownerId',
    sort: 'noteId',
    indexes: { byNote: { slot: 1, partition: 'noteId' } },
  });
  yield* notes.get({ ownerId: 'a', noteId: 'n' }, { consistent: true });
  yield* notes.query({ ownerId: 'a' }, { consistent: true, limit: 10 });
  yield* notes.queryAll({ ownerId: 'a' }, { consistent: true });
  yield* notes.query({ noteId: 'n' }, { index: 'byNote', consistent: false });
  // @ts-expect-error secondary indexes are only eventually consistent
  yield* notes.query({ noteId: 'n' }, { index: 'byNote', consistent: true });
  // @ts-expect-error secondary indexes are only eventually consistent
  yield* notes.queryAll({ noteId: 'n' }, { index: 'byNote', consistent: true });
  // An index chosen at run time may be set, so it can't be combined with `consistent: true`.
  const byNoteOrKey = (index: string | undefined) => [
    notes.query({ noteId: 'n' }, { index }),
    // @ts-expect-error the index might be set
    notes.query({ noteId: 'n' }, { index, consistent: true }),
  ];
  return byNoteOrKey('byNote');
});

const Usage = Schema.Struct({
  clientId: Schema.String,
  minute: Schema.Finite,
  strokes: Schema.Finite,
  points: Schema.optionalKey(Schema.Finite),
  expiresAt: Schema.Finite,
  label: Schema.optionalKey(Schema.String),
});
const Post = Schema.Struct({ id: Schema.String, title: Schema.String, likes: Schema.Finite });
const Hits = Schema.Struct({
  page: Schema.String,
  hits: Schema.Finite,
  uniques: Schema.optionalKey(Schema.Finite),
});

export const counters = Effect.gen(function* () {
  const db = yield* Db;
  const perMinute = db.collection('usage', {
    schema: Usage,
    partition: 'clientId',
    sort: 'minute',
    ttl: 'expiresAt',
  });
  const posts = db.collection('posts', { schema: Post, partition: 'id' });
  const hits = db.collection('hits', { schema: Hits, partition: 'page' });
  const key = { clientId: 'c', minute: 1 };

  const created: Effect.Effect<typeof Usage.Type> = perMinute.increment(
    key,
    { strokes: 1, points: 3 },
    { create: { expiresAt: 120, label: 'x' } },
  );
  // Every required field is the key or a counter, so `create` is optional.
  yield* hits.increment({ page: '/' }, { hits: 1 });
  yield* hits.increment({ page: '/' }, { hits: 1 }, { create: { uniques: 0 } });
  // @ts-expect-error `create` must give `expiresAt`, which the key and amounts don't
  yield* perMinute.increment(key, { strokes: 1 });
  // @ts-expect-error `create` must give `strokes` when only `points` is incremented
  yield* perMinute.increment(key, { points: 1 }, { create: { expiresAt: 120 } });
  yield* perMinute.increment(key, { points: 1 }, { create: { expiresAt: 120, strokes: 0 } });
  // @ts-expect-error `label` isn't a number
  yield* perMinute.increment(key, { strokes: 1, label: 1 }, { create: { expiresAt: 120 } });
  // @ts-expect-error key fields can't be counters
  yield* perMinute.increment(key, { minute: 1 }, { create: { expiresAt: 120, strokes: 0 } });
  // @ts-expect-error an incremented field can't also be in `create`
  yield* perMinute.increment(key, { strokes: 1 }, { create: { expiresAt: 120, strokes: 5 } });

  const liked: Effect.Effect<typeof Post.Type, DocumentNotFound> = posts.increment(
    { id: 'p' },
    { likes: 1 },
    { ifExists: true },
  );
  // @ts-expect-error `ifExists` can fail with DocumentNotFound
  const unchecked: Effect.Effect<unknown> = posts.increment({ id: 'p' }, { likes: 1 }, { ifExists: true });
  // @ts-expect-error a post can't be created from its key and likes alone
  yield* posts.increment({ id: 'p' }, { likes: 1 });

  const plain: Effect.Effect<unknown, DocumentNotFound> = posts.update({ id: 'p' }, { title: 't' });
  const guarded: Effect.Effect<unknown, DocumentNotFound | ConditionFailed> = posts.update(
    { id: 'p' },
    { title: 't' },
    { if: { likes: 0 } },
  );
  // @ts-expect-error a conditional update can fail with ConditionFailed
  const unguarded: Effect.Effect<unknown, DocumentNotFound> = posts.update(
    { id: 'p' },
    {},
    { if: { likes: 0 } },
  );
  // @ts-expect-error conditions name the document's fields, with their types
  yield* posts.update({ id: 'p' }, {}, { if: { likes: 'zero' } });
  return [created, liked, unchecked, plain, guarded, unguarded];
});

class WriteLimit extends HttpApiMiddleware.Service<WriteLimit>()('WriteLimit', { error: RateLimited }) {}
class OtherMiddleware extends HttpApiMiddleware.Service<OtherMiddleware>()('OtherMiddleware') {}

export const rateLimits = Effect.gen(function* () {
  const limits = yield* RateLimits;
  // With a key, a check runs anywhere (a worker job): it needs no request.
  const keyed: Effect.Effect<RateLimitResult> = limits.check('sends', { key: 'u1', max: 3, per: '1 day' });
  // @ts-expect-error without a key, the check counts the client's network, from the request
  const unkeyed: Effect.Effect<RateLimitResult> = limits.check('signups', { max: 5, per: '1 hour' });
  const fromRequest: Effect.Effect<RateLimitResult, never, HttpServerRequest.HttpServerRequest> =
    limits.check('signups', { max: 5, per: '1 hour' });
  const enforced: Effect.Effect<RateLimitResult, RateLimited> = limits.enforce('sends', {
    key: 'u1',
    max: 3,
    per: '1 day',
  });
  // @ts-expect-error enforce fails with RateLimited
  const unenforced: Effect.Effect<RateLimitResult> = limits.enforce('sends', {
    key: 'u1',
    max: 3,
    per: '1 day',
  });
  // @ts-expect-error `per` is a duration
  yield* limits.check('sends', { key: 'u1', max: 3, per: 'daily' });

  const layer: Layer.Layer<WriteLimit, never, RateLimits> = RateLimits.middleware(WriteLimit, {
    max: 120,
    per: '1 minute',
  });
  // @ts-expect-error the middleware must be declared with `{ error: RateLimited }`
  RateLimits.middleware(OtherMiddleware, { max: 120, per: '1 minute' });
  return [keyed, unkeyed, fromRequest, enforced, unenforced, layer];
});
