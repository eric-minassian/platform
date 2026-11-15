/**
 * Scenarios for the Effect `Db`, each run against the in-memory store
 * (effect.test.ts) and against DynamoDB in the AWS Emulator
 * (integration/emulator.test.ts), so the two behave the same.
 */
import { DateTime, Effect, Exit, Option, Schema } from 'effect';
import { expect } from 'vitest';
import { Db, type QueryOptions, TransactionCanceled } from '../src/index.ts';

const Note = Schema.Struct({
  ownerId: Schema.String,
  noteId: Schema.String,
  title: Schema.String,
  tag: Schema.optionalKey(Schema.String),
  createdAt: Schema.DateTimeUtcFromString,
});
type Note = typeof Note.Type;

const at = (day: number) => DateTime.makeUnsafe(`2026-01-0${day}T00:00:00.000Z`);
const ids = (page: { readonly items: ReadonlyArray<Note> }) => page.items.map((n) => n.noteId);

const noteCollection = (db: Db['Service'], name: string) =>
  db.collection(name, {
    schema: Note,
    partition: 'ownerId',
    sort: 'noteId',
    indexes: { byTag: { slot: 1, partition: 'tag', sort: 'createdAt' } },
  });

const note = (ownerId: string, noteId: string, fields: Partial<Note> = {}): Note => ({
  ownerId,
  noteId,
  title: noteId,
  createdAt: at(1),
  ...fields,
});

export const dbContract = (name: string) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const notes = noteCollection(db, name);

    const n1: Note = { ownerId: 'u1', noteId: 'n1', title: 'one', tag: 'work', createdAt: at(1) };
    yield* notes.put(n1);
    yield* notes.put({ ownerId: 'u1', noteId: 'n2', title: 'two', tag: 'home', createdAt: at(2) });
    yield* notes.insert({ ownerId: 'u1', noteId: 'n3', title: 'three', tag: 'work', createdAt: at(3) });
    yield* notes.put({ ownerId: 'u2', noteId: 'n1', title: 'other user', createdAt: at(1) });

    // Reads decode: createdAt comes back as a DateTime.
    expect(yield* notes.get({ ownerId: 'u1', noteId: 'n1' })).toEqual(Option.some(n1));
    expect(yield* notes.get({ ownerId: 'u1', noteId: 'nope' })).toEqual(Option.none());

    expect(ids(yield* notes.query({ ownerId: 'u1' }))).toEqual(['n1', 'n2', 'n3']);
    expect(ids(yield* notes.query({ ownerId: 'u1' }, { beginsWith: 'n2' }))).toEqual(['n2']);
    expect(ids(yield* notes.query({ ownerId: 'u1' }, { between: ['n2', 'n3'] }))).toEqual(['n2', 'n3']);
    expect(ids(yield* notes.query({ ownerId: 'u1' }, { gt: 'n1', reverse: true }))).toEqual(['n3', 'n2']);

    const page1 = yield* notes.query({ ownerId: 'u1' }, { limit: 2, reverse: true });
    expect(ids(page1)).toEqual(['n3', 'n2']);
    const page2 = yield* notes.query({ ownerId: 'u1' }, { limit: 2, reverse: true, cursor: page1.cursor! });
    expect(ids(page2)).toEqual(['n1']);
    expect(page2.cursor).toBeUndefined();

    // A cursor only opens for the query that issued it.
    const otherQuery = yield* Effect.flip(notes.query({ ownerId: 'u2' }, { cursor: page1.cursor! }));
    expect(otherQuery._tag).toBe('InvalidCursor');
    const garbage = yield* Effect.flip(notes.query({ ownerId: 'u1' }, { cursor: 'not-a-cursor' }));
    expect(garbage._tag).toBe('InvalidCursor');

    expect((yield* notes.queryAll({ ownerId: 'u1' })).map((n) => n.noteId)).toEqual(['n1', 'n2', 'n3']);

    // Strongly consistent reads find the same documents.
    expect(yield* notes.get({ ownerId: 'u1', noteId: 'n1' }, { consistent: true })).toEqual(Option.some(n1));
    expect(ids(yield* notes.query({ ownerId: 'u1' }, { gt: 'n1', consistent: true }))).toEqual(['n2', 'n3']);
    const all = yield* notes.queryAll({ ownerId: 'u1' }, { reverse: true, consistent: true });
    expect(all.map((n) => n.noteId)).toEqual(['n3', 'n2', 'n1']);
    // An index is eventually consistent: asking it for a consistent read is a defect (and a type error).
    const indexRead = { index: 'byTag', consistent: true } as unknown as QueryOptions;
    expect(Exit.hasDies(yield* Effect.exit(notes.query({ tag: 'work' }, indexRead)))).toBe(true);
    expect(Exit.hasDies(yield* Effect.exit(notes.queryAll({ tag: 'work' }, indexRead)))).toBe(true);

    const work = yield* notes.query({ tag: 'work' }, { index: 'byTag', gte: '2026-01-02' });
    expect(ids(work)).toEqual(['n3']);

    const duplicate = yield* Effect.flip(notes.insert(n1));
    expect(duplicate._tag).toBe('DocumentExists');
    const missing = yield* Effect.flip(notes.update({ ownerId: 'u9', noteId: 'nx' }, { title: 'nope' }));
    expect(missing._tag).toBe('DocumentNotFound');

    // Changing an index field moves the document in that index; removing it drops it out.
    const moved = yield* notes.update({ ownerId: 'u1', noteId: 'n3' }, { tag: 'home', title: 'moved' });
    expect(moved).toMatchObject({ title: 'moved', tag: 'home', createdAt: at(3) });
    expect(ids(yield* notes.query({ tag: 'home' }, { index: 'byTag' }))).toEqual(['n2', 'n3']);
    const untagged = yield* notes.update({ ownerId: 'u1', noteId: 'n3' }, { tag: undefined });
    expect(untagged).not.toHaveProperty('tag');
    expect(ids(yield* notes.query({ tag: 'home' }, { index: 'byTag' }))).toEqual(['n2']);

    // A required field can't be removed, and nothing is written when the patch is refused.
    const removeRequired = yield* Effect.exit(
      notes.update({ ownerId: 'u1', noteId: 'n2' }, { title: undefined }),
    );
    expect(Exit.hasDies(removeRequired)).toBe(true);
    expect(Option.map(yield* notes.get({ ownerId: 'u1', noteId: 'n2' }), (n) => n.title)).toEqual(
      Option.some('two'),
    );

    yield* notes.delete({ ownerId: 'u1', noteId: 'n1' });
    expect(yield* notes.get({ ownerId: 'u1', noteId: 'n1' })).toEqual(Option.none());

    // A document that no longer matches the schema is a defect, not a half-formed value.
    const Strict = Schema.Struct({ ownerId: Schema.String, noteId: Schema.String, title: Schema.Finite });
    const strict = db.collection(name, { schema: Strict, partition: 'ownerId', sort: 'noteId' });
    const stale = yield* Effect.exit(strict.get({ ownerId: 'u1', noteId: 'n2' }));
    expect(Exit.hasDies(stale)).toBe(true);
  });

