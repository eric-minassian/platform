import {
  BatchWriteCommand,
  type BatchWriteCommandInput,
  DeleteCommand,
  type DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  type QueryCommandInput,
  TransactWriteCommand,
  type TransactWriteCommandInput,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { APP_CONFIG_FILE } from '@ericminassian/platform-core';
import { getBindings } from './bindings.ts';
import { ddbClient } from './clients.ts';
import { openCursor, sealCursor } from './cursor.ts';
import { span } from './telemetry.ts';

/**
 * Document collections on the stage's single DynamoDB table (single-table
 * design). Adding a collection needs no provisioning.
 *
 * Item layout:
 *   pk       = "<collection>#<partition values joined by #>"
 *   sk       = "<sort values joined by #>"  (or "#" without a sort key)
 *   gsi{n}pk = "<collection>#<index>#<values>", gsi{n}sk = sort values or "#"
 *   _c       = collection, _ttl = epoch seconds (DynamoDB TTL)
 * Internal attributes are stripped from everything returned.
 */

export type KeyValue = string | number;

type Fields<T> = (keyof T & string) | readonly (keyof T & string)[];

export interface CollectionOptions<T> {
  /** Attribute(s) forming the partition key. */
  partition: Fields<T>;
  /** Attribute(s) forming the sort key (optional). */
  sort?: Fields<T>;
  /** Up to three secondary indexes, each pinned to a fixed slot so reordering is safe. */
  indexes?: Record<string, { slot: 1 | 2 | 3; partition: Fields<T>; sort?: Fields<T> }>;
  /** Attribute holding an epoch-seconds expiry (DynamoDB TTL). */
  ttl?: keyof T & string;
}

export interface GetOptions {
  /**
   * See every write that finished before this read began. Costs twice the
   * read capacity of the default, eventually consistent read, which can miss
   * a write made a moment ago.
   */
  consistent?: boolean;
}

/**
 * Where a query reads from. Secondary indexes are only eventually
 * consistent, so `consistent: true` is for the collection's own key.
 */
type QuerySource =
  | (GetOptions & { index?: undefined })
  | {
      index: string;
      /** Index queries can't be consistent: an index can lag its documents by a moment. */
      consistent?: false;
    };

/** A query's sort-key condition, order and source. */
export type QueryAllOptions = QuerySource & {
  beginsWith?: string;
  between?: [KeyValue, KeyValue];
  gt?: KeyValue;
  gte?: KeyValue;
  lt?: KeyValue;
  lte?: KeyValue;
  reverse?: boolean;
};

export type QueryOptions = QueryAllOptions & {
  limit?: number;
  /**
   * A `cursor` from the previous page of this same query (same partition,
   * index and sort condition; `limit`, `reverse` and `consistent` may change).
   * Any other value throws `InvalidCursorError`, which the server answers
   * with a 400.
   */
  cursor?: string;
};

export interface Page<T> {
  items: T[];
  /**
   * Set when more items may follow, whatever `items.length` is: a page also
   * ends at 1 MB of data, so it can be shorter than `limit`. The next page can
   * be empty. Opaque; safe to hand to browsers.
   */
  cursor?: string;
}

/** One write of a `transact` call. */
export interface TransactItem {
  readonly collection: string;
  /** The item's `pk` and `sk`: a transaction may touch each item once. */
  readonly id: string;
  readonly write: NonNullable<TransactWriteCommandInput['TransactItems']>[number];
}

export interface Collection<T extends Record<string, unknown>> {
  get(key: Partial<T>, opts?: GetOptions): Promise<T | undefined>;
  put(item: T, opts?: { ifNotExists?: boolean }): Promise<T>;
  update(key: Partial<T>, patch: Partial<T>): Promise<T>;
  delete(key: Partial<T>): Promise<void>;
  /**
   * Puts in BatchWriteItem calls of 25, retrying what DynamoDB leaves
   * unprocessed. Not atomic. A key given twice is written once, with the last item.
   */
  putMany(items: readonly T[]): Promise<void>;
  /** Deletes in BatchWriteItem calls of 25, like `putMany`. */
  deleteMany(keys: readonly Partial<T>[]): Promise<void>;
  /** The writes `transact` takes. They throw on a bad key or patch, before anything is sent. */
  readonly transactItem: {
    put(item: T, opts?: { ifNotExists?: boolean }): TransactItem;
    /** Fails the transaction when the item doesn't exist; see `derivedForPatch` for index fields. */
    update(key: Partial<T>, patch: Partial<T>): TransactItem;
    delete(key: Partial<T>): TransactItem;
    /** Writes nothing; fails the transaction unless the item exists (`exists: false`: unless it doesn't). */
    check(key: Partial<T>, exists: boolean): TransactItem;
  };
  /** One page of the items sharing the given partition-key values. Continue while `cursor` is set. */
  query(partition: Partial<T>, opts?: QueryOptions): Promise<Page<T>>;
  /** Every matching item, following pages until the last one. */
  queryAll(partition: Partial<T>, opts?: QueryAllOptions): Promise<T[]>;
}

export interface Db {
  collection<T extends Record<string, unknown>>(name: string, opts: CollectionOptions<T>): Collection<T>;
  /**
   * TransactWriteItems: all of `items` or none. A failed condition rejects
   * with DynamoDB's TransactionCanceledException, whose `CancellationReasons`
   * line up with `items`; a conflict with another transaction, or throttling, is retried.
   */
  transact(items: readonly TransactItem[]): Promise<void>;
  /** Escape hatch (AWS-specific): the DynamoDB document client and table name. */
  raw(): { client: unknown; table: string };
}

/** DynamoDB's limit on the writes in one TransactWriteItems call. */
export const MAX_TRANSACT_ITEMS = 100;
const BATCH_WRITE_SIZE = 25;
/** Tries per call before a conflict or unprocessed items become an error. */
const MAX_ATTEMPTS = 8;

/** Full-jitter exponential backoff before try `attempt + 1`: up to 50 ms, 100 ms, … capped at 1 s. */
const backoff = (attempt: number) =>
  new Promise((resolve) => setTimeout(resolve, Math.random() * Math.min(1000, 25 * 2 ** attempt)));

const errorName = (e: unknown) => (e as { name?: unknown } | null)?.name;

/** Cancellation codes a retry can clear: another transaction held an item, or throttling. */
const TRANSIENT_CANCELLATIONS = new Set([
  'TransactionConflict',
  'ThrottlingError',
  'ProvisionedThroughputExceeded',
]);

function isTransient(e: unknown): boolean {
  // A single-item write that hit an item mid-transaction. The AWS SDK doesn't retry it.
  if (errorName(e) === 'TransactionConflictException') return true;
  if (errorName(e) !== 'TransactionCanceledException') return false;
  const codes = ((e as { CancellationReasons?: { Code?: string }[] }).CancellationReasons ?? []).map(
    (r) => r.Code ?? 'None',
  );
  return (
    codes.some((c) => TRANSIENT_CANCELLATIONS.has(c)) &&
    codes.every((c) => c === 'None' || TRANSIENT_CANCELLATIONS.has(c))
  );
}

/** Runs `call`, retrying with backoff while it fails only because of a transaction conflict or throttling. */
async function retryTransient<A>(call: () => Promise<A>): Promise<A> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (e) {
      if (attempt >= MAX_ATTEMPTS || !isTransient(e)) throw e;
      await backoff(attempt);
    }
  }
}

