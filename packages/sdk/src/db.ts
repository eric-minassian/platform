import { Context, Data, Effect, Layer, type Option, Predicate, Schema, SchemaAST } from 'effect';
import { InvalidCursor } from './api.ts';
import { InvalidCursorError } from './runtime/cursor.ts';
import {
  type CollectionOptions as BaseCollectionOptions,
  createKeyMapper,
  db,
  keyPart,
  type QueryOptions,
  stripInternal,
} from './runtime/db.ts';

export type { KeyValue, QueryOptions } from './runtime/db.ts';

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

/**
 * A struct schema for a collection's documents. Writes are encoded with it and
 * reads decoded, so a document written by an older revision that no longer
 * matches fails loudly instead of reaching app code half-formed.
 */
export type DocumentSchema = Schema.Codec<object, Record<string, unknown>, never, never> & {
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
 * Documents of one type. Infrastructure failures (throttling, a missing table,
 * a document that no longer decodes) are defects: the request answers 500 and
 * the platform records the error, and a job retries.
 */
export interface Collection<T, Key extends keyof T> {
  readonly name: string;
  get(key: Pick<T, Key>): Effect.Effect<Option.Option<T>>;
  /** Create or replace. */
  put(document: T): Effect.Effect<T>;
  /** Create, failing if a document with the same key exists. */
  insert(document: T): Effect.Effect<T, DocumentExists>;
  /** Change some fields; `undefined` removes an optional field. Key fields can't change. */
  update(key: Pick<T, Key>, patch: Partial<Omit<T, Key>>): Effect.Effect<T, DocumentNotFound>;
  delete(key: Pick<T, Key>): Effect.Effect<void>;
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
  queryAll(
    partition: Partial<T>,
    options?: Omit<QueryOptions, 'cursor' | 'limit'>,
  ): Effect.Effect<ReadonlyArray<T>>;
}

/** The stage's document database (`db: true`). Collections need no provisioning. */
export class Db extends Context.Service<
  Db,
  {
    collection<S extends DocumentSchema, const P extends FieldOf<S>, const K extends FieldOf<S> = never>(
      name: string,
      options: CollectionOptions<S, P, K>,
    ): Collection<S['Type'], P | K>;
  }
>()('@ericminassian/platform/Db') {
  /** DynamoDB, through the stage's bindings. */
  static readonly layer: Layer.Layer<Db> = Layer.sync(Db, () => makeDb(dynamoStore));

  /** In memory, with DynamoDB's key, index, ordering and cursor rules. Each layer starts empty. */
  static readonly layerMemory = (): Layer.Layer<Db> => Layer.sync(Db, () => makeDb(memoryStore()));
}

// ---------------------------------------------------------------- stores

type Doc = Record<string, unknown>;

class ConditionFailed extends Data.TaggedError('ConditionFailed') {}

/** The query's cursor didn't open for it. */
class BadCursor extends Data.TaggedError('BadCursor')<{ readonly message: string }> {}

/** Any other DynamoDB failure; becomes a defect. */
class DynamoFailure extends Data.TaggedError('DynamoFailure')<{ readonly cause: unknown }> {}

/** Raw, schema-less storage of encoded documents. */
interface Store {
  get(key: Doc): Effect.Effect<Doc | undefined>;
  put(item: Doc, ifNotExists: boolean): Effect.Effect<void, ConditionFailed>;
  update(key: Doc, patch: Doc): Effect.Effect<Doc, ConditionFailed>;
  delete(key: Doc): Effect.Effect<void>;
  query(
    values: Doc,
    options: QueryOptions,
  ): Effect.Effect<{ items: Doc[]; cursor?: string | undefined }, BadCursor>;
  queryAll(values: Doc, options: QueryOptions): Effect.Effect<Doc[]>;
}

type StoreFactory = (name: string, options: BaseCollectionOptions<Doc>) => Store;

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

const dynamoStore: StoreFactory = (name, options) => {
  const c = db.collection<Doc>(name, options);
  return {
    get: (key) => Effect.orDie(dynamo(() => c.get(key))),
    put: (item, ifNotExists) =>
      dynamo(() => c.put(item, { ifNotExists })).pipe(
        Effect.catchTag('BadCursor', Effect.die),
        Effect.asVoid,
      ),
    update: (key, patch) => dynamo(() => c.update(key, patch)).pipe(Effect.catchTag('BadCursor', Effect.die)),
    delete: (key) => Effect.orDie(dynamo(() => c.delete(key))),
    query: (values, q) =>
      dynamo(() => c.query(values, q)).pipe(Effect.catchTag('ConditionFailed', Effect.die)),
    queryAll: (values, q) => Effect.orDie(dynamo(() => c.queryAll(values, q))),
  };
};

/**
 * A table in memory: items are stored exactly as DynamoDB would hold them
 * (`toItem`), so partition, sort and index keys, `begins_with`/range
 * conditions (string comparisons, like DynamoDB's) and cursors behave the same.
 * Cursors are bound to their query like sealed ones, but not encrypted.
 */
function memoryStore(): StoreFactory {
  const table = new Map<string, Doc>();
  const id = (pk: unknown, sk: unknown) => `${String(pk)}\u0000${String(sk)}`;

  return (name, options) => {
    const m = createKeyMapper(name, options);
    const what = `collection "${name}"`;
    const at = (key: Doc) => {
      const { pk, sk } = m.primaryKey(key);
      return id(pk, sk);
    };

    return {
      get: (key) => Effect.sync(() => stripInternal<Doc>(table.get(at(key)))),

      put: (item, ifNotExists) =>
        Effect.suspend(() => {
          const k = at(item);
          if (ifNotExists && table.has(k)) return Effect.fail(new ConditionFailed());
          table.set(k, m.toItem(item));
          return Effect.void;
        }),

      update: (key, patch) =>
        Effect.suspend(() => {
          for (const f of Object.keys(patch)) {
            if (m.keyFields.has(f) && patch[f] !== key[f])
              return Effect.die(new Error(`${what}: cannot change key attribute "${f}"`));
          }
          const k = at(key);
          const existing = stripInternal<Doc>(table.get(k));
          if (!existing) return Effect.fail(new ConditionFailed());
          const next: Doc = { ...existing };
          for (const [f, v] of Object.entries(patch)) {
            if (m.keyFields.has(f)) continue;
            if (v === undefined || v === null) delete next[f];
            else next[f] = v;
          }
          table.set(k, m.toItem(next));
          return Effect.succeed(next);
        }),

      delete: (key) => Effect.sync(() => void table.delete(at(key))),

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
            items: page.map((i) => stripInternal<Doc>(i)!),
            cursor: lastKey && Buffer.from(JSON.stringify({ scope, key: lastKey })).toString('base64url'),
          });
        }),

      queryAll: (values, q) =>
        Effect.sync(() => matching(values, q).items.map((i) => stripInternal<Doc>(i)!)),
    };

    /** The query's items in order, and the scope its cursors are bound to (as `cursorScope` in db.ts). */
    function matching(values: Doc, q: QueryOptions) {
      let pkAttr = 'pk';
      let skAttr = 'sk';
      let pkValue: string;
      if (q.index) {
        const ix = m.indexes.find((i) => i.name === q.index);
        if (!ix) throw new Error(`${what} has no index "${q.index}"`);
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
        .sort(q.reverse ? (a, b) => order(b, a) : order);
      const { beginsWith, between, gt, gte, lt, lte } = q;
      const scope = JSON.stringify([q.index ?? null, pkValue, { beginsWith, between, gt, gte, lt, lte }]);
      return { items, scope, order, pkAttr, skAttr };
    }
  };
}