export const batchContract = (name: string) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const notes = noteCollection(db, name);
    const many = Array.from({ length: 30 }, (_, i) =>
      note('u1', `n${String(i).padStart(2, '0')}`, { tag: i % 2 ? 'odd' : 'even' }),
    );
    const key = (n: Note) => ({ ownerId: n.ownerId, noteId: n.noteId });

    // More than one batch, with a key given twice: the last document wins, as with put after put.
    yield* notes.putMany([...many, { ...many[0]!, title: 'replaced' }]);
    const stored = yield* notes.queryAll({ ownerId: 'u1' });
    expect(stored).toHaveLength(30);
    expect(stored[0]).toEqual({ ...many[0], title: 'replaced' });
    expect(yield* notes.queryAll({ tag: 'odd' }, { index: 'byTag' })).toHaveLength(15);
    yield* notes.putMany([]);

    yield* notes.deleteMany([
      ...many.slice(0, 27).map(key),
      key(many[0]!),
      { ownerId: 'u1', noteId: 'never' },
    ]);
    expect((yield* notes.queryAll({ ownerId: 'u1' })).map((n) => n.noteId)).toEqual(['n27', 'n28', 'n29']);
    expect(yield* notes.queryAll({ tag: 'odd' }, { index: 'byTag' })).toHaveLength(2);
    yield* notes.deleteMany([]);

    // A document without its key is a defect before anything is written.
    const missingKey = yield* Effect.exit(notes.putMany([note('u2', 'a'), note('u2', '')]));
    expect(Exit.hasDies(missingKey)).toBe(true);
    expect(yield* notes.queryAll({ ownerId: 'u2' })).toEqual([]);
  });

