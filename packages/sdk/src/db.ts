import { Context, Data, Effect, Layer, type Option, Predicate, Schema, SchemaAST } from 'effect';
import { InvalidCursor } from './api.ts';
import { InvalidCursorError } from './runtime/cursor.ts';
import {
  type CollectionOptions as BaseCollectionOptions,
  createKeyMapper,
  db,
  type GetOptions,
  keyPart,
  MAX_TRANSACT_ITEMS,
  type QueryAllOptions,
  type QueryOptions,
  stripInternal,
  type TransactItem,
} from './runtime/db.ts';

export type { GetOptions, KeyValue, QueryAllOptions, QueryOptions } from './runtime/db.ts';

/** `insert` found a document with the same key. */
export class DocumentExists extends Schema.TaggedError<DocumentExists, { readonly brand: unique symbol }>()(
  'DocumentExists',
  {
    collection: Schema.String,
  },
) {}

/** `update` found no document with that key. */
export class DocumentNotFound extends Schema.TaggedError<
  DocumentNotFound,
  { readonly brand: unique symbol }
>()('DocumentNotFound', {
  collection: Schema.String,
}) {}

/** A write's condition failed, so `transact` wrote nothing. */
export class TransactionCanceled extends Schema.TaggedError<
  TransactionCanceled,
  { readonly brand: unique symbol }
>()('TransactionCanceled', {
  /** Positions, in the writes given to `transact`, of those whose condition failed. */
  failed: Schema.Array(Schema.Int),
}) {}

/**
 * A struct schema for a collection's documents. Writes are encoded with it and
 * reads decoded, so a document written by an older revision that no longer
 * matches fails loudly instead of reaching app code half-formed.
 */
export type DocumentSchema = Schema.Codec<object, Record<string, unknown>> & {
  readonly fields: Schema.Struct.Fields;
};

type FieldOf<S extends DocumentSchema> = keyof S['Type'] & string;
type Fields<S extends DocumentSchema> = FieldOf<S> | readonly FieldOf<S>[];

export interface CollectionOptions<S extends DocumentSchema, P extends FieldOf<S>, K extends FieldOf<S>> {
  readonly schema: S;
  /** Field(s) forming the partition key. */
  readonly partition: P | readonly P[];
  /** Field(s) forming the sort key. */
  readonly sort?: K | readonly K[];
  /** Up to three secondary indexes, each pinned to a slot so reordering is safe. Never reuse a slot. */
  readonly indexes?: Readonly<
    Record<string, { readonly slot: 1 | 2 | 3; readonly partition: Fields<S>; readonly sort?: Fields<S> }>
  >;
  /** Field holding an epoch-seconds expiry (DynamoDB TTL). */
  readonly ttl?: FieldOf<S>;
}

export interface Page<T> {
  readonly items: ReadonlyArray<T>;
  /**
   * Set when more items may follow, whatever `items.length` is: a page also
   * ends at 1 MB of data, so it can be shorter than `limit`, and the next page
   * can be empty. Opaque; safe to hand to browsers.
   */
  readonly cursor?: string | undefined;
}

/**
 * One write of a `Db.transact`, from a collection's `tx`. Nothing is written
 * until the transaction runs. `conditional` writes (`insert`, `update`,
 * `check`) can cancel it.
 */
export interface TransactWrite<Conditional extends boolean = boolean> {
  readonly collection: string;
  readonly op: 'put' | 'insert' | 'update' | 'delete' | 'check';
  readonly conditional: Conditional;
}

/** A collection's writes for `Db.transact`, with the same meaning as its methods of the same name. */
export interface TransactWrites<T, Key extends keyof T> {
  /** Create or replace. */
  put(document: T): TransactWrite<false>;
  /** Create; cancels the transaction if a document with the same key exists. */
  insert(document: T): TransactWrite<true>;
  /**
   * Change some fields; cancels the transaction if the document doesn't
   * exist. The document isn't read first, so a patch that changes a field of
   * a secondary index must give every field of that index (removing one drops
   * the document out of the index); otherwise it is a defect.
   */
  update(key: Pick<T, Key>, patch: Partial<Omit<T, Key>>): TransactWrite<true>;
  delete(key: Pick<T, Key>): TransactWrite<false>;
  /** Writes nothing, but cancels the transaction unless the document exists (with `exists: false`, unless it doesn't). */
  check(key: Pick<T, Key>, options?: { readonly exists?: boolean }): TransactWrite<true>;
}