export const INTERNAL_ATTRIBUTES = [
  'pk',
  'sk',
  'gsi1pk',
  'gsi1sk',
  'gsi2pk',
  'gsi2sk',
  'gsi3pk',
  'gsi3sk',
  '_c',
  '_ttl',
];
const COLLECTION_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

function list<T>(f: Fields<T> | undefined): string[] {
  if (!f) return [];
  return typeof f === 'string' ? [f] : [...f];
}

function table(): string {
  const t = getBindings().table;
  if (!t) throw new Error(`This app has no database. Add \`db: true\` to ${APP_CONFIG_FILE}.`);
  return t;
}

function ddb(): DynamoDBDocumentClient {
  return ddbClient();
}

/** Values for `fields` from `item`, joined by `#`. Throws when any is missing. */
export function keyPart(item: Record<string, unknown>, fields: string[], what: string): string {
  return fields
    .map((f) => {
      const v = item[f];
      if (v === undefined || v === null || v === '') throw new Error(`${what}: missing key attribute "${f}"`);
      if (typeof v !== 'string' && typeof v !== 'number')
        throw new Error(`${what}: key attribute "${f}" must be a string or number`);
      return String(v);
    })
    .join('#');
}

function hasAll(item: Record<string, unknown>, fields: string[]): boolean {
  return fields.every((f) => item[f] !== undefined && item[f] !== null && item[f] !== '');
}