const FeedEvent = Schema.Struct({ boardId: Schema.String, seq: Schema.Finite, kind: Schema.String });

export const transactContract = (name: string) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const notes = noteCollection(db, name);
    const feed = db.collection(`${name}-feed`, { schema: FeedEvent, partition: 'boardId', sort: 'seq' });
    const key = (noteId: string) => ({ ownerId: 'u1', noteId });
    const titles = Effect.map(notes.queryAll({ ownerId: 'u1' }), (all) =>
      Object.fromEntries(all.map((n) => [n.noteId, n.title])),
    );

    yield* notes.putMany([note('u1', 'keep'), note('u1', 'gone'), note('u1', 'edit')]);

    // Every kind of write, across collections, applied together.
    yield* db.transact([
      notes.tx.put(note('u1', 'new')),
      notes.tx.insert(note('u1', 'ins')),
      notes.tx.update(key('edit'), { title: 'edited' }),
      notes.tx.delete(key('gone')),
      notes.tx.check(key('keep')),
      notes.tx.check(key('never'), { exists: false }),
      feed.tx.insert({ boardId: 'b1', seq: 1, kind: 'stroke' }),
    ]);
    expect(yield* titles).toEqual({ edit: 'edited', ins: 'ins', keep: 'keep', new: 'new' });
    expect(yield* feed.queryAll({ boardId: 'b1' })).toEqual([{ boardId: 'b1', seq: 1, kind: 'stroke' }]);

    // One failed condition cancels all of it, and the error says which writes failed.
    const canceled = yield* Effect.flip(
      db.transact([
        notes.tx.put(note('u1', 'p2')),
        notes.tx.update(key('edit'), { title: 'twice' }),
        feed.tx.insert({ boardId: 'b1', seq: 1, kind: 'stroke' }),
        notes.tx.check(key('never')),
        notes.tx.delete(key('keep')),
        feed.tx.put({ boardId: 'b1', seq: 2, kind: 'stroke' }),
      ]),
    );
    expect(canceled).toBeInstanceOf(TransactionCanceled);
    expect(canceled.failed).toEqual([2, 3]);
    expect(yield* titles).toEqual({ edit: 'edited', ins: 'ins', keep: 'keep', new: 'new' });
    expect(yield* feed.queryAll({ boardId: 'b1' })).toHaveLength(1);

    const missing = yield* Effect.flip(db.transact([notes.tx.update(key('nope'), { title: 'x' })]));
    expect(missing.failed).toEqual([0]);
    const exists = yield* Effect.flip(db.transact([notes.tx.check(key('keep'), { exists: false })]));
    expect(exists.failed).toEqual([0]);

    // An update keeps indexes right without reading the document: changing an index
    // field gives all of the index's fields, and removing one drops it out.
    yield* db.transact([notes.tx.update(key('edit'), { tag: 'work', createdAt: at(5) })]);
    expect(ids(yield* notes.query({ tag: 'work' }, { index: 'byTag' }))).toEqual(['edit']);
    expect(Option.map(yield* notes.get(key('edit')), (n) => n.createdAt)).toEqual(Option.some(at(5)));
    yield* db.transact([notes.tx.update(key('edit'), { tag: undefined })]);
    expect(ids(yield* notes.query({ tag: 'work' }, { index: 'byTag' }))).toEqual([]);
    const partialIndex = yield* Effect.exit(
      db.transact([notes.tx.put(note('u1', 'p3')), notes.tx.update(key('edit'), { tag: 'home' })]),
    );
    expect(Exit.hasDies(partialIndex)).toBe(true);
    // A whole document passed as the key doesn't stand in for the index's other fields.
    const stored = Option.getOrThrow(yield* notes.get(key('edit')));
    const staleKey = yield* Effect.exit(db.transact([notes.tx.update(stored, { tag: 'home' })]));
    expect(Exit.hasDies(staleKey)).toBe(true);

    // Each document once per transaction, and at most 100 writes; neither writes anything.
    const twice = yield* Effect.exit(
      db.transact([notes.tx.put(note('u1', 'p3')), notes.tx.delete(key('p3'))]),
    );
    expect(Exit.hasDies(twice)).toBe(true);
    const batch = (n: number) => Array.from({ length: n }, (_, i) => notes.tx.put(note('u3', `x${i}`)));
    expect(Exit.hasDies(yield* Effect.exit(db.transact(batch(101))))).toBe(true);
    expect(Object.keys(yield* titles)).not.toContain('p3');
    expect(yield* notes.queryAll({ ownerId: 'u3' })).toEqual([]);

    // Only conditional writes can cancel, so this transaction has no typed error.
    const unconditional: Effect.Effect<void> = db.transact(batch(100));
    yield* unconditional;
    expect(yield* notes.queryAll({ ownerId: 'u3' })).toHaveLength(100);
    yield* db.transact([]);
  });