/**
 * Documents of one type. Infrastructure failures (throttling, a missing table,
 * a document that no longer decodes) are defects: the request answers 500 and
 * the platform records the error, and a job retries.
 */
export interface Collection<T, Key extends keyof T> {
  readonly name: string;
  get(key: Pick<T, Key>, options?: GetOptions): Effect.Effect<Option.Option<T>>;
  /** Create or replace. */
  put(document: T): Effect.Effect<T>;
  /** Create, failing if a document with the same key exists. */
  insert(document: T): Effect.Effect<T, DocumentExists>;
  /** Change some fields; `undefined` removes an optional field. Key fields can't change. */
  update(key: Pick<T, Key>, patch: Partial<Omit<T, Key>>): Effect.Effect<T, DocumentNotFound>;
  delete(key: Pick<T, Key>): Effect.Effect<void>;
  /**
   * Create or replace many documents, in batches of 25. Not atomic: a defect
   * partway leaves earlier batches written; use `Db.transact` for all or none.
   * A key given twice is written once, with its last document.
   */
  putMany(documents: Iterable<T>): Effect.Effect<void>;
  /** Delete many documents, in batches of 25. Not atomic, like `putMany`. */
  deleteMany(keys: Iterable<Pick<T, Key>>): Effect.Effect<void>;
  /** Writes for `Db.transact`. */
  readonly tx: TransactWrites<T, Key>;
  /**
   * One page of the documents sharing the given partition-key values (or an
   * index's, with `index`), in sort-key order. Continue while `cursor` is set.
   * A `cursor` must come from a previous page of this same query (same
   * partition, index and sort condition); any other fails with `InvalidCursor`.
   */
  query(
    partition: Partial<T>,
    options?: QueryOptions & { readonly cursor?: undefined },
  ): Effect.Effect<Page<T>>;
  query(partition: Partial<T>, options: QueryOptions): Effect.Effect<Page<T>, InvalidCursor>;
  /** Every matching document, following pages until the last one. */
  queryAll(partition: Partial<T>, options?: QueryAllOptions): Effect.Effect<ReadonlyArray<T>>;
}

/** `TransactionCanceled` unless every write is unconditional. */
type TransactError<W extends TransactWrite> = W extends TransactWrite<false> ? never : TransactionCanceled;

/** The stage's document database (`db: true`). Collections need no provisioning. */
export class Db extends Context.Service<
  Db,
  {
    collection<S extends DocumentSchema, const P extends FieldOf<S>, const K extends FieldOf<S> = never>(
      name: string,
      options: CollectionOptions<S, P, K>,
    ): Collection<S['Type'], P | K>;
    /**
     * Up to 100 writes from collections' `tx`, all or none. When a write's
     * condition fails nothing is written, and it fails with
     * `TransactionCanceled` naming the failed writes. Each document may be
     * written once per transaction. Conflicts with concurrent writes are
     * retried.
     */
    transact<W extends TransactWrite>(writes: Iterable<W>): Effect.Effect<void, TransactError<W>>;
  }
>()('@ericminassian/platform/Db') {
  /** DynamoDB, through the stage's bindings. */
  static readonly layer: Layer.Layer<Db> = Layer.sync(Db, () => makeDb(dynamoBackend));

  /** In memory, with DynamoDB's key, index, ordering, cursor and transaction rules. Each layer starts empty. */
  static readonly layerMemory = (): Layer.Layer<Db> => Layer.sync(Db, () => makeDb(memoryBackend()));
}

// ---------------------------------------------------------------- stores

type Doc = Record<string, unknown>;

class ConditionFailed extends Data.TaggedError('ConditionFailed') {}