export function stripInternal(
  item: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!item) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(item)) if (!INTERNAL_ATTRIBUTES.includes(k)) out[k] = v;
  return out;
}

/**
 * What a cursor is bound to: the table, index and whole key condition, so it
 * only opens for the query that issued it. The sort condition is included
 * because DynamoDB rejects a start key outside it with a ValidationException.
 * Limit and order may change between pages.
 */
function cursorScope(input: QueryCommandInput): string {
  return JSON.stringify([
    input.TableName,
    input.IndexName ?? null,
    input.KeyConditionExpression,
    input.ExpressionAttributeNames,
    input.ExpressionAttributeValues,
  ]);
}

/** Pure key/attribute mapping, exported for tests and the console's data browser. */
export function createKeyMapper<T extends Record<string, unknown>>(name: string, opts: CollectionOptions<T>) {
  if (!COLLECTION_NAME.test(name)) throw new Error(`Invalid collection name "${name}"`);
  const partition = list(opts.partition);
  const sort = list(opts.sort);
  if (partition.length === 0) throw new Error(`Collection "${name}" needs a partition key`);
  const indexes = Object.entries(opts.indexes ?? {}).map(([indexName, ix]) => ({
    name: indexName,
    slot: ix.slot,
    partition: list(ix.partition),
    sort: list(ix.sort),
  }));
  const slots = new Set<number>();
  for (const ix of indexes) {
    if (slots.has(ix.slot)) throw new Error(`Collection "${name}": two indexes use slot ${ix.slot}`);
    slots.add(ix.slot);
  }
  const what = `collection "${name}"`;

  const primaryKey = (item: Record<string, unknown>) => ({
    pk: `${name}#${keyPart(item, partition, what)}`,
    sk: sort.length ? keyPart(item, sort, what) : '#',
  });

  /** gsi/ttl attributes for `item`; `null` values mean "remove". */
  const derived = (item: Record<string, unknown>): Record<string, string | number | null> => {
    const out: Record<string, string | number | null> = {};
    for (const ix of indexes) {
      if (hasAll(item, ix.partition) && (ix.sort.length === 0 || hasAll(item, ix.sort))) {
        out[`gsi${ix.slot}pk`] = `${name}#${ix.name}#${keyPart(item, ix.partition, what)}`;
        out[`gsi${ix.slot}sk`] = ix.sort.length ? keyPart(item, ix.sort, what) : '#';
      } else {
        out[`gsi${ix.slot}pk`] = null;
        out[`gsi${ix.slot}sk`] = null;
      }
    }
    if (opts.ttl) {
      const v = item[opts.ttl];
      out._ttl = typeof v === 'number' ? Math.floor(v) : null;
    }
    return out;
  };

  const toItem = (item: T): Record<string, unknown> => {
    const extra: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(derived(item))) if (v !== null) extra[k] = v;
    return { ...item, ...primaryKey(item), _c: name, ...extra };
  };

  /**
   * The index a query reads, or undefined for the collection's own key. The
   * type already rules out `consistent` on an index; this catches untyped callers.
   */
  const queryIndex = (q: QueryAllOptions) => {
    if (!q.index) return undefined;
    const ix = indexes.find((i) => i.name === q.index);
    if (!ix) throw new Error(`${what} has no index "${q.index}"`);
    if (q.consistent)
      throw new Error(`${what}: index "${ix.name}" is eventually consistent; drop \`consistent: true\``);
    return ix;
  };

  /**
   * The gsi/ttl attributes an update can set (or remove, `null`) without
   * reading the item: an index whose fields the patch changes is rebuilt from
   * the key fields and the patch when they give all of its fields, and dropped
   * when the patch removes one. Otherwise the index is `unresolved`: it needs
   * the stored item's other fields. Only key fields are taken from `key`, so a
   * stale document passed as the key can't stand in for them.
   */
  const planDerived = (key: Record<string, unknown>, patch: Record<string, unknown>) => {
    const set: Record<string, string | number | null> = {};
    const unresolved: { index: (typeof indexes)[number]; changed: string[]; missing: string[] }[] = [];
    const known: Record<string, unknown> = { ...patch };
    for (const f of keyFields) known[f] = key[f];
    for (const ix of indexes) {
      const fields = [...ix.partition, ...ix.sort];
      const changed = fields.filter((f) => Object.hasOwn(patch, f));
      if (!changed.length) continue;
      if (!hasAll(patch, changed)) {
        set[`gsi${ix.slot}pk`] = null;
        set[`gsi${ix.slot}sk`] = null;
        continue;
      }
      const missing = fields.filter((f) => !hasAll(known, [f]));
      if (missing.length) {
        unresolved.push({ index: ix, changed, missing });
        continue;
      }
      set[`gsi${ix.slot}pk`] = `${name}#${ix.name}#${keyPart(known, ix.partition, what)}`;
      set[`gsi${ix.slot}sk`] = ix.sort.length ? keyPart(known, ix.sort, what) : '#';
    }
    if (opts.ttl && Object.hasOwn(patch, opts.ttl)) {
      const v = patch[opts.ttl];
      set._ttl = typeof v === 'number' ? Math.floor(v) : null;
    }
    return { set, unresolved };
  };

  /**
   * `planDerived`'s attributes for an update that can't read the item at all,
   * as in a transaction. Throws when an index is unresolved: the patch must
   * give all of the fields of an index it changes.
   */
  const derivedForPatch = (
    key: Record<string, unknown>,
    patch: Record<string, unknown>,
  ): Record<string, string | number | null> => {
    const { set, unresolved } = planDerived(key, patch);
    const first = unresolved[0];
    if (first)
      throw new Error(
        `${what}: a transaction's update that changes ${quoted(first.changed)} must also set ${quoted(first.missing)}, ` +
          `so index "${first.index.name}" can be rebuilt without reading the document`,
      );
    return set;
  };

  /** Identifies the item `key` addresses: its `pk` and `sk`, unambiguously. */
  const itemId = (key: Record<string, unknown>): string => {
    const { pk, sk } = primaryKey(key);
    return JSON.stringify([pk, sk]);
  };

  /** Throws when `patch` changes a key field. */
  const assertKeyUnchanged = (key: Record<string, unknown>, patch: Record<string, unknown>) => {
    for (const k of Object.keys(patch)) {
      if (keyFields.has(k) && patch[k] !== key[k])
        throw new Error(`${what}: cannot change key attribute "${k}"`);
    }
  };

  const queryInput = (values: Partial<T>, q: QueryOptions, tableName: string): QueryCommandInput => {
    let pkAttr = 'pk';
    let skAttr = 'sk';
    let pkValue: string;
    let indexName: string | undefined;
    const ix = queryIndex(q);
    if (ix) {
      pkAttr = `gsi${ix.slot}pk`;
      skAttr = `gsi${ix.slot}sk`;
      indexName = `gsi${ix.slot}`;
      pkValue = `${name}#${ix.name}#${keyPart(values, ix.partition, what)}`;
    } else {
      pkValue = `${name}#${keyPart(values, partition, what)}`;
    }
    const names: Record<string, string> = { '#pk': pkAttr };
    const vals: Record<string, unknown> = { ':pk': pkValue };
    let cond = '#pk = :pk';
    const sortCond = (expr: string) => {
      names['#sk'] = skAttr;
      cond += ` AND ${expr}`;
    };
    if (q.beginsWith !== undefined) {
      vals[':b'] = q.beginsWith;
      sortCond('begins_with(#sk, :b)');
    } else if (q.between) {
      vals[':lo'] = String(q.between[0]);
      vals[':hi'] = String(q.between[1]);
      sortCond('#sk BETWEEN :lo AND :hi');
    } else {
      const ops: Array<[keyof QueryOptions, string]> = [
        ['gt', '>'],
        ['gte', '>='],
        ['lt', '<'],
        ['lte', '<='],
      ];
      const set = ops.filter(([k]) => q[k] !== undefined);
      if (set.length > 1) throw new Error('Use `between` for a range; only one of gt/gte/lt/lte is allowed');
      const op = set[0];
      if (op) {
        vals[':v'] = String(q[op[0]]);
        sortCond(`#sk ${op[1]} :v`);
      }
    }
    return {
      TableName: tableName,
      ...(indexName ? { IndexName: indexName } : {}),
      KeyConditionExpression: cond,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: vals,
      ScanIndexForward: !q.reverse,
      ...(q.limit ? { Limit: q.limit } : {}),
      ...(q.consistent ? { ConsistentRead: true } : {}),
    };
  };

  const keyFields = new Set([...partition, ...sort]);

  return {
    name,
    partition,
    sort,
    indexes,
    primaryKey,
    itemId,
    derived,
    planDerived,
    derivedForPatch,
    assertKeyUnchanged,
    toItem,
    queryIndex,
    queryInput,
    keyFields,
  };
}

