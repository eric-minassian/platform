/**
 * Control plane state in the `platform` table (single-table design). The item
 * layout lives in records.ts, which the foundation also uses.
 */
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { AppRecord, DeploymentEventEntry, DeploymentRecord } from '@ericminassian/platform-core';
import { aws } from './aws.ts';
import { getRuntimeConfig } from './config.ts';
import {
  appItem,
  appKey,
  type DeploymentItem,
  deploymentItem,
  deploymentKey,
  type StageItem,
  stageItem,
  stageKey,
} from './records.ts';

export type { DeploymentItem, StageItem } from './records.ts';

const MAX_EVENTS = 500;

async function table(): Promise<string> {
  return (await getRuntimeConfig()).stateTable;
}

function strip<T>(item: Record<string, unknown> | undefined): T | undefined {
  if (!item) return undefined;
  const { pk: _pk, sk: _sk, gsi1pk: _g1, gsi1sk: _g2, ...rest } = item;
  return rest as T;
}

async function queryAll(
  input: Omit<ConstructorParameters<typeof QueryCommand>[0], 'TableName' | 'ExclusiveStartKey'>,
  limit = Number.POSITIVE_INFINITY,
): Promise<Record<string, unknown>[]> {
  const TableName = await table();
  const items: Record<string, unknown>[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const res = await aws.ddb().send(new QueryCommand({ ...input, TableName, ExclusiveStartKey }));
    items.push(...((res.Items ?? []) as Record<string, unknown>[]));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey && items.length < limit);
  return items.slice(0, limit);
}

/** Builds `SET #k0 = :v0, ...` for a partial update. */
function setExpression(patch: Record<string, unknown>) {
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const sets: string[] = [];
  const removes: string[] = [];
  Object.entries(patch).forEach(([k, v], i) => {
    names[`#k${i}`] = k;
    if (v === undefined) removes.push(`#k${i}`);
    else {
      values[`:v${i}`] = v;
      sets.push(`#k${i} = :v${i}`);
    }
  });
  const expr = [
    sets.length ? `SET ${sets.join(', ')}` : '',
    removes.length ? `REMOVE ${removes.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join(' ');
  return { expr, names, values };
}

// ------------------------------------------------------------------ apps

export async function getApp(name: string): Promise<AppRecord | undefined> {
  const res = await aws.ddb().send(new GetCommand({ TableName: await table(), Key: appKey(name) }));
  return strip<AppRecord>(res.Item);
}

export async function listApps(): Promise<AppRecord[]> {
  const items = await queryAll({
    IndexName: 'gsi1',
    KeyConditionExpression: 'gsi1pk = :p',
    ExpressionAttributeValues: { ':p': 'APPS' },
  });
  return items.map((i) => strip<AppRecord>(i)!);
}

/** Fails with ConditionalCheckFailedException if the app exists. */
export async function createApp(app: AppRecord): Promise<void> {
  await aws.ddb().send(
    new PutCommand({
      TableName: await table(),
      Item: appItem(app),
      ConditionExpression: 'attribute_not_exists(pk)',
    }),
  );
}

export async function updateApp(name: string, patch: Partial<AppRecord>): Promise<AppRecord> {
  const { expr, names, values } = setExpression(patch);
  const res = await aws.ddb().send(
    new UpdateCommand({
      TableName: await table(),
      Key: appKey(name),
      UpdateExpression: expr,
      ExpressionAttributeNames: names,
      ...(Object.keys(values).length ? { ExpressionAttributeValues: values } : {}),
      ConditionExpression: 'attribute_exists(pk)',
      ReturnValues: 'ALL_NEW',
    }),
  );
  return strip<AppRecord>(res.Attributes)!;
}

export async function deleteApp(name: string): Promise<void> {
  await aws.ddb().send(new DeleteCommand({ TableName: await table(), Key: appKey(name) }));
}

// ------------------------------------------------------------------ stages

export async function getStage(app: string, stage: string): Promise<StageItem | undefined> {
  const res = await aws.ddb().send(new GetCommand({ TableName: await table(), Key: stageKey(app, stage) }));
  return strip<StageItem>(res.Item);
}

export async function listStages(app: string): Promise<StageItem[]> {
  const items = await queryAll({
    KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)',
    ExpressionAttributeValues: { ':p': `APP#${app}`, ':s': 'STAGE#' },
  });
  return items.map((i) => strip<StageItem>(i)!);
}

