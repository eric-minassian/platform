import { ResourceNotFoundException } from '@aws-sdk/client-dynamodb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { aws } from '../src/aws.ts';
import { listCollections, listItems } from '../src/data.ts';

function stubDdb(send: (cmd: { input: Record<string, unknown> }) => Promise<unknown>) {
  const fn = vi.fn(send);
  vi.spyOn(aws, 'ddb').mockReturnValue({ send: fn } as unknown as ReturnType<typeof aws.ddb>);
  return fn;
}

const noTable = () =>
  Promise.reject(new ResourceNotFoundException({ message: 'Requested resource not found', $metadata: {} }));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('data browser', () => {
  it('shows a stage without a table as an empty database', async () => {
    const send = stubDdb(noTable);
    expect(await listCollections('todo', 'prod')).toEqual([]);
    expect(await listItems({ app: 'todo', stage: 'prod', collection: 'todos' })).toEqual({ items: [] });
    expect(
      await listItems({ app: 'todo', stage: 'prod', collection: 'todos', partition: 'userId=1' }),
    ).toEqual({ items: [] });
    expect(send.mock.calls.map(([cmd]) => cmd.input.TableName)).toEqual([
      'todo--prod',
      'todo--prod',
      'todo--prod',
    ]);
  });

  it('still fails on other errors', async () => {
    stubDdb(() => Promise.reject(Object.assign(new Error('denied'), { name: 'AccessDeniedException' })));
    await expect(listCollections('todo', 'prod')).rejects.toThrow('denied');
    await expect(listItems({ app: 'todo', stage: 'prod', collection: 'todos' })).rejects.toThrow('denied');
  });

  it('counts collections across scan pages', async () => {
    stubDdb(async (cmd) =>
      cmd.input.ExclusiveStartKey
        ? { Items: [{ _c: 'todos' }, {}], ScannedCount: 2 }
        : { Items: [{ _c: 'users' }, { _c: 'todos' }], ScannedCount: 2, LastEvaluatedKey: { pk: 'x' } },
    );
    expect(await listCollections('todo', 'prod')).toEqual([
      { name: '(untyped)', sampled: 1 },
      { name: 'todos', sampled: 2 },
      { name: 'users', sampled: 1 },
    ]);
  });
});
