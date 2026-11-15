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
import { bucketStart, RESOLUTION_MS, telemetryKeys } from '@ericminassian/platform-core';
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
export const readMetrics = Effect.fnUntraced(function* (
  aws: Aws['Service'],
  queries: ReadonlyArray<MetricDataQuery>,
  range: TimeRange,
) {
  const step = RESOLUTION_MS[range.res];
  // Usually one page: a few metrics × at most 2,000 points stays under the 100,800 per call.
  const results: MetricDataResult[] = [];
  let NextToken: string | undefined;
  do {
    const res = yield* tryAws(() =>
      aws.cloudwatch().send(
        new GetMetricDataCommand({
          MetricDataQueries: [...queries],
          // Bucket-aligned, so CloudWatch's period boundaries match the series'.
          StartTime: new Date(bucketStart(range.from, range.res)),
          EndTime: new Date(bucketStart(range.to, range.res) + step),
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
