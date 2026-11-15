import { Context, Data, Effect, Equal, Layer, type Option, Predicate, Schema, SchemaAST } from 'effect';
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

/** `update` or `increment` found no document with that key. */
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

/** The document didn't hold the values `update`'s `if` asked for, so nothing was written. */
export class ConditionFailed extends Schema.TaggedError<ConditionFailed, { readonly brand: unique symbol }>()(
  'ConditionFailed',
  {
    collection: Schema.String,
  },
) {}

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

/** Fields of `T`, outside the key, that hold numbers. */
type NumberField<T, Key extends keyof T> = {
  [F in Exclude<keyof T, Key>]-?: NonNullable<T[F]> extends number ? F : never;
}[Exclude<keyof T, Key>];

/** What `increment` adds to each counter. */
export type Increments<T, Key extends keyof T> = { readonly [F in NumberField<T, Key>]?: number };

type RequiredField<T> = { [F in keyof T]-?: Pick<T, F> extends Required<Pick<T, F>> ? F : never }[keyof T];

/** Required fields that neither the key nor the amounts give a document `increment` creates. */
type Uncovered<T, Key extends keyof T, A> = Exclude<RequiredField<T>, Key | keyof A>;

type CreateFields<T, Key extends keyof T, A> = Pick<T, Uncovered<T, Key, A>> &
  Partial<Omit<T, Key | keyof A>>;

/** `create` is required exactly when the key and the amounts leave a required field unset. */
type IncrementCreate<T, Key extends keyof T, A> = [Uncovered<T, Key, A>] extends [never]
  ? [options?: { readonly create?: CreateFields<T, Key, A> }]
  : [options: { readonly create: CreateFields<T, Key, A> }];

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
  /**
   * Change some fields; `undefined` removes an optional field. Key fields can't
   * change. With `if`, only while the document holds those values (`undefined`:
   * the field is absent or null), checked in the same atomic write; otherwise it
   * fails with `ConditionFailed` and changes nothing.
   */
  update(key: Pick<T, Key>, patch: Partial<Omit<T, Key>>): Effect.Effect<T, DocumentNotFound>;
  update(
    key: Pick<T, Key>,
    patch: Partial<Omit<T, Key>>,
    options: { readonly if: Partial<Omit<T, Key>> },
  ): Effect.Effect<T, DocumentNotFound | ConditionFailed>;
  /**
   * Adds to number fields in one atomic write (a negative amount subtracts) and
   * returns the document after it. Concurrent increments all count, unlike a
   * `get` followed by a `put`.
   *
   * A missing document is created from the key, the amounts (a counter starts
   * at 0) and `create`, which must give every other required field; on an
   * existing document, `create` only fills the fields it lacks. With
   * `{ ifExists: true }`, a missing document fails with `DocumentNotFound`
   * instead. Key, index and `ttl` fields can't be counters.
   */
  increment(
    key: Pick<T, Key>,
    amounts: Increments<T, Key>,
    options: { readonly ifExists: true },
  ): Effect.Effect<T, DocumentNotFound>;
  increment<A extends Increments<T, Key>>(
    key: Pick<T, Key>,
    amounts: A & { readonly [F in Exclude<keyof A, NumberField<T, Key>>]: never },
    ...options: IncrementCreate<T, Key, A>
  ): Effect.Effect<T>;
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

/** A write's condition didn't hold; `found` says whether the document exists. */
class CheckFailed extends Data.TaggedError('CheckFailed')<{ readonly found: boolean }> {}

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
  put(item: Doc, ifNotExists: boolean): Effect.Effect<void, CheckFailed>;
  /** Fails when the document is missing or lacks `condition`'s values (`null`: absent or null). */
  update(key: Doc, patch: Doc, condition?: Doc): Effect.Effect<Doc, CheckFailed>;
  /** Creates a missing document from `key` and `create`; without `create`, fails instead. */
  increment(key: Doc, amounts: Record<string, number>, create?: Doc): Effect.Effect<Doc, CheckFailed>;
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

const isConditionFailed = (e: unknown): e is { readonly Item?: unknown } =>
  (e as { name?: unknown } | null)?.name === 'ConditionalCheckFailedException';

