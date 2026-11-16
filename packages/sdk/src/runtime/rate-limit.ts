import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { APP_CONFIG_FILE } from '@ericminassian/platform-core';
import { getBindings } from './bindings.ts';
import { ddbClient } from './clients.ts';
import { span } from './telemetry.ts';

/**
 * Rate-limit counters on the stage's table, for `RateLimits`. One item per
 * limit, key and window:
 *
 *   pk  = `_rl#<limit>#<key>`               (`RATE_LIMIT_PK_PREFIX`)
 *   sk  = `<window length ms>#<window number>`
 *   n   = the uses counted in that window
 *   _ttl = when the window after it ends: until then it is the previous window
 *
 * Items are never read past their `_ttl`, so the lag of DynamoDB's TTL
 * deletes doesn't matter.
 */

function table(): string {
  const t = getBindings().table;
  if (!t)
    throw new Error(
      `RateLimits keeps its counts in the stage's database. Add \`db: true\` to ${APP_CONFIG_FILE}.`,
    );
  return t;
}

/** One check's write: add `cost` to the window `sk` of counter `pk` while its count is at most `room`. */
export interface CounterWrite {
  readonly pk: string;
  readonly sk: string;
  readonly cost: number;
  readonly room: number;
  /** Epoch seconds. */
  readonly expiresAt: number;
}

/** A count as DynamoDB returned it: unmarshalled in outputs, raw in a failed condition's `Item`. */
function countOf(value: unknown): number {
  if (typeof value === 'number') return value;
  const n = (value as { N?: unknown } | null | undefined)?.N;
  return typeof n === 'string' ? Number(n) : 0;
}

/** The uses counted in one window (0 when it has none), read consistently. */
export function readCounter(limit: string, pk: string, sk: string): Promise<number> {
  return span('rateLimit.read', limit, async () => {
    const out = await ddbClient().send(
      new GetCommand({
        TableName: table(),
        Key: { pk, sk },
        ConsistentRead: true,
        ProjectionExpression: '#n',
        ExpressionAttributeNames: { '#n': 'n' },
      }),
    );
    return countOf(out.Item?.n);
  });
}

/**
 * The write behind a check: adds `cost` to the window's count only while the
 * count is at most `room`, in one conditional UpdateItem, so concurrent
 * checks can't add past it. A failed condition returns the count as it stood.
 */
export function counterUpdate(opts: CounterWrite & { readonly table: string }) {
  return {
    TableName: opts.table,
    Key: { pk: opts.pk, sk: opts.sk },
    UpdateExpression: 'SET #ttl = :ttl ADD #n :cost',
    ConditionExpression: 'attribute_not_exists(#n) OR #n <= :room',
    ExpressionAttributeNames: { '#n': 'n', '#ttl': '_ttl' },
    ExpressionAttributeValues: { ':cost': opts.cost, ':room': opts.room, ':ttl': opts.expiresAt },
    ReturnValues: 'UPDATED_NEW' as const,
    ReturnValuesOnConditionCheckFailure: 'ALL_OLD' as const,
  };
}

/** Runs `counterUpdate`: the count after the add, or the count that refused it. */
export function addToCounter(limit: string, opts: CounterWrite): Promise<{ added: boolean; count: number }> {
  return span('rateLimit.add', limit, async () => {
    try {
      const out = await ddbClient().send(new UpdateCommand(counterUpdate({ table: table(), ...opts })));
      return { added: true, count: countOf(out.Attributes?.n) };
    } catch (e) {
      if ((e as { name?: unknown } | null)?.name !== 'ConditionalCheckFailedException') throw e;
      return { added: false, count: countOf((e as { Item?: { n?: unknown } }).Item?.n) };
    }
  });
}
