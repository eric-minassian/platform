/**
 * AWS service metrics read from CloudWatch on demand (realtime's AppSync
 * metrics, email's SES ones): the resolution CloudWatch can still answer a
 * range at, one `Sum` query per metric, every page of the answer, and the
 * dense series the console charts.
 */
import {
  type Dimension,
  GetMetricDataCommand,
  type MetricDataQuery,
  type MetricDataResult,
} from '@aws-sdk/client-cloudwatch';
import {
  bucketStart,
  QUERY_RESOLUTION_MS,
  type QueryResolution,
  RESOLUTION_MS,
  telemetryKeys,
} from '@ericminassian/platform-core';
import { Effect } from 'effect';
import { type Aws, tryAws } from './aws.ts';
import type { TimeRange } from './telemetry/query.ts';

/**
 * CloudWatch keeps 1-minute data for 15 days, so a range reaching further
 * back is read hourly.
 */
export function cloudWatchRange(range: TimeRange, now: number): TimeRange {
  return range.res === '1m' && range.from < now - 15 * 86_400_000 ? { ...range, res: '1h' } : range;
}

/** One `Sum` query per metric over `range`'s buckets, ids `m<index into metrics>`. */
export function sumQueries(
  namespace: string,
  metrics: ReadonlyArray<string>,
  dimensions: ReadonlyArray<Dimension>,
  range: TimeRange,
): MetricDataQuery[] {
  return metrics.map((metric, i) => ({
    Id: `m${i}`,
    MetricStat: {
      Metric: { Namespace: namespace, MetricName: metric, Dimensions: [...dimensions] },
      Period: RESOLUTION_MS[range.res] / 1000,
      Stat: 'Sum',
    },
  }));
}

/** Every page of `GetMetricData` for `queries` over `range`. */
export const readMetrics = (aws: Aws['Service'], queries: ReadonlyArray<MetricDataQuery>, range: TimeRange) =>
  // Bucket-aligned, so CloudWatch's period boundaries match the series'.
  readMetricsBetween(
    aws,
    queries,
    bucketStart(range.from, range.res),
    bucketStart(range.to, range.res) + RESOLUTION_MS[range.res],
  );

/** Every page of `GetMetricData` for `queries` from `start` to `end` (epoch ms, period-aligned). */
export const readMetricsBetween = Effect.fnUntraced(function* (
  aws: Aws['Service'],
  queries: ReadonlyArray<MetricDataQuery>,
  start: number,
  end: number,
) {
  // Usually one page: a few metrics × at most 2,000 points stays under the 100,800 per call.
  const results: MetricDataResult[] = [];
  let NextToken: string | undefined;
  do {
    const res = yield* tryAws(() =>
      aws.cloudwatch().send(
        new GetMetricDataCommand({
          MetricDataQueries: [...queries],
          StartTime: new Date(start),
          EndTime: new Date(end),
          ScanBy: 'TimestampAscending',
          NextToken,
        }),
      ),
    );
    results.push(...(res.MetricDataResults ?? []));
    NextToken = res.NextToken;
  } while (NextToken);
  return results;
});

/**
 * The resolution CloudWatch can answer a series in: it keeps 1-minute data
 * for 15 days, 5-minute data for 63, then hours. A coarser one comes with a
 * note saying why.
 */
export function cloudWatchSeriesRes(
  res: QueryResolution,
  from: number,
  now: number,
): { readonly res: QueryResolution; readonly note?: string } {
  const age = now - from;
  if (age > 63 * 86_400_000 && QUERY_RESOLUTION_MS[res] < 3_600_000)
    return { res: '1h', note: 'CloudWatch keeps 5-minute data for 63 days, so this range is in 1h buckets' };
  if (age > 15 * 86_400_000 && res === '1m')
    return { res: '5m', note: 'CloudWatch keeps 1-minute data for 15 days, so this range is in 5m buckets' };
  return { res };
}

/**
 * Dense series (one zero-filled point per bucket in range) and totals, where
 * query `m<i>` adds to series `seriesOf[i]`; several queries may add to one
 * series (pure).
 */
export function denseSeries<K extends string>(
  results: ReadonlyArray<MetricDataResult>,
  range: TimeRange,
  seriesOf: ReadonlyArray<K>,
): { points: Array<{ ts: string } & Record<K, number>>; totals: Record<K, number> } {
  const keys = [...new Set(seriesOf)];
  const zero = () => Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
  const step = RESOLUTION_MS[range.res];
  const buckets = new Map<number, Record<K, number>>();
  const end = bucketStart(range.to, range.res);
  for (let t = bucketStart(range.from, range.res); t <= end && buckets.size < 2000; t += step) {
    buckets.set(t, zero());
  }
  for (const r of results) {
    const series = seriesOf[Number(r.Id?.slice(1))];
    if (!series) continue;
    (r.Timestamps ?? []).forEach((when, i) => {
      const counts = buckets.get(bucketStart(new Date(when).getTime(), range.res));
      if (counts) counts[series] += r.Values?.[i] ?? 0;
    });
  }
  const totals = zero();
  for (const counts of buckets.values()) for (const k of keys) totals[k] += counts[k];
  const points = [...buckets].map(([t, counts]) => ({ ts: telemetryKeys.time(t), ...counts }));
  return { points, totals };
}