const quoted = (fields: string[]) => fields.map((f) => `"${f}"`).join(', ');

function collection<T extends Record<string, unknown>>(
  name: string,
  opts: CollectionOptions<T>,
): Collection<T> {
  const m = createKeyMapper(name, opts);

  const putInput = (item: T, putOpts?: { ifNotExists?: boolean }) => ({
    TableName: table(),
    Item: m.toItem(item),
    ...(putOpts?.ifNotExists ? { ConditionExpression: 'attribute_not_exists(pk)' } : {}),
  });

  type WriteRequest = NonNullable<BatchWriteCommandInput['RequestItems']>[string][number];

  /**
   * Sends `requests` 25 at a time, one span per call. BatchWriteItem rejects a
   * call naming an item twice, so a later request for the same item replaces
   * an earlier one, as if they had been sent one by one.
   */
  const batchWrite = async (op: string, requests: { id: string; request: WriteRequest }[]) => {
    const latest = [...new Map(requests.map((r) => [r.id, r.request])).values()];
    if (!latest.length) return;
    const tableName = table();
    for (let i = 0; i < latest.length; i += BATCH_WRITE_SIZE) {
      let pending = latest.slice(i, i + BATCH_WRITE_SIZE);
      await span(op, name, async () => {
        for (let attempt = 1; ; attempt++) {
          // Puts and deletes are idempotent, so a call rejected for a conflict can go again whole.
          const input = { RequestItems: { [tableName]: pending } };
          const out = await retryTransient(() => ddb().send(new BatchWriteCommand(input)));
          pending = out.UnprocessedItems?.[tableName] ?? [];
          if (!pending.length) return;
          if (attempt >= MAX_ATTEMPTS)
            throw new Error(
              `collection "${name}": DynamoDB left ${pending.length} write(s) unprocessed after ${attempt} tries`,
            );
          await backoff(attempt);
        }
      });
    }
  };

  return {
    get: (key, getOpts) =>
      span('db.get', name, async () => {
        const out = await ddb().send(
          new GetCommand({
            TableName: table(),
            Key: m.primaryKey(key),
            ...(getOpts?.consistent ? { ConsistentRead: true } : {}),
          }),
        );
        return stripInternal(out.Item) as T | undefined;
      }),

    put: (item, putOpts) =>
      span('db.put', name, async () => {
        const input = putInput(item, putOpts);
        await retryTransient(() => ddb().send(new PutCommand(input)));
        return item;
      }),

    update: (key, patch) =>
      span('db.update', name, async () => {
        m.assertKeyUnchanged(key, patch);
        const tableName = table();
        const Key = m.primaryKey(key);
        // Indexes the key and patch determine are written with the patch, atomically.
        const plan = m.planDerived(key, patch);
        const { expr, names, values } = setExpression({ ...patch, ...plan.set }, m.keyFields);
        const out = await retryTransient(() =>
          ddb().send(
            new UpdateCommand({
              TableName: tableName,
              Key,
              UpdateExpression: expr,
              ExpressionAttributeNames: { ...names, '#pk': 'pk' },
              ...(Object.keys(values).length ? { ExpressionAttributeValues: values } : {}),
              ConditionExpression: 'attribute_exists(#pk)',
              ReturnValues: 'ALL_NEW',
            }),
          ),
        );
        const item = out.Attributes ?? {};
        // The rest need the item's other fields: each is rebuilt from the item the first
        // call returned, in its own write, if that index's fields still hold. A failed
        // condition means a later write changed them, and every write that changes an
        // index field writes that index too, so there is nothing left to fix. One write
        // per index keeps a later write to one index from cancelling another's rebuild.
        const all = m.derived(item);
        for (const { index } of plan.unresolved) {
          const d = setExpression(
            {
              [`gsi${index.slot}pk`]: all[`gsi${index.slot}pk`],
              [`gsi${index.slot}sk`]: all[`gsi${index.slot}sk`],
            },
            new Set(),
          );
          const rebuildNames: Record<string, string> = { ...d.names, '#pk': 'pk' };
          const rebuildValues: Record<string, unknown> = { ...d.values };
          const unchanged = [...index.partition, ...index.sort]
            .filter((f) => !m.keyFields.has(f))
            .map((f, i) => {
              rebuildNames[`#c${i}`] = f;
              if (item[f] === undefined) return `attribute_not_exists(#c${i})`;
              rebuildValues[`:c${i}`] = item[f];
              return `#c${i} = :c${i}`;
            });
          try {
            await retryTransient(() =>
              ddb().send(
                new UpdateCommand({
                  TableName: tableName,
                  Key,
                  UpdateExpression: d.expr,
                  ExpressionAttributeNames: rebuildNames,
                  ...(Object.keys(rebuildValues).length ? { ExpressionAttributeValues: rebuildValues } : {}),
                  ConditionExpression: ['attribute_exists(#pk)', ...unchanged].join(' AND '),
                }),
              ),
            );
          } catch (e) {
            if (errorName(e) !== 'ConditionalCheckFailedException') throw e;
          }
        }
        // The document as this update left it; the rebuilds only touch index attributes.
        return stripInternal(item) as T;
      }),

    delete: (key) =>
      span('db.delete', name, async () => {
        const input = { TableName: table(), Key: m.primaryKey(key) };
        await retryTransient(() => ddb().send(new DeleteCommand(input)));
      }),

    putMany: (items) =>
      batchWrite(
        'db.putMany',
        items.map((item) => ({ id: m.itemId(item), request: { PutRequest: { Item: m.toItem(item) } } })),
      ),

    deleteMany: (keys) =>
      batchWrite(
        'db.deleteMany',
        keys.map((key) => ({ id: m.itemId(key), request: { DeleteRequest: { Key: m.primaryKey(key) } } })),
      ),

    transactItem: {
      put: (item, putOpts) => ({
        collection: name,
        id: m.itemId(item),
        write: { Put: putInput(item, putOpts) },
      }),
      update: (key, patch) => {
        m.assertKeyUnchanged(key, patch);
        const derived = m.derivedForPatch(key, patch);
        const { expr, names, values } = setExpression({ ...patch, ...derived }, m.keyFields);
        return {
          collection: name,
          id: m.itemId(key),
          write: {
            Update: {
              TableName: table(),
              Key: m.primaryKey(key),
              UpdateExpression: expr,
              ExpressionAttributeNames: { ...names, '#pk': 'pk' },
              ...(Object.keys(values).length ? { ExpressionAttributeValues: values } : {}),
              ConditionExpression: 'attribute_exists(#pk)',
            },
          },
        };
      },
      delete: (key) => ({
        collection: name,
        id: m.itemId(key),
        write: { Delete: { TableName: table(), Key: m.primaryKey(key) } },
      }),
      check: (key, exists) => ({
        collection: name,
        id: m.itemId(key),
        write: {
          ConditionCheck: {
            TableName: table(),
            Key: m.primaryKey(key),
            ConditionExpression: exists ? 'attribute_exists(pk)' : 'attribute_not_exists(pk)',
          },
        },
      }),
    },

    query: (values, q = {}) =>
      span('db.query', name, async () => {
        const input = m.queryInput(values, q, table());
        const scope = cursorScope(input);
        if (q.cursor) input.ExclusiveStartKey = openCursor(q.cursor, scope);
        const out = await ddb().send(new QueryCommand(input));
        const page: Page<T> = { items: (out.Items ?? []).map((i) => stripInternal(i) as T) };
        if (out.LastEvaluatedKey) page.cursor = sealCursor(out.LastEvaluatedKey, scope);
        return page;
      }),

    queryAll: async (values, q = {}) => {
      const input = m.queryInput(values, q, table());
      const items: T[] = [];
      let start: Record<string, unknown> | undefined;
      do {
        const out = await span('db.query', name, () =>
          ddb().send(new QueryCommand(start ? { ...input, ExclusiveStartKey: start } : input)),
        );
        for (const i of out.Items ?? []) items.push(stripInternal(i) as T);
        start = out.LastEvaluatedKey;
      } while (start);
      return items;
    },
  };
}

