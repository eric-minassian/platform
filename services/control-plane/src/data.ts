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
import {
  type DataCollections,
  type DataPage,
  names,
  RATE_LIMIT_PK_PREFIX,
  type StoredObjectInfo,
} from '@ericminassian/platform-core';
import { BadRequest, NotFound } from '@ericminassian/platform-core/platform-api';
import { Context, Effect, Layer } from 'effect';
import { Aws, AwsError, tryAws } from './aws.ts';
import { Settings } from './config.ts';

const INTERNAL = new Set(['pk', 'sk', 'gsi1pk', 'gsi1sk', 'gsi2pk', 'gsi2sk', 'gsi3pk', 'gsi3sk', '_c']);

/** An item as the browser shows it: internal attributes dropped, its key kept under `_key`. */
export function cleanItem(item: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(item)) if (!INTERNAL.has(k)) out[k] = v;
  out._key = { pk: item.pk, sk: item.sk };
  return out;
}

const encodeCursor = (k: Record<string, unknown> | undefined) =>
  k ? Buffer.from(JSON.stringify(k)).toString('base64url') : undefined;
const decodeCursor = (c: string | undefined) =>
  c ? (JSON.parse(Buffer.from(c, 'base64url').toString()) as Record<string, unknown>) : undefined;

/**
 * A stage has no table when its app has `db` off or it was never deployed:
 * DynamoDB answers ResourceNotFoundException, which callers turn into an answer.
 */
const noTable = AwsError.is('ResourceNotFoundException');

export interface StorageListing {
  readonly objects: ReadonlyArray<StoredObjectInfo>;
  readonly cursor?: string;
}

export class DataBrowser extends Context.Service<
  DataBrowser,
  {
    /** Distinct collection names with approximate counts (from a bounded scan sample). */
    collections(app: string, stage: string): Effect.Effect<DataCollections>;
    /** A page of one collection, or of one partition of it. */
    items(options: {
      readonly app: string;
      readonly stage: string;
      readonly collection: string;
      readonly partition?: string | undefined;
      readonly cursor?: string | undefined;
      readonly limit?: number | undefined;
    }): Effect.Effect<DataPage, BadRequest | NotFound>;
    storage(options: {
      readonly app: string;
      readonly stage: string;
      readonly store: string;
      readonly prefix?: string | undefined;
      readonly cursor?: string | undefined;
    }): Effect.Effect<StorageListing>;
    /** A presigned GET valid for five minutes. */
    downloadUrl(options: {
      readonly app: string;
      readonly stage: string;
      readonly store: string;
      readonly key: string;
    }): Effect.Effect<string>;
  }
