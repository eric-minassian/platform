import { Cause, Effect, Exit, Schema } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Db, TransactionCanceled } from '../src/index.ts';
import { newContext, runWithContext } from '../src/runtime/context.ts';
import { InvalidCursorError } from '../src/runtime/cursor.ts';
import { createKeyMapper, db, type QueryOptions, setExpression, stripInternal } from '../src/runtime/db.ts';
import { captureTelemetry, mockClient, resetPlatform, useTestBindings } from '../src/testing.ts';

interface Todo extends Record<string, unknown> {
  userId: string;
  id: string;
  title: string;
  status?: string;
  createdAt?: string;
  expiresAt?: number;
}

const opts = {
  partition: 'userId',
  sort: 'id',
  indexes: { byStatus: { slot: 2, partition: ['userId', 'status'], sort: 'createdAt' } },
  ttl: 'expiresAt',
} as const;

describe('key mapping', () => {
  const m = createKeyMapper<Todo>('todos', opts);

  it('builds primary, index and ttl attributes', () => {
    const item = m.toItem({
      userId: 'u1',
      id: 't1',
      title: 'x',
      status: 'open',
      createdAt: '2026-01-01',
      expiresAt: 123.9,
    });
    expect(item).toMatchObject({
      pk: 'todos#u1',
      sk: 't1',
      _c: 'todos',
      gsi2pk: 'todos#byStatus#u1#open',
      gsi2sk: '2026-01-01',
      _ttl: 123,
    });
  });

  it('leaves sparse indexes and ttl off when fields are missing', () => {
    const item = m.toItem({ userId: 'u1', id: 't1', title: 'x' });
    expect(item).not.toHaveProperty('gsi2pk');
    expect(item).not.toHaveProperty('_ttl');
  });

  it('uses # as the sort key without a sort field', () => {
    const m2 = createKeyMapper<{ email: string } & Record<string, unknown>>('users', { partition: 'email' });
    expect(m2.primaryKey({ email: 'a@b.c' })).toEqual({ pk: 'users#a@b.c', sk: '#' });
  });

  it('rejects missing key attributes and slot collisions', () => {
    expect(() => m.primaryKey({ userId: 'u1' })).toThrow(/missing key attribute "id"/);
    expect(() =>
      createKeyMapper<Todo>('x', {
        partition: 'userId',
        indexes: { a: { slot: 1, partition: 'id' }, b: { slot: 1, partition: 'title' } },
      }),
    ).toThrow(/slot 1/);
  });

  it('builds queries with sort conditions, index and order', () => {
    const q = m.queryInput({ userId: 'u1' }, { beginsWith: 't', limit: 5, reverse: true }, 'tbl');
    expect(q).toEqual({
      TableName: 'tbl',
      KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :b)',
      ExpressionAttributeNames: { '#pk': 'pk', '#sk': 'sk' },
      ExpressionAttributeValues: { ':pk': 'todos#u1', ':b': 't' },
      ScanIndexForward: false,
      Limit: 5,
    });
    const ix = m.queryInput(
      { userId: 'u1', status: 'open' },
      { index: 'byStatus', between: ['2026-01', '2026-02'] },
      'tbl',
    );
    expect(ix.IndexName).toBe('gsi2');
    expect(ix.ExpressionAttributeNames).toEqual({ '#pk': 'gsi2pk', '#sk': 'gsi2sk' });
    expect(ix.ExpressionAttributeValues).toEqual({
      ':pk': 'todos#byStatus#u1#open',
      ':lo': '2026-01',
      ':hi': '2026-02',
    });
    expect(() => m.queryInput({ userId: 'u1' }, { gt: 1, lt: 2 }, 't')).toThrow(/between/);
    expect(() => m.queryInput({ userId: 'u1' }, { index: 'nope' }, 't')).toThrow(/no index/);
  });

  it('strips internal attributes', () => {
    expect(stripInternal({ pk: 'a', sk: 'b', gsi1pk: 'c', _c: 'x', _ttl: 1, title: 't' })).toEqual({
      title: 't',
    });
  });

  it('rebuilds index and ttl attributes from an update patch alone', () => {
    // byStatus is userId (from the key) + status, sorted by createdAt.
    const key = { userId: 'u1', id: 't1' };
    expect(m.derivedForPatch(key, { title: 'x' })).toEqual({});
    expect(m.derivedForPatch(key, { status: 'done', createdAt: '2026-02-01', expiresAt: 9.5 })).toEqual({
      gsi2pk: 'todos#byStatus#u1#done',
      gsi2sk: '2026-02-01',
      _ttl: 9,
    });
    expect(m.derivedForPatch(key, { status: null, createdAt: '2026', expiresAt: null })).toEqual({
      gsi2pk: null,
      gsi2sk: null,
      _ttl: null,
    });
    expect(() => m.derivedForPatch(key, { status: 'done' })).toThrow(
      /changes "status" must also set "createdAt", so index "byStatus"/,
    );
    // Only key fields come from the key: a stale document passed as one doesn't fill in the rest.
    expect(() => m.derivedForPatch({ ...key, createdAt: 'stale' }, { status: 'done' })).toThrow(
      /must also set "createdAt"/,
    );
  });

  it('builds SET/REMOVE update expressions', () => {
    expect(setExpression({ title: 'x', status: undefined, id: 'k' }, new Set(['id']))).toEqual({
      expr: 'SET #f0 = :v0 REMOVE #f1',
      names: { '#f0': 'title', '#f1': 'status' },
      values: { ':v0': 'x' },
    });
  });
});

