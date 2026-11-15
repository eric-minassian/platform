import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newContext, runWithContext } from '../src/runtime/context.ts';
import { InvalidCursorError } from '../src/runtime/cursor.ts';
import { createKeyMapper, db, setExpression, stripInternal } from '../src/runtime/db.ts';
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

  it('update recomputes index attributes when their sources change', async () => {
    const out = await todos().update({ userId: 'u1', id: 't1' }, { title: 'new', status: 'done' });
    expect(out).toEqual({ userId: 'u1', id: 't1', title: 'new', status: 'done', createdAt: 'c' });
    expect(sent).toHaveLength(2);
    expect(sent[0]!.input).toMatchObject({
      ConditionExpression: 'attribute_exists(#pk)',
      ReturnValues: 'ALL_NEW',
    });
    expect(sent[1]!.input.ExpressionAttributeValues).toMatchObject({
      ':v0': 'todos#byStatus#u1#done',
      ':v1': 'c',
    });
  });

  it('update without index sources is a single call; changing keys is rejected', async () => {
    await todos().update({ userId: 'u1', id: 't1' }, { title: 'only' });
    expect(sent).toHaveLength(1);
    await expect(todos().update({ userId: 'u1', id: 't1' }, { id: 'other' })).rejects.toThrow(
      /cannot change key/,
    );
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

    // Limit and order may change between pages; the key condition may not.
    await todos().query({ userId: 'u1' }, { beginsWith: 't', limit: 10, reverse: true, cursor });
    expect(queries[0]).toMatchObject({ ExclusiveStartKey: lastKey, Limit: 10, ScanIndexForward: false });
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
      todos().queryAll({ userId: 'u1' }, { reverse: true }),
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
    expect(queries.every((q) => q.ScanIndexForward === false && !('Limit' in q))).toBe(true);
    expect(tel.events.filter((e) => e.t === 'span').map((e) => (e as { op: string }).op)).toEqual([
      'db.query',
      'db.query',
      'db.query',
      'db.query',
    ]);
  });
});