export async function listAllStages(): Promise<StageItem[]> {
  const items = await queryAll({
    IndexName: 'gsi1',
    KeyConditionExpression: 'gsi1pk = :p',
    ExpressionAttributeValues: { ':p': 'STAGES' },
  });
  return items.map((i) => strip<StageItem>(i)!);
}

export async function putStage(stage: StageItem): Promise<void> {
  await aws.ddb().send(
    new PutCommand({
      TableName: await table(),
      Item: stageItem(stage),
    }),
  );
}

export async function updateStage(app: string, stage: string, patch: Partial<StageItem>): Promise<StageItem> {
  const { expr, names, values } = setExpression({ ...patch, updatedAt: new Date().toISOString() });
  const res = await aws.ddb().send(
    new UpdateCommand({
      TableName: await table(),
      Key: stageKey(app, stage),
      UpdateExpression: expr,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ReturnValues: 'ALL_NEW',
    }),
  );
  return strip<StageItem>(res.Attributes)!;
}

// ------------------------------------------------------------------ deployments

export async function createDeployment(dep: DeploymentItem): Promise<void> {
  await aws.ddb().send(
    new PutCommand({
      TableName: await table(),
      Item: deploymentItem(dep),
      ConditionExpression: 'attribute_not_exists(pk)',
    }),
  );
}

export async function getDeployment(id: string): Promise<DeploymentItem | undefined> {
  const [item] = await queryAll(
    {
      IndexName: 'gsi1',
      KeyConditionExpression: 'gsi1pk = :p AND gsi1sk = :s',
      ExpressionAttributeValues: { ':p': `DEP#${id}`, ':s': 'DEP' },
    },
    1,
  );
  if (!item) return undefined;
  // GSI reads are eventually consistent; re-read from the base table for the latest status.
  const res = await aws
    .ddb()
    .send(
      new GetCommand({ TableName: await table(), Key: { pk: item.pk, sk: item.sk }, ConsistentRead: true }),
    );
  return strip<DeploymentItem>(res.Item);
}

export async function listDeployments(app: string, limit = 50): Promise<DeploymentItem[]> {
  const items = await queryAll(
    {
      KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)',
      ExpressionAttributeValues: { ':p': `APP#${app}`, ':s': 'DEP#' },
      ScanIndexForward: false,
      Limit: limit,
    },
    limit,
  );
  return items.map((i) => strip<DeploymentItem>(i)!);
}

/**
 * Partial update. With `ifStatus`, only applies when the current status matches
 * (returns false otherwise) — used to make the deploy job idempotent under retries.
 */
export async function updateDeployment(
  app: string,
  id: string,
  patch: Partial<DeploymentItem>,
  ifStatus?: DeploymentRecord['status'],
): Promise<boolean> {
  const { expr, names, values } = setExpression(patch);
  try {
    await aws.ddb().send(
      new UpdateCommand({
        TableName: await table(),
        Key: deploymentKey(app, id),
        UpdateExpression: expr,
        ExpressionAttributeNames: { ...names, ...(ifStatus ? { '#status': 'status' } : {}) },
        ExpressionAttributeValues: { ...values, ...(ifStatus ? { ':ifStatus': ifStatus } : {}) },
        ConditionExpression: ifStatus ? '#status = :ifStatus' : 'attribute_exists(pk)',
      }),
    );
    return true;
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}

export async function appendDeploymentEvents(
  app: string,
  id: string,
  events: DeploymentEventEntry[],
): Promise<void> {
  if (events.length === 0) return;
  await aws
    .ddb()
    .send(
      new UpdateCommand({
        TableName: await table(),
        Key: deploymentKey(app, id),
        UpdateExpression: 'SET #e = list_append(if_not_exists(#e, :empty), :events)',
        ConditionExpression: 'size(#e) < :max OR attribute_not_exists(#e)',
        ExpressionAttributeNames: { '#e': 'events' },
        ExpressionAttributeValues: { ':empty': [], ':events': events, ':max': MAX_EVENTS },
      }),
    )
    .catch((err: { name?: string }) => {
      if (err.name !== 'ConditionalCheckFailedException') throw err;
    });
}