/** The start key in a cursor `query` issued for `scope`, or undefined. */
function openMemoryCursor(cursor: string, scope: string): Doc | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (Predicate.isObject(parsed) && 'scope' in parsed && parsed.scope === scope && 'key' in parsed)
      return Predicate.isObject(parsed.key) ? (parsed.key as Doc) : undefined;
  } catch {}
  return undefined;
}

function compare(a: unknown, b: unknown): number {
  const x = String(a);
  const y = String(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** The key condition `queryInput` builds for DynamoDB, as a predicate on the sort key. */
function sortCondition(q: QueryOptions): (sk: string) => boolean {
  if (q.beginsWith !== undefined) {
    const prefix = String(q.beginsWith);
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

function makeDb(store: StoreFactory): Db['Service'] {
  return Db.of({ collection: (name, options) => makeCollection(store, name, options) });
}

function makeCollection<S extends DocumentSchema, P extends FieldOf<S>, K extends FieldOf<S>>(
  store: StoreFactory,
  name: string,
  options: CollectionOptions<S, P, K>,
): Collection<S['Type'], P | K> {
  type T = S['Type'];
  const { schema } = options;
  const raw = store(name, options as unknown as BaseCollectionOptions<Doc>);
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
      return { ...out, ...(encoded as Doc) };
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
    get: (key) =>
      raw
        .get(key as Doc)
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
    delete: (key) => raw.delete(key as Doc),
    // Without a cursor, `query` can't fail with InvalidCursor; the overloads say so.
    query: query as Collection<T, P | K>['query'],
    queryAll: (partition, q = {}) => raw.queryAll(partition as Doc, q).pipe(Effect.flatMap(decodeAll)),
  };
}