const Usage = Schema.Struct({
  clientId: Schema.String,
  minute: Schema.Finite,
  strokes: Schema.Finite,
  points: Schema.optionalKey(Schema.Finite),
  expiresAt: Schema.Finite,
  plan: Schema.optionalKey(Schema.String),
});

const Task = Schema.Struct({
  listId: Schema.String,
  taskId: Schema.String,
  status: Schema.Literals(['open', 'done']),
  assignee: Schema.optionalKey(Schema.String),
  version: Schema.Finite,
  dueAt: Schema.DateTimeUtcFromString,
});

const Tally = Schema.Struct({
  id: Schema.String,
  n: Schema.NullOr(Schema.Finite),
  stock: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  rating: Schema.optionalKey(Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 5 }))),
  flag: Schema.optionalKey(Schema.Literals([0, 1])),
  digits: Schema.optionalKey(Schema.FiniteFromString),
});

/** How many increments run at once in the concurrency check. */
export const CONCURRENT_INCREMENTS = 64;

/** Atomic increments and conditional updates, on collections named `<prefix>-usage` and `<prefix>-tasks`. */
export const countersContract = (prefix: string) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const usage = db.collection(`${prefix}-usage`, {
      schema: Usage,
      partition: 'clientId',
      sort: 'minute',
      ttl: 'expiresAt',
      indexes: { byPlan: { slot: 1, partition: 'plan', sort: 'clientId' } },
    });
    const key = { clientId: 'c1', minute: 1 };

    // A missing document is created from the key, the amounts and `create`.
    expect(yield* usage.increment(key, { strokes: 1, points: 3 }, { create: { expiresAt: 120 } })).toEqual({
      ...key,
      strokes: 1,
      points: 3,
      expiresAt: 120,
    });
    // On an existing one, `create` only fills what's missing; amounts add, and subtract when negative.
    const again = yield* usage.increment(
      key,
      { strokes: 2, points: -1 },
      { create: { expiresAt: 999, plan: 'pro' } },
    );
    expect(again).toEqual({ ...key, strokes: 3, points: 2, expiresAt: 120, plan: 'pro' });
    expect(yield* usage.get(key)).toEqual(Option.some(again));
    // A field `create` filled moves the document into the index built from it.
    expect((yield* usage.query({ plan: 'pro' }, { index: 'byPlan' })).items).toEqual([again]);

    // Numbers add in decimal, as DynamoDB adds them.
    const decimal = { clientId: 'c1', minute: 2 };
    yield* usage.increment(decimal, { points: 0.1 }, { create: { expiresAt: 180, strokes: 0 } });
    expect(
      (yield* usage.increment(decimal, { points: 0.2 }, { create: { expiresAt: 180, strokes: 0 } })).points,
    ).toBe(0.3);

    // With `ifExists`, a missing document stays missing.
    const nowhere = { clientId: 'c2', minute: 1 };
    const missing = yield* Effect.flip(usage.increment(nowhere, { strokes: 1 }, { ifExists: true }));
    expect(missing._tag).toBe('DocumentNotFound');
    expect(yield* usage.get(nowhere)).toEqual(Option.none());
    expect((yield* usage.increment(key, { strokes: 1 }, { ifExists: true })).strokes).toBe(4);

    // Increments that can't create a document that decodes, or that would count a key
    // field, are defects and write nothing.
    const noExpiry = yield* Effect.exit(usage.increment(nowhere, { strokes: 1 } as never));
    expect(Exit.hasDies(noExpiry)).toBe(true);
    const onKey = yield* Effect.exit(
      usage.increment(key, { minute: 1 } as never, { create: { expiresAt: 1 } } as never),
    );
    expect(Exit.hasDies(onKey)).toBe(true);
    expect(yield* usage.get(nowhere)).toEqual(Option.none());
    expect(Option.map(yield* usage.get(key), (u) => u.minute)).toEqual(Option.some(1));

    // Concurrent increments all count: each sees its own total, and none is lost.
    const burst = { clientId: 'c3', minute: 1 };
    const totals = yield* Effect.forEach(
      Array.from({ length: CONCURRENT_INCREMENTS }),
      () => usage.increment(burst, { strokes: 1, points: 2 }, { create: { expiresAt: 240 } }),
      { concurrency: 'unbounded' },
    );
    expect(totals.map((u) => u.strokes).toSorted((a, b) => a - b)).toEqual(
      Array.from({ length: CONCURRENT_INCREMENTS }, (_, i) => i + 1),
    );
    expect(yield* usage.get(burst)).toEqual(
      Option.some({
        ...burst,
        strokes: CONCURRENT_INCREMENTS,
        points: 2 * CONCURRENT_INCREMENTS,
        expiresAt: 240,
      }),
    );

    const tasks = db.collection(`${prefix}-tasks`, { schema: Task, partition: 'listId', sort: 'taskId' });
    const t1 = { listId: 'l1', taskId: 't1' };
    yield* tasks.put({ ...t1, status: 'open', version: 1, dueAt: at(5) });

    // `if` holds: the update goes through.
    const done = yield* tasks.update(
      t1,
      { status: 'done', version: 2 },
      { if: { status: 'open', version: 1 } },
    );
    expect(done).toMatchObject({ status: 'done', version: 2 });
    // It doesn't (here, a stale version): ConditionFailed, and nothing changes.
    const stale = yield* Effect.flip(tasks.update(t1, { status: 'open' }, { if: { version: 1 } }));
    expect(stale._tag).toBe('ConditionFailed');
    expect(yield* tasks.get(t1)).toEqual(Option.some(done));
    // Every condition must hold.
    const partly = yield* Effect.flip(
      tasks.update(t1, { version: 3 }, { if: { status: 'done', version: 7 } }),
    );
    expect(partly._tag).toBe('ConditionFailed');

    // `undefined` means the field is absent: claim a task only while it's unassigned.
    const claimed = yield* tasks.update(t1, { assignee: 'u1' }, { if: { assignee: undefined } });
    expect(claimed.assignee).toBe('u1');
    const taken = yield* Effect.flip(tasks.update(t1, { assignee: 'u2' }, { if: { assignee: undefined } }));
    expect(taken._tag).toBe('ConditionFailed');
    // Values are encoded with the field's schema before they're compared.
    expect((yield* tasks.update(t1, { version: 3 }, { if: { dueAt: at(5), assignee: 'u1' } })).version).toBe(
      3,
    );
    const otherDay = yield* Effect.flip(tasks.update(t1, { version: 4 }, { if: { dueAt: at(6) } }));
    expect(otherDay._tag).toBe('ConditionFailed');

    // A missing document is DocumentNotFound, with or without `if`.
    const gone = yield* Effect.flip(
      tasks.update({ listId: 'l1', taskId: 'tx' }, { version: 1 }, { if: { version: 0 } }),
    );
    expect(gone._tag).toBe('DocumentNotFound');

    // A counter only takes amounts every total of its schema allows, since
    // DynamoDB computes the total: anything else is a defect and writes nothing.
    const tallies = db.collection(`${prefix}-tallies`, { schema: Tally, partition: 'id' });
    const t = { id: 't1' };
    yield* tallies.put({ ...t, n: null });
    expect((yield* tallies.increment(t, { stock: 2 }, { ifExists: true })).stock).toBe(2);
    for (const amounts of [
      { stock: -1 },
      { stock: 0.5 },
      { rating: 1 },
      { flag: 1 },
      { digits: 1 },
    ] as const) {
      const refused = yield* Effect.exit(tallies.increment(t, amounts, { ifExists: true }));
      expect(Exit.hasDies(refused), JSON.stringify(amounts)).toBe(true);
    }
    // `create` can give a nullable field null, and `if: { n: undefined }` matches a stored null.
    const fresh = { id: 't2' };
    expect(yield* tallies.increment(fresh, { stock: 1 }, { create: { n: null } })).toEqual({
      ...fresh,
      n: null,
      stock: 1,
    });
    expect((yield* tallies.update(fresh, { stock: 3 }, { if: { n: undefined } })).stock).toBe(3);
    // A stored null isn't a missing counter: DynamoDB can't add to it.
    const onNull = yield* Effect.exit(tallies.increment(t, { n: 1 }, { ifExists: true }));
    expect(Exit.hasDies(onNull)).toBe(true);
    expect(yield* tallies.get(t)).toEqual(Option.some({ ...t, n: null, stock: 2 }));
  });
