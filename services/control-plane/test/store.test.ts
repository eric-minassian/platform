import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { assert, describe, it } from '@effect/vitest';
import { Effect, Exit, Layer, Option } from 'effect';
import { appItem, stageItem } from '../src/records.ts';
import { Store } from '../src/store.ts';
import { awsLayer, settingsLayer } from './support.ts';

type Command = { readonly constructor: { readonly name: string }; readonly input: Record<string, unknown> };

/** The store over a DynamoDB client that answers with `send`. */
const store = (send: (command: Command) => unknown) => {
  const sent: Command[] = [];
  const ddb = {
    send: async (command: Command) => {
      sent.push(command);
      return send(command);
    },
  } as unknown as DynamoDBDocumentClient;
  const layer = Store.layer.pipe(Layer.provide([awsLayer({ ddb: () => ddb }), settingsLayer()]));
  return {
    sent,
    use: <A, E>(f: (s: Store['Service']) => Effect.Effect<A, E>) => Effect.provide(Store.use(f), layer),
  };
};

const conditionFailed = () => {
  throw new ConditionalCheckFailedException({ message: 'The conditional request failed', $metadata: {} });
};

const app = {
  name: 'shop',
  repo: 'bob/shop',
  owners: ['bob'],
  createdBy: 'bob',
  createdAt: '2026-11-01T00:00:00Z',
};

describe('Store', () => {
  it.effect('decodes items without their keys', () =>
    Effect.gen(function* () {
      const { use } = store(() => ({ Item: appItem(app) }));
      assert.deepStrictEqual(yield* use((s) => s.getApp('shop')), Option.some(app));
    }),
  );

  it.effect('reads older stage items that predate the uptime fields', () =>
    Effect.gen(function* () {
      const stage = {
        app: 'shop',
        stage: 'prod',
        host: 'shop.example.com',
        url: 'https://shop.example.com',
        status: 'active' as const,
        preview: false,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      };
      const { use } = store(() => ({ Items: [stageItem(stage)] }));
      assert.deepStrictEqual(yield* use((s) => s.listStages('shop')), [stage]);
    }),
  );

  it.effect('treats a malformed item as a defect', () =>
    Effect.gen(function* () {
      const { use } = store(() => ({ Item: { pk: 'APP#shop', sk: 'META', name: 'shop' } }));
      const exit = yield* Effect.exit(use((s) => s.getApp('shop')));
      assert.isTrue(Exit.hasDies(exit));
    }),
  );

  it.effect('refuses to register an app twice', () =>
    Effect.gen(function* () {
      const { sent, use } = store(conditionFailed);
      const error = yield* Effect.flip(use((s) => s.createApp(app)));
      assert.strictEqual(error._tag, 'AlreadyExists');
      assert.strictEqual(sent[0]?.input.ConditionExpression, 'attribute_not_exists(pk)');
    }),
  );

  it.effect('applies a status change only from the expected status', () =>
    Effect.gen(function* () {
      const applied = store(() => ({}));
      assert.isTrue(
        yield* applied.use((s) => s.updateDeployment('shop', 'd1', { status: 'running' }, 'queued')),
      );
      assert.deepStrictEqual(applied.sent[0]?.input, {
        TableName: 'platform',
        Key: { pk: 'APP#shop', sk: 'DEP#d1' },
        UpdateExpression: 'SET #k0 = :v0',
        ExpressionAttributeNames: { '#k0': 'status', '#status': 'status' },
        ExpressionAttributeValues: { ':v0': 'running', ':ifStatus': 'queued' },
        ConditionExpression: '#status = :ifStatus',
      });
      const raced = store(conditionFailed);
      assert.isFalse(
        yield* raced.use((s) => s.updateDeployment('shop', 'd1', { status: 'running' }, 'queued')),
      );
    }),
  );

  it.effect('removes attributes patched to undefined and stamps the stage', () =>
    Effect.gen(function* () {
      const { sent, use } = store((cmd) => ({
        Attributes: stageItem({
          app: 'shop',
          stage: 'prod',
          host: 'h',
          url: 'u',
          status: 'destroyed',
          preview: false,
          createdAt: 'c',
          updatedAt: String((cmd.input.ExpressionAttributeValues as Record<string, unknown>)[':v2']),
        }),
      }));
      const stage = yield* use((s) =>
        s.updateStage('shop', 'prod', { status: 'destroyed', route: undefined }),
      );
      assert.strictEqual(sent[0]?.input.UpdateExpression, 'SET #k0 = :v0, #k2 = :v2 REMOVE #k1');
      assert.deepStrictEqual(sent[0]?.input.ExpressionAttributeNames, {
        '#k0': 'status',
        '#k1': 'route',
        '#k2': 'updatedAt',
      });
      assert.strictEqual(stage.status, 'destroyed');
    }),
  );
});