/** A transaction's writes whose condition failed, by position. */
class ConditionsFailed extends Data.TaggedError('ConditionsFailed')<{
  readonly failed: ReadonlyArray<number>;
}> {}

/** The query's cursor didn't open for it. */
class BadCursor extends Data.TaggedError('BadCursor')<{ readonly message: string }> {}

/** Any other DynamoDB failure; becomes a defect. */
class DynamoFailure extends Data.TaggedError('DynamoFailure')<{ readonly cause: unknown }> {}

/** A backend's form of one transaction write; `id` names the item it touches. */
interface StoreWrite {
  readonly id: string;
}

/** Raw, schema-less storage of one collection's encoded documents. */
interface Store<W extends StoreWrite> {
  get(key: Doc, options: GetOptions): Effect.Effect<Doc | undefined>;
  put(item: Doc, ifNotExists: boolean): Effect.Effect<void, ConditionFailed>;
  update(key: Doc, patch: Doc): Effect.Effect<Doc, ConditionFailed>;
  delete(key: Doc): Effect.Effect<void>;
  putMany(items: ReadonlyArray<Doc>): Effect.Effect<void>;
  deleteMany(keys: ReadonlyArray<Doc>): Effect.Effect<void>;
  query(
    values: Doc,
    options: QueryOptions,
  ): Effect.Effect<{ items: Doc[]; cursor?: string | undefined }, BadCursor>;
  queryAll(values: Doc, options: QueryAllOptions): Effect.Effect<Doc[]>;
  /** This collection's transaction writes. They throw on a bad key or patch. */
  readonly tx: {
    put(item: Doc, ifNotExists: boolean): W;
    update(key: Doc, patch: Doc): W;
    delete(key: Doc): W;
    check(key: Doc, exists: boolean): W;
  };
}

/** Where collections are stored. `transact` applies writes from its collections all or none. */
interface Backend<W extends StoreWrite> {
  collection(name: string, options: BaseCollectionOptions<Doc>): Store<W>;
  transact(writes: ReadonlyArray<W>): Effect.Effect<void, ConditionsFailed>;
}

const isConditionFailed = (e: unknown): boolean =>
  (e as { name?: unknown } | null)?.name === 'ConditionalCheckFailedException';

/** Runs a DynamoDB call: a failed condition or a cursor that won't open are typed, anything else a defect. */
const dynamo = <A>(call: () => Promise<A>): Effect.Effect<A, ConditionFailed | BadCursor> =>
  Effect.tryPromise({
    try: call,
    catch: (cause) =>
      isConditionFailed(cause)
        ? new ConditionFailed()
        : cause instanceof InvalidCursorError
          ? new BadCursor({ message: cause.message })
          : new DynamoFailure({ cause }),
  }).pipe(Effect.catchTag('DynamoFailure', (e) => Effect.die(e.cause)));

/** Positions of the writes a TransactionCanceledException says failed their condition. */
function failedConditions(cause: unknown): number[] {
  if ((cause as { name?: unknown } | null)?.name !== 'TransactionCanceledException') return [];
  const { CancellationReasons: reasons = [] } = cause as {
    CancellationReasons?: ReadonlyArray<{ readonly Code?: string }>;
  };
  return reasons.flatMap((r, i) => (r.Code === 'ConditionalCheckFailed' ? [i] : []));
}

