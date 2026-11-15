/**
 * One scenario for the Effect `Db`, run against the in-memory store
 * (effect.test.ts) and against DynamoDB in the AWS Emulator
 * (integration/emulator.test.ts), so the two behave the same.
 */
import { DateTime, Effect, Exit, Option, Schema } from 'effect';
import { expect } from 'vitest';
import { Db } from '../src/effect/index.ts';

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

export const dbContract = (name: string) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const notes = db.collection(name, {
      schema: Note,
      partition: 'ownerId',
      sort: 'noteId',
      indexes: { byTag: { slot: 1, partition: 'tag', sort: 'createdAt' } },
    });

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