>()('@ericminassian/platform-control-plane/DataBrowser') {
  static readonly layer: Layer.Layer<DataBrowser, never, Aws | Settings> = Layer.effect(
    DataBrowser,
    Effect.gen(function* () {
      const aws = yield* Aws;
      const settings = yield* Settings;

      const collections = Effect.fn('DataBrowser.collections')(
        function* (app: string, stage: string) {
          const counts = new Map<string, number>();
          let ExclusiveStartKey: Record<string, unknown> | undefined;
          let scanned = 0;
          do {
            const res = yield* tryAws(() =>
              aws.ddb().send(
                new ScanCommand({
                  TableName: names.table(app, stage),
                  ProjectionExpression: '#c',
                  // Rate-limit counters aren't documents: one per client, they'd crowd the sample.
                  FilterExpression: 'NOT begins_with(#pk, :rl)',
                  ExpressionAttributeNames: { '#c': '_c', '#pk': 'pk' },
                  ExpressionAttributeValues: { ':rl': RATE_LIMIT_PK_PREFIX },
                  ExclusiveStartKey,
                  Limit: 1000,
                }),
              ),
            );
            for (const i of res.Items ?? []) {
              const c = typeof i._c === 'string' ? i._c : '(untyped)';
              counts.set(c, (counts.get(c) ?? 0) + 1);
            }
            scanned += res.ScannedCount ?? 0;
            ExclusiveStartKey = res.LastEvaluatedKey;
          } while (ExclusiveStartKey && scanned < 5000);
          const found = [...counts]
            .map(([name, sampled]) => ({ name, sampled }))
            .toSorted((a, b) => a.name.localeCompare(b.name));
          return { database: true, collections: found } satisfies DataCollections;
        },
        Effect.catchIf(noTable, () => Effect.succeed<DataCollections>({ database: false, collections: [] })),
        Effect.orDie,
      );

      const items = Effect.fn('DataBrowser.items')(
        function* (options: {
          readonly app: string;
          readonly stage: string;
          readonly collection: string;
          readonly partition?: string | undefined;
          readonly cursor?: string | undefined;
          readonly limit?: number | undefined;
        }) {
          const TableName = names.table(options.app, options.stage);
          const Limit = Math.min(options.limit ?? 50, 200);
          const ExclusiveStartKey = yield* Effect.try({
            try: () => decodeCursor(options.cursor),
            catch: () => BadRequest.of('invalid cursor'),
          });
          const res = yield* tryAws(() =>
            options.partition
              ? aws.ddb().send(
                  new QueryCommand({
                    TableName,
                    KeyConditionExpression: 'pk = :pk',
                    ExpressionAttributeValues: { ':pk': `${options.collection}#${options.partition}` },
                    Limit,
                    ExclusiveStartKey,
                  }),
                )
              : aws.ddb().send(
                  new ScanCommand({
                    TableName,
                    FilterExpression: '#c = :c',
                    ExpressionAttributeNames: { '#c': '_c' },
                    ExpressionAttributeValues: { ':c': options.collection },
                    Limit,
                    ExclusiveStartKey,
                  }),
                ),
          ).pipe(
            Effect.catchIf(noTable, () =>
              Effect.fail(
                new NotFound({
                  code: 'not_found',
                  message: `${options.app}/${options.stage} has no database; set db: true in plat.config.ts and deploy`,
                }),
              ),
            ),
          );
          const cursor = encodeCursor(res.LastEvaluatedKey);
          return {
            items: (res.Items ?? []).map(cleanItem),
            ...(cursor ? { cursor } : {}),
          } satisfies DataPage;
        },
        Effect.catchTag('AwsError', Effect.die),
      );

      const storage = Effect.fn('DataBrowser.storage')(function* (options: {
        readonly app: string;
        readonly stage: string;
        readonly store: string;
        readonly prefix?: string | undefined;
        readonly cursor?: string | undefined;
      }) {
        const { storageBucket } = yield* settings.runtime;
        const base = names.storagePrefix(options.app, options.stage, options.store);
        const res = yield* tryAws(() =>
          aws.s3().send(
            new ListObjectsV2Command({
              Bucket: storageBucket,
              Prefix: base + (options.prefix ?? ''),
              MaxKeys: 200,
              ...(options.cursor ? { ContinuationToken: options.cursor } : {}),
            }),
          ),
        );
        return {
          objects: (res.Contents ?? []).map((o) => ({
            key: (o.Key ?? '').slice(base.length),
            size: o.Size ?? 0,
            ...(o.LastModified ? { lastModified: o.LastModified.toISOString() } : {}),
          })),
          ...(res.NextContinuationToken ? { cursor: res.NextContinuationToken } : {}),
        } satisfies StorageListing;
      }, Effect.orDie);

      const downloadUrl = Effect.fn('DataBrowser.downloadUrl')(function* (options: {
        readonly app: string;
        readonly stage: string;
        readonly store: string;
        readonly key: string;
      }) {
        const { storageBucket } = yield* settings.runtime;
        if (options.key.includes('..')) return yield* Effect.die(new Error('invalid key'));
        return yield* tryAws(() =>
          getSignedUrl(
            aws.s3(),
            new GetObjectCommand({
              Bucket: storageBucket,
              Key: names.storagePrefix(options.app, options.stage, options.store) + options.key,
            }),
            { expiresIn: 300 },
          ),
        );
      }, Effect.orDie);

      return DataBrowser.of({ collections, items, storage, downloadUrl });
    }),
  );
}
