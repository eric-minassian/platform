import {
  DeleteKeyCommand,
  DescribeKeyValueStoreCommand,
  GetKeyCommand,
  ListKeysCommand,
  PutKeyCommand,
} from '@aws-sdk/client-cloudfront-keyvaluestore';
import {
  encodeRouteRecord,
  type HostRecord,
  isHostRecord,
  type RouteRecord,
} from '@ericminassian/platform-core';
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

/** Every key and value in the store. */
export async function listKeys(
  ctx: EngineContext,
  kvsArn: string,
): Promise<Array<{ key: string; value: string }>> {
  const out: Array<{ key: string; value: string }> = [];
  let token: string | undefined;
  do {
    const page = await ctx.clients.kvs.send(new ListKeysCommand({ KvsARN: kvsArn, NextToken: token }));
    for (const item of page.Items ?? []) if (item.Key) out.push({ key: item.Key, value: item.Value ?? '' });
    token = page.NextToken;
  } while (token);
  return out;
}

const parsed = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
};

/**
 * Make the store's host entries (`hosts` in platform.config.ts) exactly
 * `records`: write the missing and changed ones, and delete host entries
 * that aren't there any more. Refuses to replace anything else (an app's
 * route, the realtime entry): a host that names a live app would shadow it.
 * Returns the hosts it changed.
 */
export async function ensureHostRecords(
  ctx: EngineContext,
  kvsArn: string,
  records: Readonly<Record<string, HostRecord>>,
): Promise<string[]> {
  const existing = new Map((await listKeys(ctx, kvsArn)).map(({ key, value }) => [key, parsed(value)]));
  const clash = Object.keys(records).filter((h) => existing.has(h) && !isHostRecord(existing.get(h)));
  if (clash.length)
    throw new Error(`hosts in platform.config.ts already route somewhere else: ${clash.join(', ')}`);
  const changed: string[] = [];
  for (const [host, record] of Object.entries(records)) {
    const value = JSON.stringify(record);
    if (JSON.stringify(existing.get(host)) === value) continue;
    await putKey(ctx, kvsArn, host, value);
    ctx.log(
      'info',
      `host ${host} → ${'a' in record ? record.a : `redirect to ${record.x}`}`,
      `route ${host}`,
    );
    changed.push(host);
  }
  for (const [host, value] of existing) {
    if (host in records || !isHostRecord(value)) continue;
    await deleteRoute(ctx, kvsArn, host);
    changed.push(host);
  }
  return changed;
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