describe('collection operations', () => {
  const sent: Array<{ name: string; input: Record<string, unknown> }> = [];
  let tel: ReturnType<typeof captureTelemetry>;

  beforeEach(() => {
    useTestBindings({ table: 'app--test' });
    tel = captureTelemetry();
    sent.length = 0;
    mockClient('ddb', (cmd) => {
      sent.push({ name: cmd.constructor.name, input: cmd.input });
      switch (cmd.constructor.name) {
        case 'GetCommand':
          return { Item: { pk: 'todos#u1', sk: 't1', _c: 'todos', userId: 'u1', id: 't1', title: 'hi' } };
        case 'QueryCommand':
          return {
            Items: [{ pk: 'todos#u1', sk: 't1', userId: 'u1', id: 't1', title: 'hi' }],
            LastEvaluatedKey: { pk: 'p', sk: 's' },
          };
        case 'UpdateCommand':
          return {
            Attributes: {
              pk: 'todos#u1',
              sk: 't1',
              userId: 'u1',
              id: 't1',
              title: 'new',
              status: 'done',
              createdAt: 'c',
            },
          };
        default:
          return {};
      }
    });
  });
  afterEach(() => {
    tel.stop();
    resetPlatform();
  });

  const todos = () => db.collection<Todo>('todos', opts);

  it('get/put/delete/query send the right commands and emit spans', () =>
    runWithContext(newContext(), async () => {
      expect(await todos().get({ userId: 'u1', id: 't1' })).toEqual({ userId: 'u1', id: 't1', title: 'hi' });
      await todos().put({ userId: 'u1', id: 't2', title: 'x' }, { ifNotExists: true });
      await todos().delete({ userId: 'u1', id: 't2' });
      const page = await todos().query({ userId: 'u1' });
      expect(page.items).toEqual([{ userId: 'u1', id: 't1', title: 'hi' }]);
      expect(page.cursor).toEqual(expect.any(String));

      expect(sent.map((s) => s.name)).toEqual(['GetCommand', 'PutCommand', 'DeleteCommand', 'QueryCommand']);
      expect(sent[0]!.input).toEqual({ TableName: 'app--test', Key: { pk: 'todos#u1', sk: 't1' } });
      expect(sent[1]!.input).toMatchObject({
        ConditionExpression: 'attribute_not_exists(pk)',
        Item: { pk: 'todos#u1', sk: 't2', _c: 'todos' },
      });
      const spans = tel.events.filter((e) => e.t === 'span').map((e) => (e as { op: string }).op);
      expect(spans).toEqual(['db.get', 'db.put', 'db.delete', 'db.query']);
    }));

  it('asks DynamoDB for a strongly consistent read only when told to', async () => {
    await todos().get({ userId: 'u1', id: 't1' }, { consistent: true });
    await todos().query({ userId: 'u1' }, { consistent: true, limit: 5 });
    await todos().get({ userId: 'u1', id: 't1' }, { consistent: false });
    await todos().query({ userId: 'u1' });
    expect(sent.map((s) => [s.name, s.input.ConsistentRead])).toEqual([
      ['GetCommand', true],
      ['QueryCommand', true],
      ['GetCommand', undefined],
      ['QueryCommand', undefined],
    ]);
  });

  it('refuses a consistent read of an index, even from an untyped caller', async () => {
    // Typed callers get a compile error instead (test/types/registered.ts).
    const q = { index: 'byStatus', consistent: true } as unknown as QueryOptions;
    const partition = { userId: 'u1', status: 'open' };
    await expect(todos().query(partition, q)).rejects.toThrow(/index "byStatus" is eventually consistent/);
    await expect(todos().queryAll(partition, q)).rejects.toThrow(/index "byStatus" is eventually consistent/);
    expect(sent).toEqual([]);
  });

  it('update writes the indexes the key and patch determine with the patch, in one call', async () => {
    await todos().update({ userId: 'u1', id: 't1' }, { status: 'done', createdAt: '2026', expiresAt: 7.9 });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.input).toMatchObject({
      UpdateExpression: 'SET #f0 = :v0, #f1 = :v1, #f2 = :v2, #f3 = :v3, #f4 = :v4, #f5 = :v5',
      ExpressionAttributeNames: {
        '#f0': 'status',
        '#f1': 'createdAt',
        '#f2': 'expiresAt',
        '#f3': 'gsi2pk',
        '#f4': 'gsi2sk',
        '#f5': '_ttl',
      },
      ExpressionAttributeValues: {
        ':v0': 'done',
        ':v1': '2026',
        ':v2': 7.9,
        ':v3': 'todos#byStatus#u1#done',
        ':v4': '2026',
        ':v5': 7,
      },
      ConditionExpression: 'attribute_exists(#pk)',
    });
  });

  it('update rebuilds an index the patch only partly gives, if its fields still hold', async () => {
    const out = await todos().update({ userId: 'u1', id: 't1' }, { title: 'new', status: 'done' });
    expect(out).toEqual({ userId: 'u1', id: 't1', title: 'new', status: 'done', createdAt: 'c' });
    expect(sent).toHaveLength(2);
    expect(sent[0]!.input).toMatchObject({
      UpdateExpression: 'SET #f0 = :v0, #f1 = :v1',
      ConditionExpression: 'attribute_exists(#pk)',
      ReturnValues: 'ALL_NEW',
    });
    // Built from the item the first call returned, and only while status and createdAt are unchanged.
    expect(sent[1]!.input).toMatchObject({
      UpdateExpression: 'SET #f0 = :v0, #f1 = :v1',
      ExpressionAttributeNames: { '#f0': 'gsi2pk', '#f1': 'gsi2sk', '#c0': 'status', '#c1': 'createdAt' },
      ExpressionAttributeValues: { ':v0': 'todos#byStatus#u1#done', ':v1': 'c', ':c0': 'done', ':c1': 'c' },
      ConditionExpression: 'attribute_exists(#pk) AND #c0 = :c0 AND #c1 = :c1',
    });
  });

  it('update without index sources is a single call; changing keys is rejected', async () => {
    await todos().update({ userId: 'u1', id: 't1' }, { title: 'only' });
    expect(sent).toHaveLength(1);
    await expect(todos().update({ userId: 'u1', id: 't1' }, { id: 'other' })).rejects.toThrow(
      /cannot change key/,
    );
  });

  it('builds transaction writes with their conditions and index attributes', async () => {
    const t = todos().transactItem;
    const items = [
      t.put({ userId: 'u1', id: 'a', title: 'a' }),
      t.put({ userId: 'u1', id: 'b', title: 'b' }, { ifNotExists: true }),
      t.update({ userId: 'u1', id: 'c' }, { status: 'done', createdAt: '2026' }),
      t.delete({ userId: 'u1', id: 'd' }),
      t.check({ userId: 'u1', id: 'e' }, true),
      t.check({ userId: 'u1', id: 'f' }, false),
    ];
    expect(items.map((i) => [i.collection, i.id])).toEqual(
      ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ['todos', JSON.stringify(['todos#u1', id])]),
    );
    expect(() => t.update({ userId: 'u1', id: 'c' }, { id: 'other' })).toThrow(/cannot change key/);
    expect(() => t.update({ userId: 'u1', id: 'c' }, { status: 'done' })).toThrow(
      /must also set "createdAt"/,
    );

    await runWithContext(newContext(), () => db.transact(items));
    await db.transact([]);
    expect(sent.map((s) => s.name)).toEqual(['TransactWriteCommand']);
    const TableName = 'app--test';
    const Key = (sk: string) => ({ pk: 'todos#u1', sk });
    expect(sent[0]!.input.TransactItems).toEqual([
      {
        Put: { TableName, Item: { userId: 'u1', id: 'a', title: 'a', pk: 'todos#u1', sk: 'a', _c: 'todos' } },
      },
      {
        Put: {
          TableName,
          Item: { userId: 'u1', id: 'b', title: 'b', pk: 'todos#u1', sk: 'b', _c: 'todos' },
          ConditionExpression: 'attribute_not_exists(pk)',
        },
      },
      {
        Update: {
          TableName,
          Key: Key('c'),
          UpdateExpression: 'SET #f0 = :v0, #f1 = :v1, #f2 = :v2, #f3 = :v3',
          ExpressionAttributeNames: {
            '#f0': 'status',
            '#f1': 'createdAt',
            '#f2': 'gsi2pk',
            '#f3': 'gsi2sk',
            '#pk': 'pk',
          },
          ExpressionAttributeValues: {
            ':v0': 'done',
            ':v1': '2026',
            ':v2': 'todos#byStatus#u1#done',
            ':v3': '2026',
          },
          ConditionExpression: 'attribute_exists(#pk)',
        },
      },
      { Delete: { TableName, Key: Key('d') } },
      { ConditionCheck: { TableName, Key: Key('e'), ConditionExpression: 'attribute_exists(pk)' } },
      { ConditionCheck: { TableName, Key: Key('f'), ConditionExpression: 'attribute_not_exists(pk)' } },
    ]);
    const spans = tel.events.filter((e) => e.t === 'span') as Array<{ op: string; name?: string }>;
    expect(spans.map((e) => [e.op, e.name])).toEqual([['db.transact', 'todos']]);
  });

  it('explains a missing database binding', async () => {
    useTestBindings({});
    await expect(todos().get({ userId: 'u1', id: 't1' })).rejects.toThrow(/`db: true` to plat\.config\.ts/);
  });
});

