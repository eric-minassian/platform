import {
  DeleteCommand,
  type DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  type QueryCommandInput,
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

export interface QueryOptions {
  index?: string;
  beginsWith?: string;
  between?: [KeyValue, KeyValue];
  gt?: KeyValue;
  gte?: KeyValue;
  lt?: KeyValue;
  lte?: KeyValue;
  limit?: number;
  /**
   * A `cursor` from the previous page of this same query (same partition,
   * index and sort condition; `limit` and `reverse` may change). Any other
   * value throws `InvalidCursorError`, which the server answers with a 400.
   */
  cursor?: string;
  reverse?: boolean;
}

export interface Page<T> {
  items: T[];
  /**
   * Set when more items may follow, whatever `items.length` is: a page also
   * ends at 1 MB of data, so it can be shorter than `limit`. The next page can
   * be empty. Opaque; safe to hand to browsers.
   */
  cursor?: string;
}

export interface Collection<T extends Record<string, unknown>> {
  get(key: Partial<T>): Promise<T | undefined>;
  put(item: T, opts?: { ifNotExists?: boolean }): Promise<T>;
  update(key: Partial<T>, patch: Partial<T>): Promise<T>;
  delete(key: Partial<T>): Promise<void>;
  /** One page of the items sharing the given partition-key values. Continue while `cursor` is set. */
  query(partition: Partial<T>, opts?: QueryOptions): Promise<Page<T>>;
  /** Every matching item, following pages until the last one. */
  queryAll(partition: Partial<T>, opts?: Omit<QueryOptions, 'cursor' | 'limit'>): Promise<T[]>;
}

export interface Db {
  collection<T extends Record<string, unknown>>(name: string, opts: CollectionOptions<T>): Collection<T>;
  /** Escape hatch (AWS-specific): the DynamoDB document client and table name. */
  raw(): { client: unknown; table: string };
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

export function stripInternal<T>(item: Record<string, unknown> | undefined): T | undefined {
  if (!item) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(item)) if (!INTERNAL_ATTRIBUTES.includes(k)) out[k] = v;
  return out as T;
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

  const queryInput = (values: Partial<T>, q: QueryOptions, tableName: string): QueryCommandInput => {
    let pkAttr = 'pk';
    let skAttr = 'sk';
    let pkValue: string;
    let indexName: string | undefined;
    if (q.index) {
      const ix = indexes.find((i) => i.name === q.index);
      if (!ix) throw new Error(`${what} has no index "${q.index}"`);
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
      vals[':b'] = String(q.beginsWith);
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
    };
  };

  const keyFields = new Set([...partition, ...sort]);
  const derivedSources = new Set([
    ...indexes.flatMap((i) => [...i.partition, ...i.sort]),
    ...(opts.ttl ? [opts.ttl] : []),
  ]);

  return {
    name,
    partition,
    sort,
    indexes,
    primaryKey,
    derived,
    toItem,
    queryInput,
    keyFields,
    derivedSources,
  };
}

function collection<T extends Record<string, unknown>>(
  name: string,
  opts: CollectionOptions<T>,
): Collection<T> {
  const m = createKeyMapper(name, opts);
  return {
    get: (key) =>
      span('db.get', name, async () => {
        const out = await ddb().send(new GetCommand({ TableName: table(), Key: m.primaryKey(key) }));
        return stripInternal<T>(out.Item);
      }),

    put: (item, putOpts) =>
      span('db.put', name, async () => {
        await ddb().send(
          new PutCommand({
            TableName: table(),
            Item: m.toItem(item),
            ...(putOpts?.ifNotExists ? { ConditionExpression: 'attribute_not_exists(pk)' } : {}),
          }),
        );
        return item;
      }),

    update: (key, patch) =>
      span('db.update', name, async () => {
        for (const k of Object.keys(patch)) {
          if (m.keyFields.has(k) && patch[k] !== key[k])
            throw new Error(`collection "${name}": cannot change key attribute "${k}"`);
        }
        const tableName = table();
        const Key = m.primaryKey(key);
        const { expr, names, values } = setExpression(patch as Record<string, unknown>, m.keyFields);
        const out = await ddb().send(
          new UpdateCommand({
            TableName: tableName,
            Key,
            UpdateExpression: expr,
            ExpressionAttributeNames: { ...names, '#pk': 'pk' },
            ...(Object.keys(values).length ? { ExpressionAttributeValues: values } : {}),
            ConditionExpression: 'attribute_exists(#pk)',
            ReturnValues: 'ALL_NEW',
          }),
        );
        let item = out.Attributes ?? {};
        if (Object.keys(patch).some((k) => m.derivedSources.has(k))) {
          const d = setExpression(m.derived(item), new Set());
          const again = await ddb().send(
            new UpdateCommand({
              TableName: tableName,
              Key,
              UpdateExpression: d.expr,
              ExpressionAttributeNames: { ...d.names, '#pk': 'pk' },
              ...(Object.keys(d.values).length ? { ExpressionAttributeValues: d.values } : {}),
              ConditionExpression: 'attribute_exists(#pk)',
              ReturnValues: 'ALL_NEW',
            }),
          );
          item = again.Attributes ?? item;
        }
        return stripInternal<T>(item)!;
      }),

    delete: (key) =>
      span('db.delete', name, async () => {
        await ddb().send(new DeleteCommand({ TableName: table(), Key: m.primaryKey(key) }));
      }),

    query: (values, q = {}) =>
      span('db.query', name, async () => {
        const input = m.queryInput(values, q, table());
        const scope = cursorScope(input);
        if (q.cursor) input.ExclusiveStartKey = openCursor(q.cursor, scope);
        const out = await ddb().send(new QueryCommand(input));
        const page: Page<T> = { items: (out.Items ?? []).map((i) => stripInternal<T>(i)!) };
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
        for (const i of out.Items ?? []) items.push(stripInternal<T>(i)!);
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

export const db: Db = {
  collection,
  raw: () => ({ client: ddb(), table: table() }),
};
