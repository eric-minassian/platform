import { ResourceNotFoundException } from '@aws-sdk/client-dynamodb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { aws } from '../src/aws.ts';
import { listCollections, listItems } from '../src/data.ts';
import { ApiError } from '../src/errors.ts';

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
  it('reports a stage without a table as having no database', async () => {
    const send = stubDdb(noTable);
    expect(await listCollections('todo', 'prod')).toEqual({ database: false, collections: [] });
    expect(send.mock.calls[0]?.[0].input.TableName).toBe('todo--prod');
  });

  it('answers 404 for items on a stage without a table', async () => {
    stubDdb(noTable);
    for (const partition of [undefined, 'userId=1']) {
      const err = await listItems({
        app: 'todo',
        stage: 'pr-3',
        collection: 'todos',
        ...(partition ? { partition } : {}),
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect(err).toMatchObject({ status: 404, code: 'not_found' });
      expect((err as ApiError).message).toContain('todo/pr-3 has no database');
    }
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
    expect(await listCollections('todo', 'prod')).toEqual({
      database: true,
      collections: [
        { name: '(untyped)', sampled: 1 },
        { name: 'todos', sampled: 2 },
        { name: 'users', sampled: 1 },
      ],
    });
  });

  it('shows an existing but empty table as an empty database', async () => {
    stubDdb(async () => ({ Items: [], ScannedCount: 0 }));
    expect(await listCollections('todo', 'prod')).toEqual({ database: true, collections: [] });
  });
});
