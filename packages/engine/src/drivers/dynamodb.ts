import {
  type AttributeDefinition,
  CreateTableCommand,
  DeleteTableCommand,
  DescribeContinuousBackupsCommand,
  DescribeTableCommand,
  DescribeTimeToLiveCommand,
  type GlobalSecondaryIndex,
  TagResourceCommand,
  UpdateContinuousBackupsCommand,
  UpdateTableCommand,
  UpdateTimeToLiveCommand,
} from '@aws-sdk/client-dynamodb';
import { type EngineContext, ignoreNotFound, tagList, waitFor } from '../util.ts';

export interface TableSpec {
  name: string;
  /** Partition/sort key attribute names (all strings). */
  pk: string;
  sk?: string;
  /** GSIs as `[indexName, pkAttr, skAttr?]` (string attributes, projection ALL). */
  gsis?: Array<[string, string, string?]>;
  ttlAttribute?: string;
  pointInTimeRecovery?: boolean;
  deletionProtection?: boolean;
  tags?: Record<string, string>;
}

export interface TableState {
  name: string;
  arn: string;
  created: boolean;
}

/** The per-stage table: `pk`/`sk`, three generic GSIs and TTL on `_ttl`. */
export function stageTableSpec(
  name: string,
  opts: { prod: boolean; tags: Record<string, string> },
): TableSpec {
  return {
    name,
    pk: 'pk',
    sk: 'sk',
    gsis: [
      ['gsi1', 'gsi1pk', 'gsi1sk'],
      ['gsi2', 'gsi2pk', 'gsi2sk'],
      ['gsi3', 'gsi3pk', 'gsi3sk'],
    ],
    ttlAttribute: '_ttl',
    pointInTimeRecovery: opts.prod,
    deletionProtection: opts.prod,
    tags: opts.tags,
  };
}