/** Runs a DynamoDB call: a failed condition or a cursor that won't open are typed, anything else a defect. */
const dynamo = <A>(call: () => Promise<A>): Effect.Effect<A, CheckFailed | BadCursor> =>
  Effect.tryPromise({
    try: call,
    catch: (cause) =>
      isConditionFailed(cause)
        ? // `Item` is only there when the write asked for it and the document exists.
          new CheckFailed({ found: cause.Item !== undefined })
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
      update: (key, patch, condition) =>
        dynamo(() => c.update(key, patch, condition && { if: condition })).pipe(
          Effect.catchTag('BadCursor', Effect.die),
        ),
      increment: (key, amounts, create) =>
        dynamo(() => c.increment(key, amounts, create)).pipe(Effect.catchTag('BadCursor', Effect.die)),
      delete: (key) => Effect.orDie(dynamo(() => c.delete(key))),
      putMany: (items) => Effect.orDie(dynamo(() => c.putMany(items))),
      deleteMany: (keys) => Effect.orDie(dynamo(() => c.deleteMany(keys))),
      query: (values, q) => dynamo(() => c.query(values, q)).pipe(Effect.catchTag('CheckFailed', Effect.die)),
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
          if (ifNotExists && table.has(k)) return Effect.fail(new CheckFailed({ found: true }));
          table.set(k, m.toItem(item));
          return Effect.void;
        }),

      update: (key, patch, condition) =>
        Effect.suspend(() => {
          m.assertKeyUnchanged(key, patch);
          const k = at(key);
          const existing = stripInternal(table.get(k));
          if (!existing) return Effect.fail(new CheckFailed({ found: false }));
          if (condition && !meets(existing, condition)) return Effect.fail(new CheckFailed({ found: true }));
          const next = patched(existing, patch);
          table.set(k, m.toItem(next));
          return Effect.succeed(next);
        }),

      // The same steps as the UpdateItem in db.ts: set the key, fill what's
      // missing from `create`, then ADD. Index and TTL attributes follow from
      // `toItem`, as the DynamoDB store brings them in line after its write.
      increment: (key, amounts, create) =>
        Effect.suspend(() => {
          m.checkIncrement(key, amounts, create);
          const k = at(key);
          const existing = stripInternal(table.get(k));
          if (!existing && !create) return Effect.fail(new CheckFailed({ found: false }));
          const next: Doc = { ...existing };
          for (const f of m.keyFields) next[f] = key[f];
          for (const [f, v] of Object.entries(create ?? {}))
            if (next[f] === undefined && v !== undefined) next[f] = v;
          for (const [f, by] of Object.entries(amounts)) {
            // Only a missing counter starts at 0; DynamoDB can't ADD to a stored null.
            const now = next[f] === undefined ? 0 : next[f];
            if (typeof now !== 'number' || !Number.isFinite(now))
              return Effect.die(
                new Error(`${what}: cannot increment "${f}": it holds ${JSON.stringify(now)}`),
              );
            next[f] = addDecimal(now, by);
          }
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

/**
 * Why adding `by` to a field with this schema could store a value the schema
 * rejects, or `undefined` when every total stays valid. DynamoDB computes the
 * total, so it can't be checked before the write: a counter's checks must hold
 * for any total, starting from a valid one or from 0 when the field is missing.
 */
function counterProblem(field: { readonly ast: SchemaAST.AST }, by: number): string | undefined {
  const checks: SchemaAST.Check<unknown>[] = [];
  // The stored (encoded) value must be a number for ADD, and the decoded one
  // must pass its checks; `null`/`undefined` alternatives can't be added to.
  const number = (ast: SchemaAST.AST): boolean => {
    checks.push(...(ast.checks ?? []));
    if (SchemaAST.isNumber(ast)) return true;
    if (!SchemaAST.isUnion(ast)) return false;
    const rest = ast.types.filter((t) => t._tag !== 'Null' && t._tag !== 'Undefined');
    return rest.length === 1 && number(rest[0]!);
  };
  if (!number(field.ast) || !number(SchemaAST.toEncoded(field.ast))) return "it isn't a number field";
  for (const check of checks) {
    const { id, payload } = (check.annotations?.representation ?? {}) as {
      id?: string;
      payload?: Record<string, number>;
    };
    const p = payload ?? {};
    const safe =
      check._tag === 'Filter' &&
      (id === 'effect/schema/isFinite' ||
        (id === 'effect/schema/isInt' && Number.isSafeInteger(by)) ||
        (id === 'effect/schema/isGreaterThanOrEqualTo' && by >= 0 && by >= p.minimum!) ||
        (id === 'effect/schema/isGreaterThan' && by >= 0 && by > p.exclusiveMinimum!) ||
        (id === 'effect/schema/isLessThanOrEqualTo' && by <= 0 && by <= p.maximum!) ||
        (id === 'effect/schema/isLessThan' && by <= 0 && by < p.exclusiveMaximum!));
    if (!safe)
      return `the total might not be ${check.annotations?.expected ?? 'valid'}. A counter's checks must hold for every total (finite, integer, a minimum with amounts >= 0, a maximum with amounts <= 0); check other limits on the total increment returns`;
  }
  return undefined;
}

/** Whether `doc` holds `condition`'s values, compared as DynamoDB's `=` compares; `null`: absent or null. */
function meets(doc: Doc, condition: Doc): boolean {
  return Object.entries(condition).every(([f, v]) =>
    v === null ? doc[f] === undefined || doc[f] === null : Equal.equals(doc[f], v),
  );
}

/**
 * `a + b` the way DynamoDB adds numbers, in decimal: 0.1 + 0.2 is 0.3. Each
 * operand is the decimal its shortest form spells, which is what DynamoDB
 * receives for a JavaScript number.
 */
function addDecimal(a: number, b: number): number {
  const parse = (n: number) => {
    const [, sign, int, frac = '', exp = '0'] = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/.exec(String(n))!;
    return { units: BigInt(`${sign}${int}${frac}`), scale: frac.length - Number(exp) };
  };
  const x = parse(a);
  const y = parse(b);
  const scale = Math.max(x.scale, y.scale);
  const units = x.units * 10n ** BigInt(scale - x.scale) + y.units * 10n ** BigInt(scale - y.scale);
  return Number(`${units}e${-scale}`);
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

  const fieldSchema = (field: string) => {
    const s = schema.fields[field];
    if (!s) throw new Error(`collection "${name}" has no field "${field}"`);
    return s;
  };
  const isAbsent = (value: unknown) => value === undefined || value === null;

  /** Encodes each value with its field's own schema. */
  const encodeValues = (values: Doc) =>
    Effect.suspend(() => {
      const fields = Object.fromEntries(Object.keys(values).map((field) => [field, fieldSchema(field)]));
      // Each field schema comes from `schema`, which encodes without services.
      const struct = Schema.Struct(fields) as unknown as Schema.Codec<Doc, Doc>;
      return Effect.orDie(Schema.encodeUnknownEffect(struct)(values));
    });

  /** Like `encodeValues`, but absent (`undefined`/`null`) values become `null`. */
  const encodeFields = (values: Doc) =>
    Effect.suspend(() => {
      const absent: Doc = {};
      const present: Doc = {};
      for (const [field, value] of Object.entries(values)) {
        fieldSchema(field);
        if (isAbsent(value)) absent[field] = null;
        else present[field] = value;
      }
      return Effect.map(encodeValues(present), (encoded) => ({ ...absent, ...encoded }));
    });

  /** Encodes changed fields; `undefined` removes a field, if it's optional. */
  const encodePatch = (patch: Doc) =>
    Effect.suspend(() => {
      for (const [field, value] of Object.entries(patch))
        if (isAbsent(value) && !SchemaAST.isOptional(fieldSchema(field).ast))
          throw new Error(`collection "${name}": "${field}" is required`);
      return encodeFields(patch);
    });

  const update = (key: Doc, patch: Doc, conditional?: { readonly if: Doc }) =>
    Effect.all([encodePatch(patch), conditional ? encodeFields(conditional.if) : Effect.undefined]).pipe(
      Effect.flatMap(([encoded, condition]) => raw.update(key, encoded, condition)),
      Effect.mapError((e) =>
        e.found ? new ConditionFailed({ collection: name }) : new DocumentNotFound({ collection: name }),
      ),
      Effect.flatMap(decode),
    );

  const increment = (
    key: Doc,
    amounts: Record<string, number>,
    mode: { readonly ifExists?: boolean; readonly create?: Doc } = {},
  ) =>
    Effect.gen(function* () {
      for (const [field, by] of Object.entries(amounts)) {
        // A non-finite amount is refused with the store's own checks.
        const problem = Number.isFinite(by) ? counterProblem(fieldSchema(field), by) : undefined;
        if (problem)
          throw new Error(`collection "${name}": cannot increment "${field}" by ${by}: ${problem}`);
      }
      const encodedKey = yield* encodeFields(key);
      let create: Doc | undefined;
      if (!mode.ifExists) {
        // Only `undefined` leaves a field out: `null` is a value, for a field whose schema takes it.
        create = yield* encodeValues(
          Object.fromEntries(Object.entries(mode.create ?? {}).filter(([, v]) => v !== undefined)),
        );
        // Checked whether or not the document exists, so the call that would
        // create a document that doesn't decode never makes it this far.
        const covered = new Set([
          ...Object.keys(encodedKey),
          ...Object.keys(amounts),
          ...Object.keys(create),
        ]);
        const uncovered = Object.entries(schema.fields)
          .filter(([field, s]) => !SchemaAST.isOptional(s.ast) && !covered.has(field))
          .map(([field]) => `"${field}"`);
        if (uncovered.length)
          return yield* Effect.die(
            new Error(
              `collection "${name}": increment creates the document when it's missing, so \`create\` needs ${uncovered.join(', ')} (or pass \`ifExists: true\`)`,
            ),
          );
      }
      const item = yield* raw
        .increment(encodedKey, amounts, create)
        .pipe(Effect.mapError(() => new DocumentNotFound({ collection: name })));
      return yield* decode(item);
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
    // Without `if`, `update` can't fail with ConditionFailed, nor `increment`
    // with DocumentNotFound without `ifExists`; the overloads say so.
    update: update as unknown as Collection<T, P | K>['update'],
    increment: increment as unknown as Collection<T, P | K>['increment'],
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