const dynamoBackend: Backend<TransactItem> = {
  collection: (name, options) => {
    const c = db.collection<Doc>(name, options);
    return {
      get: (key, o) => Effect.orDie(dynamo(() => c.get(key, o))),
      put: (item, ifNotExists) =>
        dynamo(() => c.put(item, { ifNotExists })).pipe(
          Effect.catchTag('BadCursor', Effect.die),
          Effect.asVoid,
        ),
      update: (key, patch) =>
        dynamo(() => c.update(key, patch)).pipe(Effect.catchTag('BadCursor', Effect.die)),
      delete: (key) => Effect.orDie(dynamo(() => c.delete(key))),
      putMany: (items) => Effect.orDie(dynamo(() => c.putMany(items))),
      deleteMany: (keys) => Effect.orDie(dynamo(() => c.deleteMany(keys))),
      query: (values, q) =>
        dynamo(() => c.query(values, q)).pipe(Effect.catchTag('ConditionFailed', Effect.die)),
      queryAll: (values, q) => Effect.orDie(dynamo(() => c.queryAll(values, q))),
      tx: {
        put: (item, ifNotExists) => c.transactItem.put(item, { ifNotExists }),
        update: (key, patch) => c.transactItem.update(key, patch),
        delete: (key) => c.transactItem.delete(key),
        check: (key, exists) => c.transactItem.check(key, exists),
      },
    };
  },
  transact: (writes) =>
    Effect.tryPromise({
      try: () => db.transact(writes),
      catch: (cause) => {
        const failed = failedConditions(cause);
        return failed.length ? new ConditionsFailed({ failed }) : new DynamoFailure({ cause });
      },
    }).pipe(Effect.catchTag('DynamoFailure', (e) => Effect.die(e.cause))),
};

/** A transaction write in memory: whether its condition holds, and the row it leaves. */
interface MemoryWrite extends StoreWrite {
  readonly holds: () => boolean;
  /** The item's row afterwards (`null`: deleted, `undefined`: unchanged), built without touching the table. */
  readonly row: () => Doc | null | undefined;
}

/**
 * A table in memory: items are stored exactly as DynamoDB would hold them
 * (`toItem`), so partition, sort and index keys, `begins_with`/range
 * conditions (string comparisons, like DynamoDB's) and cursors behave the same.
 * Cursors are bound to their query like sealed ones, but not encrypted. Every
 * read sees every earlier write, so `consistent` only has its index check.
 * Transactions check every condition before applying any write.
 */