export async function ensureTable(ctx: EngineContext, spec: TableSpec): Promise<TableState> {
  const ddb = ctx.clients.dynamodb;
  const existing = await ignoreNotFound(ddb.send(new DescribeTableCommand({ TableName: spec.name })));
  let created = false;
  let arn = existing?.Table?.TableArn;

  if (!existing?.Table) {
    const attrs = new Map<string, AttributeDefinition>();
    const addAttr = (n: string) => attrs.set(n, { AttributeName: n, AttributeType: 'S' });
    addAttr(spec.pk);
    if (spec.sk) addAttr(spec.sk);
    const gsis: GlobalSecondaryIndex[] = (spec.gsis ?? []).map(([IndexName, pk, sk]) => {
      addAttr(pk);
      if (sk) addAttr(sk);
      return {
        IndexName,
        KeySchema: [
          { AttributeName: pk, KeyType: 'HASH' },
          ...(sk ? [{ AttributeName: sk, KeyType: 'RANGE' as const }] : []),
        ],
        Projection: { ProjectionType: 'ALL' },
      };
    });
    const res = await ddb.send(
      new CreateTableCommand({
        TableName: spec.name,
        BillingMode: 'PAY_PER_REQUEST',
        AttributeDefinitions: [...attrs.values()],
        KeySchema: [
          { AttributeName: spec.pk, KeyType: 'HASH' },
          ...(spec.sk ? [{ AttributeName: spec.sk, KeyType: 'RANGE' as const }] : []),
        ],
        GlobalSecondaryIndexes: gsis.length ? gsis : undefined,
        DeletionProtectionEnabled: spec.deletionProtection ?? false,
        Tags: spec.tags ? tagList(spec.tags) : undefined,
      }),
    );
    arn = res.TableDescription?.TableArn;
    created = true;
    ctx.log('info', 'created table', `table ${spec.name}`);
  }

  await waitActive(ctx, spec.name);

  if (!created && existing?.Table) {
    // Add any missing GSIs (DynamoDB allows one index creation per UpdateTable call).
    const have = new Set((existing.Table.GlobalSecondaryIndexes ?? []).map((g) => g.IndexName));
    for (const [IndexName, pk, sk] of spec.gsis ?? []) {
      if (have.has(IndexName)) continue;
      await ddb.send(
        new UpdateTableCommand({
          TableName: spec.name,
          AttributeDefinitions: [
            { AttributeName: pk, AttributeType: 'S' },
            ...(sk ? [{ AttributeName: sk, AttributeType: 'S' as const }] : []),
          ],
          GlobalSecondaryIndexUpdates: [
            {
              Create: {
                IndexName,
                KeySchema: [
                  { AttributeName: pk, KeyType: 'HASH' },
                  ...(sk ? [{ AttributeName: sk, KeyType: 'RANGE' as const }] : []),
                ],
                Projection: { ProjectionType: 'ALL' },
              },
            },
          ],
        }),
      );
      ctx.log('info', `adding index ${IndexName}`, `table ${spec.name}`);
      await waitActive(ctx, spec.name);
    }
    if (
      spec.deletionProtection !== undefined &&
      existing.Table.DeletionProtectionEnabled !== spec.deletionProtection
    ) {
      await ddb.send(
        new UpdateTableCommand({ TableName: spec.name, DeletionProtectionEnabled: spec.deletionProtection }),
      );
      await waitActive(ctx, spec.name);
    }
    if (spec.tags && arn)
      await ddb.send(new TagResourceCommand({ ResourceArn: arn, Tags: tagList(spec.tags) }));
  }

  if (spec.ttlAttribute) {
    const ttl = await ddb.send(new DescribeTimeToLiveCommand({ TableName: spec.name }));
    const status = ttl.TimeToLiveDescription?.TimeToLiveStatus;
    if (status !== 'ENABLED' && status !== 'ENABLING') {
      await ddb.send(
        new UpdateTimeToLiveCommand({
          TableName: spec.name,
          TimeToLiveSpecification: { Enabled: true, AttributeName: spec.ttlAttribute },
        }),
      );
    }
  }

  if (spec.pointInTimeRecovery !== undefined) {
    const backups = await ddb.send(new DescribeContinuousBackupsCommand({ TableName: spec.name }));
    const enabled =
      backups.ContinuousBackupsDescription?.PointInTimeRecoveryDescription?.PointInTimeRecoveryStatus ===
      'ENABLED';
    if (enabled !== spec.pointInTimeRecovery) {
      await ddb.send(
        new UpdateContinuousBackupsCommand({
          TableName: spec.name,
          PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: spec.pointInTimeRecovery },
        }),
      );
    }
  }

  if (!arn) {
    const d = await ddb.send(new DescribeTableCommand({ TableName: spec.name }));
    arn = d.Table!.TableArn!;
  }
  return { name: spec.name, arn, created };
}

async function waitActive(ctx: EngineContext, name: string): Promise<void> {
  await waitFor(`table ${name} ACTIVE`, async () => {
    const d = await ctx.clients.dynamodb.send(new DescribeTableCommand({ TableName: name }));
    const t = d.Table;
    return (
      t?.TableStatus === 'ACTIVE' && (t.GlobalSecondaryIndexes ?? []).every((g) => g.IndexStatus === 'ACTIVE')
    );
  });
}

export async function describeTable(ctx: EngineContext, name: string) {
  return (await ignoreNotFound(ctx.clients.dynamodb.send(new DescribeTableCommand({ TableName: name }))))
    ?.Table;
}

export async function deleteTable(ctx: EngineContext, name: string): Promise<boolean> {
  const ddb = ctx.clients.dynamodb;
  const t = await describeTable(ctx, name);
  if (!t) return false;
  if (t.DeletionProtectionEnabled) {
    await ddb.send(new UpdateTableCommand({ TableName: name, DeletionProtectionEnabled: false }));
    await waitActive(ctx, name);
  }
  await ignoreNotFound(ddb.send(new DeleteTableCommand({ TableName: name })));
  await waitFor(`table ${name} deleted`, async () => !(await describeTable(ctx, name)), {
    timeoutMs: 120_000,
  });
  ctx.log('info', 'deleted table', `table ${name}`);
  return true;
}
