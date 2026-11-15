/**
 * Read-only data browser over an app stage's table and storage prefix.
 *
 * Assumes the SDK's single-table layout: every item has `_c` (collection
 * name) and `pk = <collection>#<partition values>`; internal key attributes
 * are `pk`, `sk`, `gsi{1,2,3}pk`, `gsi{1,2,3}sk`.
 */
import { GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { type DataCollections, type DataPage, names } from '@ericminassian/platform-core';
import { aws } from './aws.ts';
import { getRuntimeConfig } from './config.ts';
import { ApiError } from './errors.ts';

const INTERNAL = new Set(['pk', 'sk', 'gsi1pk', 'gsi1sk', 'gsi2pk', 'gsi2sk', 'gsi3pk', 'gsi3sk', '_c']);

export function cleanItem(item: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(item)) if (!INTERNAL.has(k)) out[k] = v;
  out._key = { pk: item.pk, sk: item.sk };
  return out;
}

/**
 * A stage has no table when its app has `db` off or it was never deployed.
 * Callers say what to answer instead of surfacing DynamoDB's not-found as a 500.
 */
async function withTable<T>(read: () => Promise<T>, ifNoTable: () => T): Promise<T> {
  try {
    return await read();
  } catch (err) {
    if ((err as { name?: string }).name === 'ResourceNotFoundException') return ifNoTable();
    throw err;
  }
}

const encode = (k: Record<string, unknown> | undefined) =>
  k ? Buffer.from(JSON.stringify(k)).toString('base64url') : undefined;
const decode = (c: string | undefined) =>
  c ? (JSON.parse(Buffer.from(c, 'base64url').toString()) as Record<string, unknown>) : undefined;

/** Distinct collection names with approximate counts (from a bounded scan sample). */
export async function listCollections(app: string, stage: string): Promise<DataCollections> {
  return withTable<DataCollections>(
    async () => {
      const counts = new Map<string, number>();
      let ExclusiveStartKey: Record<string, unknown> | undefined;
      let scanned = 0;
      do {
        const res = await aws.ddb().send(
          new ScanCommand({
            TableName: names.table(app, stage),
            ProjectionExpression: '#c',
            ExpressionAttributeNames: { '#c': '_c' },
            ExclusiveStartKey,
            Limit: 1000,
          }),
        );
        for (const i of res.Items ?? []) {
          const c = typeof i._c === 'string' ? i._c : '(untyped)';
          counts.set(c, (counts.get(c) ?? 0) + 1);
        }
        scanned += res.ScannedCount ?? 0;
        ExclusiveStartKey = res.LastEvaluatedKey;
      } while (ExclusiveStartKey && scanned < 5000);
      const collections = [...counts]
        .map(([name, sampled]) => ({ name, sampled }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return { database: true, collections };
    },
    () => ({ database: false, collections: [] }),
  );
}

export async function listItems(opts: {
  app: string;
  stage: string;
  collection: string;
  partition?: string;
  cursor?: string;
  limit?: number;
}): Promise<DataPage> {
  const TableName = names.table(opts.app, opts.stage);
  const Limit = Math.min(opts.limit ?? 50, 200);
  const ExclusiveStartKey = decode(opts.cursor);
  return withTable<DataPage>(
    async () => {
      const res = opts.partition
        ? await aws.ddb().send(
            new QueryCommand({
              TableName,
              KeyConditionExpression: 'pk = :pk',
              ExpressionAttributeValues: { ':pk': `${opts.collection}#${opts.partition}` },
              Limit,
              ExclusiveStartKey,
            }),
          )
        : await aws.ddb().send(
            new ScanCommand({
              TableName,
              FilterExpression: '#c = :c',
              ExpressionAttributeNames: { '#c': '_c' },
              ExpressionAttributeValues: { ':c': opts.collection },
              Limit,
              ExclusiveStartKey,
            }),
          );
      const cursor = encode(res.LastEvaluatedKey);
      return {
        items: (res.Items ?? []).map((i) => cleanItem(i as Record<string, unknown>)),
        ...(cursor ? { cursor } : {}),
      };
    },
    () => {
      throw new ApiError(
        404,
        'not_found',
        `${opts.app}/${opts.stage} has no database; set db: true in plat.config.ts and deploy`,
      );
    },
  );
}

export async function listStorage(opts: {
  app: string;
  stage: string;
  store: string;
  prefix?: string;
  cursor?: string;
}): Promise<{ objects: Array<{ key: string; size: number; lastModified?: string }>; cursor?: string }> {
  const { storageBucket } = await getRuntimeConfig();
  const base = names.storagePrefix(opts.app, opts.stage, opts.store);
  const res = await aws.s3().send(
    new ListObjectsV2Command({
      Bucket: storageBucket,
      Prefix: base + (opts.prefix ?? ''),
      MaxKeys: 200,
      ...(opts.cursor ? { ContinuationToken: opts.cursor } : {}),
    }),
  );
  return {
    objects: (res.Contents ?? []).map((o) => ({
      key: (o.Key ?? '').slice(base.length),
      size: o.Size ?? 0,
      ...(o.LastModified ? { lastModified: o.LastModified.toISOString() } : {}),
    })),
    ...(res.NextContinuationToken ? { cursor: res.NextContinuationToken } : {}),
  };
}

export async function storageDownloadUrl(opts: {
  app: string;
  stage: string;
  store: string;
  key: string;
}): Promise<string> {
  const { storageBucket } = await getRuntimeConfig();
  if (opts.key.includes('..')) throw new Error('invalid key');
  return getSignedUrl(
    aws.s3(),
    new GetObjectCommand({
      Bucket: storageBucket,
      Key: names.storagePrefix(opts.app, opts.stage, opts.store) + opts.key,
    }),
    { expiresIn: 300 },
  );
}