function memoryBackend(): Backend<MemoryWrite> {
  const table = new Map<string, Doc>();

  const collection = (name: string, options: BaseCollectionOptions<Doc>): Store<MemoryWrite> => {
    const m = createKeyMapper(name, options);
    const what = `collection "${name}"`;
    const at = m.itemId;

    /** `existing` with `patch` applied: `undefined`/`null` remove a field; key fields stay. */
    const patched = (existing: Doc, patch: Doc): Doc => {
      const next: Doc = { ...existing };
      for (const [f, v] of Object.entries(patch)) {
        if (m.keyFields.has(f)) continue;
        if (v === undefined || v === null) delete next[f];
        else next[f] = v;
      }
      return next;
    };

    return {
      get: (key) => Effect.sync(() => stripInternal(table.get(at(key)))),

      put: (item, ifNotExists) =>
        Effect.suspend(() => {
          const k = at(item);
          if (ifNotExists && table.has(k)) return Effect.fail(new ConditionFailed());
          table.set(k, m.toItem(item));
          return Effect.void;
        }),

      update: (key, patch) =>
        Effect.suspend(() => {
          m.assertKeyUnchanged(key, patch);
          const k = at(key);
          const existing = stripInternal(table.get(k));
          if (!existing) return Effect.fail(new ConditionFailed());
          const next = patched(existing, patch);
          table.set(k, m.toItem(next));
          return Effect.succeed(next);
        }),

      delete: (key) => Effect.sync(() => void table.delete(at(key))),

      // Every key is mapped before anything is written, as DynamoDB's store does.
      putMany: (items) =>
        Effect.sync(() => {
          const rows = items.map((item) => [at(item), m.toItem(item)] as const);
          for (const [k, row] of rows) table.set(k, row);
        }),

      deleteMany: (keys) =>
        Effect.sync(() => {
          for (const k of keys.map(at)) table.delete(k);
        }),

      query: (values, q) =>
        Effect.suspend(() => {
          const { items, scope, order, pkAttr, skAttr } = matching(values, q);
          let rest = items;
          if (q.cursor !== undefined) {
            const start = openMemoryCursor(q.cursor, scope);
            if (!start) return Effect.fail(new BadCursor({ message: new InvalidCursorError().message }));
            rest = items.filter((i) => (q.reverse ? order(start, i) : order(i, start)) > 0);
          }
          const page = q.limit ? rest.slice(0, q.limit) : rest;
          // Like DynamoDB, a page that stopped at `limit` has a cursor even when nothing follows.
          const last = q.limit && page.length === q.limit ? page.at(-1) : undefined;
          const lastKey = last && {
            pk: last.pk,
            sk: last.sk,
            [pkAttr]: last[pkAttr],
            [skAttr]: last[skAttr],
          };
          return Effect.succeed({
            items: page.map((i) => stripInternal(i)!),
            cursor: lastKey && Buffer.from(JSON.stringify({ scope, key: lastKey })).toString('base64url'),
          });
        }),

      queryAll: (values, q) => Effect.sync(() => matching(values, q).items.map((i) => stripInternal(i)!)),

      tx: {
        put: (item, ifNotExists) => {
          const k = at(item);
          const row = m.toItem(item);
          return { id: k, holds: () => !ifNotExists || !table.has(k), row: () => row };
        },
        update: (key, patch) => {
          m.assertKeyUnchanged(key, patch);
          // Refuses the patches DynamoDB's store can't apply without a read; the item is rebuilt whole here.
          m.derivedForPatch(key, patch);
          const k = at(key);
          return {
            id: k,
            holds: () => table.has(k),
            row: () => m.toItem(patched(stripInternal(table.get(k))!, patch)),
          };
        },
        delete: (key) => {
          const k = at(key);
          return { id: k, holds: () => true, row: () => null };
        },
        check: (key, exists) => {
          const k = at(key);
          return { id: k, holds: () => table.has(k) === exists, row: () => undefined };
        },
      },
    };

    /** The query's items in order, and the scope its cursors are bound to (as `cursorScope` in db.ts). */
    function matching(values: Doc, q: QueryAllOptions) {
      let pkAttr = 'pk';
      let skAttr = 'sk';
      let pkValue: string;
      const ix = m.queryIndex(q);
      if (ix) {
        pkAttr = `gsi${ix.slot}pk`;
        skAttr = `gsi${ix.slot}sk`;
        pkValue = `${name}#${ix.name}#${keyPart(values, ix.partition, what)}`;
      } else {
        pkValue = `${name}#${keyPart(values, m.partition, what)}`;
      }
      const matches = sortCondition(q);
      const order = (a: Doc, b: Doc) =>
        compare(a[skAttr], b[skAttr]) || compare(a.pk, b.pk) || compare(a.sk, b.sk);
      const items = [...table.values()]
        .filter((i) => i[pkAttr] === pkValue && matches(String(i[skAttr])))
        .toSorted(q.reverse ? (a, b) => order(b, a) : order);
      const { beginsWith, between, gt, gte, lt, lte } = q;
      const scope = JSON.stringify([q.index ?? null, pkValue, { beginsWith, between, gt, gte, lt, lte }]);
      return { items, scope, order, pkAttr, skAttr };
    }
  };

  return {
    collection,
    transact: (writes) =>
      Effect.suspend(() => {
        const failed = writes.flatMap((w, i) => (w.holds() ? [] : [i]));
        if (failed.length) return Effect.fail(new ConditionsFailed({ failed }));
        // Every row is built before any is stored, so one that throws (a defect) leaves the table as it was.
        const rows = writes.map((w) => [w.id, w.row()] as const);
        for (const [id, row] of rows) {
          if (row === null) table.delete(id);
          else if (row) table.set(id, row);
        }
        return Effect.void;
      }),
  };
}

/** The start key in a cursor `query` issued for `scope`, or undefined. */
function openMemoryCursor(cursor: string, scope: string): Doc | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (Predicate.isObject(parsed) && 'scope' in parsed && parsed.scope === scope && 'key' in parsed)
      return Predicate.isObject(parsed.key) ? parsed.key : undefined;
  } catch {}
  return undefined;
}