/** `SET #a = :a, ... REMOVE #b` from a patch; `undefined`/`null` values are removed. */
export function setExpression(
  patch: Record<string, unknown>,
  skip: Set<string>,
): { expr: string; names: Record<string, string>; values: Record<string, unknown> } {
  const sets: string[] = [];
  const removes: string[] = [];
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  let i = 0;
  for (const [k, v] of Object.entries(patch)) {
    if (skip.has(k)) continue;
    const n = `#f${i}`;
    names[n] = k;
    if (v === undefined || v === null) removes.push(n);
    else {
      values[`:v${i}`] = v;
      sets.push(`${n} = :v${i}`);
    }
    i++;
  }
  const parts: string[] = [];
  if (sets.length) parts.push(`SET ${sets.join(', ')}`);
  if (removes.length) parts.push(`REMOVE ${removes.join(', ')}`);
  if (!parts.length) {
    // No-op update still verifies existence.
    names['#c'] = '_c';
    parts.push('SET #c = #c');
  }
  return { expr: parts.join(' '), names, values };
}

function transact(items: readonly TransactItem[]): Promise<void> {
  if (!items.length) return Promise.resolve();
  const collections = [...new Set(items.map((i) => i.collection))].join(',');
  return span('db.transact', collections, async () => {
    const input = { TransactItems: items.map((i) => i.write) };
    await retryTransient(() => ddb().send(new TransactWriteCommand(input)));
  });
}

export const db: Db = {
  collection,
  transact,
  raw: () => ({ client: ddb(), table: table() }),
};
