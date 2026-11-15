import {
  DeleteKeyCommand,
  DescribeKeyValueStoreCommand,
  GetKeyCommand,
  PutKeyCommand,
} from '@aws-sdk/client-cloudfront-keyvaluestore';
import { encodeRouteRecord, type RouteRecord } from '@ericminassian/platform-core';
import { type EngineContext, errorName, ignoreNotFound, retry } from '../util.ts';

/**
 * Host → route records in the CloudFront KeyValueStore read by the router
 * function. Writes are optimistic (ETag); concurrent deploys retry.
 */
const isConflict = (e: unknown) => /Conflict|PreconditionFailed|ValidationException/.test(errorName(e));

export async function putRoute(
  ctx: EngineContext,
  kvsArn: string,
  host: string,
  record: RouteRecord,
): Promise<void> {
  await putKey(ctx, kvsArn, host, encodeRouteRecord(record));
  ctx.log('info', `route ${host} → ${record.d}`, `route ${host}`);
}

export async function getRoute(
  ctx: EngineContext,
  kvsArn: string,
  host: string,
): Promise<RouteRecord | undefined> {
  const value = await getKey(ctx, kvsArn, host);
  return value ? (JSON.parse(value) as RouteRecord) : undefined;
}

/** Any key's raw value (route records, and the platform's own entries such as realtime's). */
export async function getKey(ctx: EngineContext, kvsArn: string, key: string): Promise<string | undefined> {
  const res = await ignoreNotFound(ctx.clients.kvs.send(new GetKeyCommand({ KvsARN: kvsArn, Key: key })));
  return res?.Value || undefined;
}

export async function putKey(ctx: EngineContext, kvsArn: string, key: string, value: string): Promise<void> {
  await retry(
    async () => {
      const d = await ctx.clients.kvs.send(new DescribeKeyValueStoreCommand({ KvsARN: kvsArn }));
      await ctx.clients.kvs.send(
        new PutKeyCommand({ KvsARN: kvsArn, Key: key, Value: value, IfMatch: d.ETag }),
      );
    },
    { when: isConflict, attempts: 8, delayMs: 300 },
  );
}

export async function deleteRoute(ctx: EngineContext, kvsArn: string, host: string): Promise<void> {
  await retry(
    async () => {
      const d = await ctx.clients.kvs.send(new DescribeKeyValueStoreCommand({ KvsARN: kvsArn }));
      await ignoreNotFound(
        ctx.clients.kvs.send(new DeleteKeyCommand({ KvsARN: kvsArn, Key: host, IfMatch: d.ETag })),
      );
    },
    { when: isConflict, attempts: 8, delayMs: 300 },
  );
  ctx.log('info', 'deleted route', `route ${host}`);
}
