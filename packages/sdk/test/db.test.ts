import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newContext, runWithContext } from '../src/context.ts';
import { createKeyMapper, db, decodeCursor, encodeCursor, setExpression, stripInternal } from '../src/db.ts';
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

  it('builds queries with sort conditions, index, cursor and order', () => {
    const cursor = encodeCursor({ pk: 'todos#u1', sk: 't5' });
    const q = m.queryInput({ userId: 'u1' }, { beginsWith: 't', limit: 5, cursor, reverse: true }, 'tbl');
    expect(q).toEqual({
      TableName: 'tbl',
      KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :b)',
      ExpressionAttributeNames: { '#pk': 'pk', '#sk': 'sk' },
      ExpressionAttributeValues: { ':pk': 'todos#u1', ':b': 't' },
      ScanIndexForward: false,
      Limit: 5,
      ExclusiveStartKey: { pk: 'todos#u1', sk: 't5' },
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

  it('strips internal attributes and round-trips cursors', () => {
    expect(stripInternal({ pk: 'a', sk: 'b', gsi1pk: 'c', _c: 'x', _ttl: 1, title: 't' })).toEqual({
      title: 't',
    });
    expect(decodeCursor(encodeCursor({ a: 1 }))).toEqual({ a: 1 });
    expect(() => decodeCursor('%%%')).toThrow(/cursor/);
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
      expect(decodeCursor(page.cursor)).toEqual({ pk: 'p', sk: 's' });

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
