import { ResourceNotFoundException } from '@aws-sdk/client-dynamodb';
import type { S3Client } from '@aws-sdk/client-s3';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { assert, describe, it } from '@effect/vitest';
import { Effect, Exit, Layer } from 'effect';
import { DataBrowser } from '../src/data.ts';
import { awsLayer, settingsLayer } from './support.ts';

type Command = { readonly input: Record<string, unknown> };

/** The data browser over a DynamoDB client that answers with `send`. */
const browser = (send: (command: Command) => Promise<unknown>) => {
  const sent: Command[] = [];
  const ddb = {
    send: (command: Command) => {
      sent.push(command);
      return send(command);
    },
  } as unknown as DynamoDBDocumentClient;
  const layer = DataBrowser.layer.pipe(Layer.provide([awsLayer({ ddb: () => ddb }), settingsLayer()]));
  return {
    sent,
    use: <A, E>(f: (data: DataBrowser['Service']) => Effect.Effect<A, E>) =>
      Effect.provide(DataBrowser.use(f), layer),
  };
};

const noTable = () =>
  Promise.reject(new ResourceNotFoundException({ message: 'Requested resource not found', $metadata: {} }));

/** The data browser over an S3 client that answers with `send`. */
const files = (send: (command: Command) => Promise<unknown>) => {
  const sent: Command[] = [];
  const s3 = {
    send: (command: Command) => {
      sent.push(command);
      return send(command);
    },
  } as unknown as S3Client;
  const layer = DataBrowser.layer.pipe(Layer.provide([awsLayer({ s3: () => s3 }), settingsLayer()]));
  return {
    sent,
    use: <A, E>(f: (data: DataBrowser['Service']) => Effect.Effect<A, E>) =>
      Effect.provide(DataBrowser.use(f), layer),
  };
};

describe('data browser', () => {
  it.effect('lists a public store’s files under the public prefix', () =>
    Effect.gen(function* () {
      const { sent, use } = files(async () => ({
        Contents: [{ Key: '_public/atlas/prod/snapshots/fires/a.json', Size: 3 }],
      }));
      const listing = yield* use((d) =>
        d.storage({ app: 'atlas', stage: 'prod', store: 'snapshots', public: true, prefix: 'fires/' }),
      );
      assert.deepStrictEqual(listing, { objects: [{ key: 'fires/a.json', size: 3 }] });
      assert.strictEqual(sent[0]?.input.Prefix, '_public/atlas/prod/snapshots/fires/');
      yield* use((d) => d.storage({ app: 'atlas', stage: 'prod', store: 'uploads', public: false }));
      assert.strictEqual(sent[1]?.input.Prefix, 'atlas/prod/uploads/');
    }),
  );

  it.effect('reports a stage without a table as having no database', () =>
    Effect.gen(function* () {
      const { sent, use } = browser(noTable);
      assert.deepStrictEqual(yield* use((d) => d.collections('todo', 'prod')), {
        database: false,
        collections: [],
      });
      assert.strictEqual(sent[0]?.input.TableName, 'todo--prod');
    }),
  );

  it.effect('answers 404 for items on a stage without a table', () =>
    Effect.gen(function* () {
      const { use } = browser(noTable);
      for (const partition of [undefined, 'userId=1']) {
        const error = yield* Effect.flip(
          use((d) => d.items({ app: 'todo', stage: 'pr-3', collection: 'todos', partition })),
        );
        assert.strictEqual(error._tag, 'NotFound');
        assert.strictEqual(error.code, 'not_found');
        assert.include(error.message, 'todo/pr-3 has no database');
      }
    }),
  );

  it.effect('answers 400 for a cursor it did not issue', () =>
    Effect.gen(function* () {
      const { use } = browser(async () => ({ Items: [] }));
      const error = yield* Effect.flip(
        use((d) => d.items({ app: 'todo', stage: 'prod', collection: 'todos', cursor: '!!' })),
      );
      assert.deepStrictEqual([error._tag, error.message], ['BadRequest', 'invalid cursor']);
    }),
  );

  it.effect('treats other DynamoDB failures as defects', () =>
    Effect.gen(function* () {
      const { use } = browser(() =>
        Promise.reject(Object.assign(new Error('denied'), { name: 'AccessDeniedException' })),
      );
      const exit = yield* Effect.exit(use((d) => d.collections('todo', 'prod')));
      assert.isTrue(Exit.isFailure(exit) && Exit.hasDies(exit));
    }),
  );

  it.effect('counts collections across scan pages, leaving rate-limit counters out', () =>
    Effect.gen(function* () {
      const { sent, use } = browser(async (cmd) =>
        cmd.input.ExclusiveStartKey
          ? { Items: [{ _c: 'todos' }, {}], ScannedCount: 2 }
          : { Items: [{ _c: 'users' }, { _c: 'todos' }], ScannedCount: 2, LastEvaluatedKey: { pk: 'x' } },
      );
      assert.deepStrictEqual(yield* use((d) => d.collections('todo', 'prod')), {
        database: true,
        collections: [
          { name: '(untyped)', sampled: 1 },
          { name: 'todos', sampled: 2 },
          { name: 'users', sampled: 1 },
        ],
      });
      assert.deepStrictEqual(sent[0]?.input, {
        TableName: 'todo--prod',
        ProjectionExpression: '#c',
        FilterExpression: 'NOT begins_with(#pk, :rl)',
        ExpressionAttributeNames: { '#c': '_c', '#pk': 'pk' },
        ExpressionAttributeValues: { ':rl': '_rl#' },
        ExclusiveStartKey: undefined,
        Limit: 1000,
      });
    }),
  );

  it.effect('pages items without internal attributes, keeping their key', () =>
    Effect.gen(function* () {
      const { sent, use } = browser(async () => ({
        Items: [{ pk: 'todos#u1', sk: '1', gsi1pk: 'x', _c: 'todos', title: 'milk' }],
        LastEvaluatedKey: { pk: 'todos#u1', sk: '1' },
      }));
      const page = yield* use((d) =>
        d.items({ app: 'todo', stage: 'prod', collection: 'todos', partition: 'u1' }),
      );
      assert.deepStrictEqual(page.items, [{ title: 'milk', _key: { pk: 'todos#u1', sk: '1' } }]);
      assert.isString(page.cursor);
      yield* use((d) => d.items({ app: 'todo', stage: 'prod', collection: 'todos', cursor: page.cursor }));
      assert.deepStrictEqual(sent[1]?.input.ExclusiveStartKey, { pk: 'todos#u1', sk: '1' });
    }),
  );
});
