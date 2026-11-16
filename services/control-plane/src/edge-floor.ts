/**
 * The edge's per-client request floor (`limits.edgeRequestsPerMinute`: an
 * AWS WAF rate-based rule on the router distribution), read on demand for
 * the admin page: blocked and allowed requests from CloudWatch, and the
 * requests WAF sampled as it blocked them. A CloudFront web ACL and its
 * metrics live in us-east-1, the platform's region.
 */
import type { Dimension } from '@aws-sdk/client-cloudwatch';
import { GetSampledRequestsCommand, type SampledHTTPRequest } from '@aws-sdk/client-wafv2';
import { type EdgeFloorResponse, type EdgeFloorSample, platformNames } from '@ericminassian/platform-core';
import { Clock, Context, Effect, Layer } from 'effect';
import { Aws, AwsError, tryAws } from './aws.ts';
import { cloudWatchRange, denseSeries, readMetrics, sumQueries } from './cloudwatch.ts';
import { Settings } from './config.ts';
import type { TimeRange } from './telemetry/query.ts';

/** WAF keeps samples of the last three hours. */
const SAMPLE_WINDOW_MS = 3 * 3_600_000;
const MAX_SAMPLES = 100;

/** The metric dimensions of the web ACL's `rule` (`ALL`: every request the web ACL saw). */
const dimensions = (rule: string): Dimension[] => [
  { Name: 'WebACL', Value: platformNames.edgeWebAcl },
  { Name: 'Rule', Value: rule },
];

/** A sampled request as the admin page lists it (pure). */
export function toEdgeFloorSample(s: SampledHTTPRequest): EdgeFloorSample {
  const r = s.Request;
  const host = r?.Headers?.find((h) => h.Name?.toLowerCase() === 'host')?.Value;
  return {
    at: (s.Timestamp ?? new Date(0)).toISOString(),
    host: host ?? '-',
    client: r?.ClientIP ?? '-',
    ...(r?.Country ? { country: r.Country } : {}),
    method: r?.Method ?? '-',
    path: r?.URI ?? '/',
  };
}

export class EdgeFloor extends Context.Service<
  EdgeFloor,
  {
    /** Requests the floor blocked and let through over `range`, and its recent samples, newest first. */
    stats(range: TimeRange): Effect.Effect<EdgeFloorResponse>;
  }
>()('@ericminassian/platform-control-plane/EdgeFloor') {
  static readonly layer: Layer.Layer<EdgeFloor, never, Aws | Settings> = Layer.effect(
    EdgeFloor,
    Effect.gen(function* () {
      const aws = yield* Aws;
      const settings = yield* Settings;

      const samples = Effect.fnUntraced(function* (webAclArn: string, now: number) {
        const res = yield* tryAws((signal) =>
          aws.wafv2().send(
            new GetSampledRequestsCommand({
              WebAclArn: webAclArn,
              RuleMetricName: platformNames.edgeFloorRule,
              Scope: 'CLOUDFRONT',
              // A minute's margin: a window reaching past three hours is refused.
              TimeWindow: { StartTime: new Date(now - SAMPLE_WINDOW_MS + 60_000), EndTime: new Date(now) },
              MaxItems: MAX_SAMPLES,
            }),
            { abortSignal: signal },
          ),
        ).pipe(
          // Between a platform deploy that removes the floor and the runtime config catching up.
          Effect.catchIf(AwsError.is('WAFNonexistentItemException'), () =>
            Effect.succeed({ SampledRequests: [] }),
          ),
        );
        return (res.SampledRequests ?? [])
          .map(toEdgeFloorSample)
          .toSorted((a, b) => b.at.localeCompare(a.at));
      });

      const stats = Effect.fn('EdgeFloor.stats')(function* (range: TimeRange) {
        const runtime = yield* settings.runtime;
        const limit = settings.platform.limits.edgeRequestsPerMinute;
        if (!runtime.edgeWebAclArn)
          return {
            enabled: false,
            res: range.res,
            totals: { blocked: 0, allowed: 0 },
            points: [],
            samples: [],
          } satisfies EdgeFloorResponse;
        const now = yield* Clock.currentTimeMillis;
        const r = cloudWatchRange(range, now);
        const [blocked] = sumQueries(
          'AWS/WAFV2',
          ['BlockedRequests'],
          dimensions(platformNames.edgeFloorRule),
          r,
        );
        const [allowed] = sumQueries('AWS/WAFV2', ['AllowedRequests'], dimensions('ALL'), r);
        const [results, sampled] = yield* Effect.all(
          [readMetrics(aws, [blocked!, { ...allowed!, Id: 'm1' }], r), samples(runtime.edgeWebAclArn, now)],
          { concurrency: 'unbounded' },
        );
        const { points, totals } = denseSeries(results, r, ['blocked', 'allowed']);
        return {
          enabled: true,
          ...(limit !== undefined ? { limit } : {}),
          res: r.res,
          totals,
          points,
          samples: sampled,
        } satisfies EdgeFloorResponse;
      }, Effect.orDie);

      return EdgeFloor.of({ stats });
    }),
  );
}