describe('query cursors', () => {
  const queries: Array<Record<string, unknown>> = [];
  let pages: Array<{ Items: Record<string, unknown>[]; LastEvaluatedKey?: Record<string, unknown> }>;

  const row = (id: string, status?: string) => ({
    pk: 'todos#u1',
    sk: id,
    _c: 'todos',
    userId: 'u1',
    id,
    title: id,
    ...(status ? { status, gsi2pk: `todos#byStatus#u1#${status}`, gsi2sk: '2026' } : {}),
  });

  beforeEach(() => {
    useTestBindings({ table: 'app--test' });
    queries.length = 0;
    pages = [];
    mockClient('ddb', (cmd) => {
      queries.push(cmd.input);
      return pages.shift() ?? { Items: [] };
    });
  });
  afterEach(() => resetPlatform());

  const todos = () => db.collection<Todo>('todos', opts);

  /** A cursor the SDK issued for `todos.query(partition, q)`, whose start key is `lastKey`. */
  async function issue(
    lastKey: Record<string, unknown>,
    partition: Partial<Todo> = { userId: 'u1' },
    q = {},
  ) {
    pages.push({ Items: [], LastEvaluatedKey: lastKey });
    const { cursor } = await todos().query(partition, q);
    queries.length = 0;
    return cursor!;
  }

  it('hides the key layout and resumes from the start key it sealed', async () => {
    const lastKey = { pk: 'todos#u1', sk: 't5' };
    const cursor = await issue(lastKey, { userId: 'u1' }, { beginsWith: 't', limit: 2 });
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(cursor, 'base64url').toString('latin1')).not.toMatch(/todos#u1|"pk"|"sk"/);
    expect(await issue(lastKey)).not.toBe(await issue(lastKey));

    // Limit, order and consistency may change between pages; the key condition may not.
    await todos().query(
      { userId: 'u1' },
      { beginsWith: 't', limit: 10, reverse: true, consistent: true, cursor },
    );
    expect(queries[0]).toMatchObject({
      ExclusiveStartKey: lastKey,
      Limit: 10,
      ScanIndexForward: false,
      ConsistentRead: true,
    });
  });

  it('works on indexes and treats an empty cursor as the first page', async () => {
    const lastKey = { gsi2pk: 'todos#byStatus#u1#open', gsi2sk: '2026', pk: 'todos#u1', sk: 't1' };
    const partition = { userId: 'u1', status: 'open' };
    const cursor = await issue(lastKey, partition, { index: 'byStatus' });
    await todos().query(partition, { index: 'byStatus', cursor });
    expect(queries[0]).toMatchObject({ IndexName: 'gsi2', ExclusiveStartKey: lastKey });

    await todos().query({ userId: 'u1' }, { cursor: '' });
    expect(queries[1]).not.toHaveProperty('ExclusiveStartKey');
  });

  it('rejects edited, made-up and raw-key cursors without calling DynamoDB', async () => {
    const cursor = await issue({ pk: 'todos#u1', sk: 't5' });
    const edited = cursor.slice(0, 20) + (cursor[20] === 'A' ? 'B' : 'A') + cursor.slice(21);
    const rawKey = Buffer.from(JSON.stringify({ pk: 'todos#u1', sk: 't5' })).toString('base64url');
    for (const bad of [edited, cursor.slice(0, -4), rawKey, '%%%', 'abc', 42]) {
      await expect(todos().query({ userId: 'u1' }, { cursor: bad as string })).rejects.toBeInstanceOf(
        InvalidCursorError,
      );
    }
    expect(queries).toEqual([]);
  });

  it('rejects cursors issued for another query or stage', async () => {
    const cursor = await issue({ pk: 'todos#u1', sk: 't5' }, { userId: 'u1' }, { gt: 't1' });
    const reject = (p: Promise<unknown>) =>
      expect(p).rejects.toMatchObject({ status: 400, code: 'invalid_cursor' });

    await reject(todos().query({ userId: 'u2' }, { gt: 't1', cursor })); // another partition
    await reject(todos().query({ userId: 'u1' }, { gt: 't9', cursor })); // another sort condition
    await reject(todos().query({ userId: 'u1' }, { cursor })); // no sort condition
    await reject(todos().query({ userId: 'u1', status: 'open' }, { index: 'byStatus', gt: 't1', cursor }));
    await reject(db.collection<Todo>('notes', opts).query({ userId: 'u1' }, { gt: 't1', cursor }));
    useTestBindings({ table: 'app--test', stageKey: Buffer.alloc(32, 7).toString('base64url') });
    await reject(todos().query({ userId: 'u1' }, { gt: 't1', cursor }));
    expect(queries).toEqual([]);
  });

  it('omits the cursor on the last page and explains a stage without a key', async () => {
    pages.push({ Items: [row('t1')] });
    expect(await todos().query({ userId: 'u1' })).toEqual({
      items: [{ userId: 'u1', id: 't1', title: 't1' }],
    });

    useTestBindings({ table: 'app--test', stageKey: undefined });
    pages.push({ Items: [row('t1')], LastEvaluatedKey: { pk: 'todos#u1', sk: 't1' } });
    await expect(todos().query({ userId: 'u1' })).rejects.toThrow(/no stage key.*Redeploy/);
  });

  it('queryAll follows every page, including short and empty ones', async () => {
    pages.push(
      { Items: [row('t1'), row('t2')], LastEvaluatedKey: { pk: 'todos#u1', sk: 't2' } },
      { Items: [row('t3')], LastEvaluatedKey: { pk: 'todos#u1', sk: 't3' } },
      { Items: [], LastEvaluatedKey: { pk: 'todos#u1', sk: 't3' } },
      { Items: [row('t4', 'open')] },
    );
    const tel = captureTelemetry();
    const items = await runWithContext(newContext(), () =>
      todos().queryAll({ userId: 'u1' }, { reverse: true, consistent: true }),
    );
    tel.stop();
    expect(items.map((t) => t.id)).toEqual(['t1', 't2', 't3', 't4']);
    expect(items[3]).toEqual({ userId: 'u1', id: 't4', title: 't4', status: 'open' });
    expect(queries.map((q) => q.ExclusiveStartKey)).toEqual([
      undefined,
      { pk: 'todos#u1', sk: 't2' },
      { pk: 'todos#u1', sk: 't3' },
      { pk: 'todos#u1', sk: 't3' },
    ]);
    expect(
      queries.every((q) => q.ScanIndexForward === false && q.ConsistentRead === true && !('Limit' in q)),
    ).toBe(true);
    expect(tel.events.filter((e) => e.t === 'span').map((e) => (e as { op: string }).op)).toEqual([
      'db.query',
      'db.query',
      'db.query',
      'db.query',
    ]);
  });
});