function compare(a: unknown, b: unknown): number {
  const x = String(a);
  const y = String(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** The key condition `queryInput` builds for DynamoDB, as a predicate on the sort key. */
function sortCondition(q: QueryAllOptions): (sk: string) => boolean {
  if (q.beginsWith !== undefined) {
    const prefix = q.beginsWith;
    return (sk) => sk.startsWith(prefix);
  }
  if (q.between) {
    const [lo, hi] = q.between.map(String) as [string, string];
    return (sk) => sk >= lo && sk <= hi;
  }
  const ops = (['gt', 'gte', 'lt', 'lte'] as const).filter((k) => q[k] !== undefined);
  if (ops.length > 1) throw new Error('Use `between` for a range; only one of gt/gte/lt/lte is allowed');
  const op = ops[0];
  if (!op) return () => true;
  const v = String(q[op]);
  return {
    gt: (sk: string) => sk > v,
    gte: (sk: string) => sk >= v,
    lt: (sk: string) => sk < v,
    lte: (sk: string) => sk <= v,
  }[op];
}

// ---------------------------------------------------------------- schema layer

/** Makes a `TransactWrite` whose backend form `prepare` builds when the transaction runs. */
type WriteOf<W> = <C extends boolean>(
  collection: string,
  op: TransactWrite['op'],
  conditional: C,
  prepare: Effect.Effect<W>,
) => TransactWrite<C>;

function makeDb<W extends StoreWrite>(backend: Backend<W>): Db['Service'] {
  // Writes are plain values; this map holds how each becomes a backend write, and so
  // also tells apart writes made by another database (another layer).
  const prepared = new WeakMap<TransactWrite, Effect.Effect<W>>();
  const writeOf: WriteOf<W> = (collection, op, conditional, prepare) => {
    const write = { collection, op, conditional };
    prepared.set(write, prepare);
    return write;
  };

  const transact = (writes: Iterable<TransactWrite>): Effect.Effect<void, TransactionCanceled> =>
    Effect.gen(function* () {
      const all = [...writes];
      if (!all.length) return yield* Effect.void;
      if (all.length > MAX_TRANSACT_ITEMS)
        return yield* Effect.die(
          new Error(
            `db.transact takes at most ${MAX_TRANSACT_ITEMS} writes, not ${all.length}. ` +
              "Where all or none isn't needed, use putMany/deleteMany.",
          ),
        );
      const items = yield* Effect.forEach(
        all,
        (write) =>
          prepared.get(write) ??
          Effect.die(new Error("db.transact takes writes from this database's collections' `tx`")),
      );
      const first = new Map<string, number>();
      for (const [i, item] of items.entries()) {
        const j = first.get(item.id);
        if (j !== undefined)
          return yield* Effect.die(
            new Error(
              `db.transact: writes ${j} and ${i} are to the same document of collection "${all[i]!.collection}"; ` +
                'a transaction writes each document once',
            ),
          );
        first.set(item.id, i);
      }
      return yield* backend
        .transact(items)
        .pipe(Effect.mapError((e) => new TransactionCanceled({ failed: [...e.failed] })));
    });

  return Db.of({
    collection: (name, options) => makeCollection(backend, writeOf, name, options),
    // Only conditional writes can cancel a transaction; the signature says so.
    transact: transact as Db['Service']['transact'],
  });
}

function makeCollection<
  W extends StoreWrite,
  S extends DocumentSchema,
  P extends FieldOf<S>,
  K extends FieldOf<S>,
>(
  backend: Backend<W>,
  writeOf: WriteOf<W>,
  name: string,
  options: CollectionOptions<S, P, K>,
): Collection<S['Type'], P | K> {
  type T = S['Type'];
  const { schema } = options;
  const raw = backend.collection(name, options);
  const encode = (document: object) => Effect.orDie(Schema.encodeEffect(schema)(document));
  // Stored items are untrusted: an older revision may have written another shape.
  const decode = (item: unknown) => Effect.orDie(Schema.decodeUnknownEffect(schema)(item));
  const decodeAll = (items: ReadonlyArray<Doc>) => Effect.forEach(items, decode);

  /** Encodes changed fields with their own schemas; `undefined` removes a field, if it's optional. */
  const encodePatch = (patch: Doc) =>
    Effect.gen(function* () {
      const set: { [field: string]: Schema.Struct.Fields[string] } = {};
      const out: Doc = {};
      for (const [field, value] of Object.entries(patch)) {
        const fieldSchema = schema.fields[field];
        if (!fieldSchema) return yield* Effect.die(new Error(`collection "${name}" has no field "${field}"`));
        if (value === undefined || value === null) {
          if (!SchemaAST.isOptional(fieldSchema.ast))
            return yield* Effect.die(new Error(`collection "${name}": "${field}" is required`));
          out[field] = null;
        } else set[field] = fieldSchema;
      }
      const values = Object.fromEntries(Object.entries(patch).filter(([f]) => f in set));
      // Each field schema comes from `schema`, which encodes without services.
      const changed = Schema.Struct(set) as unknown as Schema.Codec<Doc, Doc>;
      const encoded = yield* Effect.orDie(Schema.encodeUnknownEffect(changed)(values));
      return { ...out, ...encoded };
    });

  const query = (partition: Partial<T>, q: QueryOptions = {}): Effect.Effect<Page<T>, InvalidCursor> =>
    raw.query(partition as Doc, q).pipe(
      Effect.mapError((e) => new InvalidCursor({ message: e.message })),
      Effect.flatMap((page) =>
        Effect.map(decodeAll(page.items), (items) => ({ items, cursor: page.cursor })),
      ),
    );

  return {
    name,
    get: (key, o = {}) =>
      raw
        .get(key as Doc, o)
        .pipe(Effect.flatMap((item) => (item ? Effect.asSome(decode(item)) : Effect.succeedNone))),
    put: (document) =>
      encode(document).pipe(
        Effect.flatMap((item) => Effect.orDie(raw.put(item, false))),
        Effect.as(document),
      ),
    insert: (document) =>
      encode(document).pipe(
        Effect.flatMap((item) => raw.put(item, true)),
        Effect.mapError(() => new DocumentExists({ collection: name })),
        Effect.as(document),
      ),
    update: (key, patch) =>
      encodePatch(patch as Doc).pipe(
        Effect.flatMap((encoded) => raw.update(key as Doc, encoded)),
        Effect.mapError(() => new DocumentNotFound({ collection: name })),
        Effect.flatMap(decode),
      ),
    delete: (key) => raw.delete(key),
    putMany: (documents) =>
      Effect.forEach(documents, encode).pipe(Effect.flatMap((items) => raw.putMany(items))),
    deleteMany: (keys) => raw.deleteMany(Array.from(keys, (key) => key as Doc)),
    // Without a cursor, `query` can't fail with InvalidCursor; the overloads say so.
    query: query as Collection<T, P | K>['query'],
    queryAll: (partition, q = {}) => raw.queryAll(partition as Doc, q).pipe(Effect.flatMap(decodeAll)),
    // Encoding and key mapping wait for `transact`; a bad document or key is a defect there.
    tx: {
      put: (document) =>
        writeOf(
          name,
          'put',
          false,
          Effect.flatMap(encode(document), (item) => Effect.sync(() => raw.tx.put(item, false))),
        ),
      insert: (document) =>
        writeOf(
          name,
          'insert',
          true,
          Effect.flatMap(encode(document), (item) => Effect.sync(() => raw.tx.put(item, true))),
        ),
      update: (key, patch) =>
        writeOf(
          name,
          'update',
          true,
          Effect.flatMap(encodePatch(patch as Doc), (encoded) =>
            Effect.sync(() => raw.tx.update(key as Doc, encoded)),
          ),
        ),
      delete: (key) =>
        writeOf(
          name,
          'delete',
          false,
          Effect.sync(() => raw.tx.delete(key as Doc)),
        ),
      check: (key, checkOptions) =>
        writeOf(
          name,
          'check',
          true,
          Effect.sync(() => raw.tx.check(key as Doc, checkOptions?.exists ?? true)),
        ),
    },
  };
}
