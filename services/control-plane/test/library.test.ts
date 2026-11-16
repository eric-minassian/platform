import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { assert, describe, it } from '@effect/vitest';
import type { Dashboard, SavedQuery } from '@ericminassian/platform-core';
import { Effect, Layer, Option } from 'effect';
import { Library } from '../src/library.ts';
import { dashboardItem, savedQueryItem } from '../src/records.ts';
import { awsLayer, settingsLayer } from './support.ts';

type Command = { readonly constructor: { readonly name: string }; readonly input: Record<string, unknown> };

/** The library over a DynamoDB client that answers with `send`. */
const library = (send: (command: Command) => unknown) => {
  const sent: Command[] = [];
  const ddb = {
    send: async (command: Command) => {
      sent.push(command);
      return send(command);
    },
  } as unknown as DynamoDBDocumentClient;
  const layer = Library.layer.pipe(Layer.provide([awsLayer({ ddb: () => ddb }), settingsLayer()]));
  return {
    sent,
    use: <A, E>(f: (l: Library['Service']) => Effect.Effect<A, E>) => Effect.provide(Library.use(f), layer),
  };
};

const at = '2026-11-16T00:00:00.000Z';
const query: SavedQuery = {
  id: 'q1',
  app: 'shop',
  name: 'errors',
  view: { kind: 'logs', filters: { levels: ['error'] } },
  createdBy: 'bob',
  createdAt: at,
  updatedAt: at,
};
const dashboard: Dashboard = {
  id: 'db1',
  name: 'Across',
  widgets: [],
  createdBy: 'bob',
  createdAt: at,
  updatedAt: at,
  updatedBy: 'bob',
};

describe('Library', () => {
  it.effect('keeps saved queries under their app and dashboards on their own', () =>
    Effect.gen(function* () {
      const { sent, use } = library(() => ({}));
      yield* use((l) =>
        Effect.all([
          l.putQuery(query),
          l.putDashboard(dashboard),
          l.putDashboard({ ...dashboard, id: 'db2', app: 'shop' }),
        ]),
      );
      const items = sent.map((c) => c.input.Item as Record<string, unknown>);
      assert.deepStrictEqual(
        items.map((i) => [i.pk, i.sk, i.gsi1pk, i.gsi1sk]),
        [
          ['APP#shop', 'QUERY#q1', undefined, undefined],
          ['DASHBOARD#db1', 'META', 'DASHBOARDS', '~#db1'],
          ['DASHBOARD#db2', 'META', 'DASHBOARDS', 'shop#db2'],
        ],
      );
    }),
  );

  it.effect('reads an app’s dashboards and the cross-app ones in one Query', () =>
    Effect.gen(function* () {
      const { sent, use } = library(() => ({
        Items: [dashboardItem({ ...dashboard, app: 'shop' }), dashboardItem(dashboard)],
      }));
      const found = yield* use((l) => l.listDashboards('shop'));
      assert.deepStrictEqual(found, [{ ...dashboard, app: 'shop' }, dashboard]);
      assert.strictEqual(sent.length, 1);
      assert.deepStrictEqual(sent[0]?.input, {
        TableName: 'platform',
        IndexName: 'gsi1',
        KeyConditionExpression: 'gsi1pk = :p AND gsi1sk BETWEEN :from AND :to',
        FilterExpression: '#app = :app OR attribute_not_exists(#app)',
        ExpressionAttributeNames: { '#app': 'app' },
        ExpressionAttributeValues: { ':p': 'DASHBOARDS', ':from': 'shop#', ':to': '~#￿', ':app': 'shop' },
        ExclusiveStartKey: undefined,
      });
    }),
  );

  it.effect('decodes items without their keys', () =>
    Effect.gen(function* () {
      const { use } = library(() => ({ Item: savedQueryItem(query) }));
      assert.deepStrictEqual(yield* use((l) => l.getQuery('shop', 'q1')), Option.some(query));
    }),
  );

  it.effect('deletes an app’s saved queries and dashboards, and nothing else', () =>
    Effect.gen(function* () {
      const { sent, use } = library((command) => {
        if (command.constructor.name !== 'QueryCommand') return {};
        return command.input.IndexName
          ? { Items: [dashboardItem({ ...dashboard, id: 'db2', app: 'shop' })] }
          : { Items: [savedQueryItem(query)] };
      });
      yield* use((l) => l.removeApp('shop'));
      const dashboardQuery = sent.find((c) => c.input.IndexName === 'gsi1');
      assert.deepStrictEqual(dashboardQuery?.input.ExpressionAttributeValues, {
        ':p': 'DASHBOARDS',
        ':s': 'shop#',
      });
      assert.deepStrictEqual(
        sent.filter((c) => c.constructor.name === 'DeleteCommand').map((c) => c.input.Key),
        [
          { pk: 'APP#shop', sk: 'QUERY#q1' },
          { pk: 'DASHBOARD#db2', sk: 'META' },
        ],
      );
    }),
  );
});