describe('batch writes and retries', () => {
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  let respond: (name: string, input: Record<string, unknown>) => unknown;

  beforeEach(() => {
    useTestBindings({ table: 'app--test' });
    calls.length = 0;
    mockClient('ddb', (cmd) => {
      calls.push({ name: cmd.constructor.name, input: cmd.input });
      return respond(cmd.constructor.name, cmd.input);
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    resetPlatform();
  });

  const todos = () => db.collection<Todo>('todos', opts);
  const requests = (input: Record<string, unknown>) =>
    (input.RequestItems as Record<string, Array<Record<string, { Item?: Todo; Key?: unknown }>>>)[
      'app--test'
    ]!;
  const failure = (name: string, extra: Record<string, unknown> = {}) =>
    Object.assign(new Error(name), { name, ...extra });
  const canceled = (...codes: string[]) =>
    failure('TransactionCanceledException', { CancellationReasons: codes.map((Code) => ({ Code })) });

  it('putMany sends batches of 25, keeps the last item per key and resends unprocessed ones', async () => {
    let first = true;
    respond = (_, input) => {
      if (!first) return {};
      first = false;
      return { UnprocessedItems: { 'app--test': requests(input).slice(20) } };
    };
    const items = Array.from({ length: 30 }, (_, i) => ({ userId: 'u1', id: `t${i}`, title: 'v1' }));
    const tel = captureTelemetry();
    await runWithContext(newContext(), () =>
      todos().putMany([...items, { userId: 'u1', id: 't0', title: 'v2', status: 'open', createdAt: 'c' }]),
    );
    tel.stop();

    expect(calls.map((c) => [c.name, requests(c.input).length])).toEqual([
      ['BatchWriteCommand', 25],
      ['BatchWriteCommand', 5],
      ['BatchWriteCommand', 5],
    ]);
    expect(requests(calls[1]!.input)).toEqual(requests(calls[0]!.input).slice(20));
    const written = calls
      .slice(0, 1)
      .concat(calls.slice(2))
      .flatMap((c) => requests(c.input));
    expect(written.map((r) => r.PutRequest!.Item!.id)).toEqual(items.map((i) => i.id));
    expect(written[0]!.PutRequest!.Item).toEqual({
      userId: 'u1',
      id: 't0',
      title: 'v2',
      status: 'open',
      createdAt: 'c',
      pk: 'todos#u1',
      sk: 't0',
      _c: 'todos',
      gsi2pk: 'todos#byStatus#u1#open',
      gsi2sk: 'c',
    });
    // One span per batch, its retries included.
    expect(tel.events.filter((e) => e.t === 'span').map((e) => (e as { op: string }).op)).toEqual([
      'db.putMany',
      'db.putMany',
    ]);
  });

  it('deleteMany sends each key once, retries a conflict, and sends nothing for no keys', async () => {
    const failures = [failure('TransactionConflictException')];
    respond = () => {
      const f = failures.shift();
      if (f) throw f;
      return {};
    };
    await todos().deleteMany([
      { userId: 'u1', id: 't1' },
      { userId: 'u1', id: 't1' },
      { userId: 'u1', id: 't2' },
    ]);
    await todos().putMany([]);
    await todos().deleteMany([]);
    expect(calls).toHaveLength(2);
    expect(requests(calls[1]!.input)).toEqual(requests(calls[0]!.input));
    expect(requests(calls[0]!.input)).toEqual([
      { DeleteRequest: { Key: { pk: 'todos#u1', sk: 't1' } } },
      { DeleteRequest: { Key: { pk: 'todos#u1', sk: 't2' } } },
    ]);
  });

  it('gives up on writes DynamoDB keeps leaving unprocessed', async () => {
    vi.useFakeTimers();
    respond = (_, input) => ({ UnprocessedItems: { 'app--test': requests(input) } });
    // Settled before the timers run, so the rejection is never unhandled.
    const failed = todos()
      .deleteMany([{ userId: 'u1', id: 't1' }])
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    await vi.runAllTimersAsync();
    expect(await failed).toMatchObject({
      message: 'collection "todos": DynamoDB left 1 write(s) unprocessed after 8 tries',
    });
    expect(calls).toHaveLength(8);
  });

  it('retries a transaction canceled by a conflict, but not by a failed condition', async () => {
    const t = todos().transactItem;
    const items = [t.put({ userId: 'u1', id: 'a', title: 'a' }), t.check({ userId: 'u1', id: 'b' }, true)];
    let failures = [canceled('None', 'TransactionConflict'), canceled('ThrottlingError', 'None')];
    respond = () => {
      const f = failures.shift();
      if (f) throw f;
      return {};
    };
    await db.transact(items);
    expect(calls).toHaveLength(3);

    calls.length = 0;
    failures = [canceled('TransactionConflict', 'ConditionalCheckFailed')];
    await expect(db.transact(items)).rejects.toMatchObject({ name: 'TransactionCanceledException' });
    expect(calls).toHaveLength(1);
  });

  it("update leaves an index to the later write that changed the index's fields", async () => {
    const stored = {
      pk: 'todos#u1',
      sk: 't1',
      userId: 'u1',
      id: 't1',
      title: 'x',
      status: 'done',
      createdAt: 'c',
    };
    respond = (_, input) => {
      if (String(input.ConditionExpression).includes('#c0')) throw failure('ConditionalCheckFailedException');
      return { Attributes: stored };
    };
    const out = await todos().update({ userId: 'u1', id: 't1' }, { status: 'done' });
    expect(out).toEqual({ userId: 'u1', id: 't1', title: 'x', status: 'done', createdAt: 'c' });
    expect(calls).toHaveLength(2);
  });

  it('update rebuilds each index on its own, so a later write to one leaves the other rebuilt', async () => {
    const twoIndexes = db.collection<{
      userId: string;
      id: string;
      a?: string;
      b?: string;
      c?: string;
      d?: string;
    }>('pairs', {
      partition: 'userId',
      sort: 'id',
      indexes: {
        byA: { slot: 1, partition: 'a', sort: 'b' },
        byC: { slot: 3, partition: 'c', sort: 'd' },
      },
    });
    const stored = { pk: 'pairs#u1', sk: 'p1', userId: 'u1', id: 'p1', a: 'a2', b: 'b1', c: 'c2', d: 'd1' };
    // A later write changed `a` (and so rebuilt byA) between the two calls.
    respond = (_, input) => {
      const names = (input.ExpressionAttributeNames ?? {}) as Record<string, string>;
      if (names['#c0'] === 'a') throw failure('ConditionalCheckFailedException');
      return { Attributes: stored };
    };
    const out = await twoIndexes.update({ userId: 'u1', id: 'p1' }, { a: 'a2', c: 'c2' });
    expect(out).toEqual({ userId: 'u1', id: 'p1', a: 'a2', b: 'b1', c: 'c2', d: 'd1' });
    expect(calls).toHaveLength(3);
    expect(calls[2]!.input).toMatchObject({
      UpdateExpression: 'SET #f0 = :v0, #f1 = :v1',
      ExpressionAttributeNames: { '#f0': 'gsi3pk', '#f1': 'gsi3sk', '#c0': 'c', '#c1': 'd' },
      ExpressionAttributeValues: { ':v0': 'pairs#byC#c2', ':v1': 'd1', ':c0': 'c2', ':c1': 'd1' },
      ConditionExpression: 'attribute_exists(#pk) AND #c0 = :c0 AND #c1 = :c1',
    });
  });

  it('single writes retry a conflict with a transaction in flight, and nothing else', async () => {
    let failures = [failure('TransactionConflictException'), failure('TransactionConflictException')];
    respond = () => {
      const f = failures.shift();
      if (f) throw f;
      return {};
    };
    await todos().put({ userId: 'u1', id: 't1', title: 'x' });
    expect(calls.map((c) => c.name)).toEqual(['PutCommand', 'PutCommand', 'PutCommand']);

    calls.length = 0;
    failures = [failure('ValidationException')];
    await expect(todos().delete({ userId: 'u1', id: 't1' })).rejects.toMatchObject({
      name: 'ValidationException',
    });
    expect(calls).toHaveLength(1);
  });

  it('Db.transact fails with the writes whose condition failed; anything else is a defect', async () => {
    const Note = Schema.Struct({ id: Schema.String, title: Schema.String });
    const transact = (error: Error) => {
      respond = () => {
        throw error;
      };
      return Effect.runPromiseExit(
        Effect.gen(function* () {
          const notes = (yield* Db).collection('notes', { schema: Note, partition: 'id' });
          yield* (yield* Db).transact([
            notes.tx.put({ id: 'a', title: 'a' }),
            notes.tx.insert({ id: 'b', title: 'b' }),
          ]);
        }).pipe(Effect.provide(Db.layer)),
      );
    };
    expect(await transact(canceled('None', 'ConditionalCheckFailed'))).toEqual(
      Exit.fail(new TransactionCanceled({ failed: [1] })),
    );
    const defect = await transact(failure('ValidationException'));
    expect(Exit.hasDies(defect)).toBe(true);
    expect(Cause.squash((defect as Exit.Failure<void, unknown>).cause)).toMatchObject({
      name: 'ValidationException',
    });
  });
});
