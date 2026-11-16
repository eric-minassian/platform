import { GetDistributionConfigCommand, UpdateDistributionCommand } from '@aws-sdk/client-cloudfront';
/**
 * The edge floor: a per-client request limit at the edge for every app
 * (`limits.edgeRequestsPerMinute`, an AWS WAF rate-based rule on the router
 * distribution), on only while the whole edge is busy. A web ACL bills by the
 * hour whether or not anything is flooding, so it exists only then.
 *
 * - The foundation stack has a CloudWatch alarm on the router's requests per
 *   minute (`limits.edgeFloorAt`), and an EventBridge rule that runs the
 *   worker's `edge-floor` job when it goes off.
 * - That job and the 5-minute watchdog call `reconcile`: while the alarm is in
 *   ALARM the floor is on, and once it has been OK for an hour the floor is
 *   off. On, the control plane creates the web ACL (us-east-1, scope
 *   CLOUDFRONT) and sets it as the distribution's `WebACLId`; off, it clears
 *   that and deletes the web ACL.
 * - The watchdog also repairs what changed underneath: an alarm event that
 *   never arrived, or a foundation deploy (drift-reverting, so any of them)
 *   that rewrote the distribution's config without the web ACL.
 *
 * Measured on a throwaway distribution (2026-11-16): attaching or clearing a
 * web ACL reached the nearest edge within seconds and finished deploying in
 * 30-40 s; WAF refuses to delete one still attached, and deleted it 5 s after
 * it was cleared. Attaching needs `wafv2:GetWebACL` on the web ACL besides
 * CloudFront's own permissions.
 *
 * `stats` reads it back for the admin page: blocked and allowed requests from
 * CloudWatch, and the requests WAF sampled as it blocked them.
 */
import { DescribeAlarmsCommand, type Dimension, type MetricAlarm } from '@aws-sdk/client-cloudwatch';
import {
  type CreateWebACLRequest,
  CreateWebACLCommand,
  DeleteWebACLCommand,
  GetSampledRequestsCommand,
  GetWebACLCommand,
  ListWebACLsCommand,
  type SampledHTTPRequest,
  UpdateWebACLCommand,
  type WebACLSummary,
} from '@aws-sdk/client-wafv2';
import {
  EDGE_RATE_LIMITED_BODY,
  EDGE_RETRY_AFTER_SECONDS,
  type EdgeFloorResponse,
  type EdgeFloorSample,
  type EdgeFloorState,
  platformNames,
} from '@ericminassian/platform-core';
import { platformTags } from '@ericminassian/platform-engine';
import { Clock, Context, Effect, Layer, Option } from 'effect';
import { Aws, AwsError, tryAws } from './aws.ts';
import { cloudWatchRange, denseSeries, readMetrics, sumQueries } from './cloudwatch.ts';
import { Settings } from './config.ts';
import { Store } from './store.ts';
import type { TimeRange } from './telemetry/query.ts';

/** How long the floor stays on after the alarm is back to OK, so a flood that pauses doesn't flap it. */
export const EDGE_FLOOR_HOLD_MS = 60 * 60_000;

/** WAF keeps samples of the last three hours. */
const SAMPLE_WINDOW_MS = 3 * 3_600_000;
const MAX_SAMPLES = 100;
const RATE_LIMITED_BODY_KEY = 'rate-limited';

/** What defines the web ACL: everything `CreateWebACL` and `UpdateWebACL` take besides its identity. */
export type EdgeFloorWebAcl = Required<
  Pick<
    CreateWebACLRequest,
    'Description' | 'DefaultAction' | 'CustomResponseBodies' | 'Rules' | 'VisibilityConfig'
  >
>;

/**
 * The floor's web ACL (pure). A client sending one host more than `limit`
 * requests a minute is answered at the edge, static files and public stores'
 * files included, with a 429 and the SDK's `RateLimited` body, until its rate
 * drops. Counted per client and host, so a busy client of one app (or a CI
 * runner testing several) isn't blocked from the others; WAF runs before the
 * router function, so `host` is the app's own, lowercased so spelling it
 * differently doesn't buy a second budget. The description names the limit,
 * which is how `reconcile` notices a web ACL made for another one.
 */
export function edgeFloorWebAcl(limit: number): EdgeFloorWebAcl {
  return {
    Description: `At most ${limit} requests per client per app host per minute`,
    DefaultAction: { Allow: {} },
    CustomResponseBodies: {
      [RATE_LIMITED_BODY_KEY]: {
        ContentType: 'APPLICATION_JSON',
        Content: JSON.stringify(EDGE_RATE_LIMITED_BODY),
      },
    },
    Rules: [
      {
        Name: platformNames.edgeFloorRule,
        Priority: 0,
        Statement: {
          RateBasedStatement: {
            Limit: limit,
            EvaluationWindowSec: 60,
            AggregateKeyType: 'CUSTOM_KEYS',
            CustomKeys: [
              { IP: {} },
              { Header: { Name: 'host', TextTransformations: [{ Priority: 0, Type: 'LOWERCASE' }] } },
            ],
          },
        },
        Action: {
          Block: {
            CustomResponse: {
              ResponseCode: 429,
              CustomResponseBodyKey: RATE_LIMITED_BODY_KEY,
              ResponseHeaders: [{ Name: 'retry-after', Value: String(EDGE_RETRY_AFTER_SECONDS) }],
            },
          },
        },
        VisibilityConfig: {
          CloudWatchMetricsEnabled: true,
          MetricName: platformNames.edgeFloorRule,
          // The console lists recently blocked requests from WAF's free sample.
          SampledRequestsEnabled: true,
        },
      },
    ],
    VisibilityConfig: {
      CloudWatchMetricsEnabled: true,
      MetricName: platformNames.edgeWebAcl,
      SampledRequestsEnabled: true,
    },
  };
}

/** The alarm on the router's requests per minute, as `reconcile` reads it. */
export interface EdgeAlarm {
  readonly value: 'OK' | 'ALARM' | 'INSUFFICIENT_DATA';
  /** When it last changed to `value` (epoch ms). */
  readonly since: number;
  /** The requests in the minute that set it off, when it's in ALARM. */
  readonly peak?: number | undefined;
}

/** The alarm from `DescribeAlarms` (pure); undefined when it has no state yet. */
export function toEdgeAlarm(a: MetricAlarm): EdgeAlarm | undefined {
  const value = a.StateValue;
  const since = a.StateTransitionedTimestamp ?? a.StateUpdatedTimestamp;
  if (!value || !since) return undefined;
  return { value, since: since.getTime(), peak: peakOf(a.StateReasonData) };
}

/** The highest datapoint in an alarm's `StateReasonData` JSON, if it has any. */
function peakOf(reasonData: string | undefined): number | undefined {
  if (!reasonData) return undefined;
  try {
    const points = (JSON.parse(reasonData) as { recentDatapoints?: unknown }).recentDatapoints;
    const values = Array.isArray(points) ? points.filter((p): p is number => typeof p === 'number') : [];
    return values.length ? Math.max(...values) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether the floor should be on (pure): while the alarm is in ALARM, and,
 * once it was on, until the alarm has been OK (or without data: no requests
 * at all) for `EDGE_FLOOR_HOLD_MS`. Never without the setting or the alarm.
 */
export function edgeFloorWanted(input: {
  readonly configured: boolean;
  readonly alarm: EdgeAlarm | undefined;
  /** What the control plane last recorded. */
  readonly on: boolean;
  readonly now: number;
}): boolean {
  const { configured, alarm, on, now } = input;
  if (!configured || !alarm) return false;
  if (alarm.value === 'ALARM') return true;
  return on && now - alarm.since < EDGE_FLOOR_HOLD_MS;
}

const count = (n: number) => n.toLocaleString('en-US');

/** Why the floor turned on, for the admin page (pure). */
export function onReason(alarm: EdgeAlarm | undefined, threshold: number): string {
  return alarm?.peak !== undefined
    ? `${count(alarm.peak)} requests in a minute across the edge, at least ${count(threshold)}`
    : `at least ${count(threshold)} requests in a minute across the edge`;
}

/** Why the floor turned off, for the admin page (pure). */
export function offReason(threshold: number | undefined): string {
  return threshold === undefined
    ? 'the platform no longer sets limits.edgeFloorAt'
    : `under ${count(threshold)} requests a minute across the edge for an hour`;
}

/** Whether a distribution's `WebACLId` is the floor's web ACL (another one is left alone). */
export const isEdgeFloorWebAcl = (arn: string): boolean =>
  arn.includes(`/webacl/${platformNames.edgeWebAcl}/`);

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

/** The metric dimensions of the web ACL's `rule` (`ALL`: every request the web ACL saw). */
const dimensions = (rule: string): Dimension[] => [
  { Name: 'WebACL', Value: platformNames.edgeWebAcl },
  { Name: 'Rule', Value: rule },
];

const SCOPE = 'CLOUDFRONT';

export class EdgeFloor extends Context.Service<
  EdgeFloor,
  {
    /** The floor's state, and what it blocked and let through over `range`, with recent samples, newest first. */
    stats(range: TimeRange): Effect.Effect<EdgeFloorResponse>;
    /**
     * Brings the floor, the distribution and the web ACL to where the alarm
     * says (see the module docs), and answers the floor's state. `alarming`
     * is the alarm's own word that it just went off (the `edge-floor` job),
     * which reading the alarm right after might not show yet.
     */
    reconcile(options?: { readonly alarming?: boolean }): Effect.Effect<EdgeFloorState>;
  }
>()('@ericminassian/platform-control-plane/EdgeFloor') {
  static readonly layer: Layer.Layer<EdgeFloor, never, Aws | Settings | Store> = Layer.effect(
    EdgeFloor,
    Effect.gen(function* () {
      const aws = yield* Aws;
      const settings = yield* Settings;
      const store = yield* Store;

      /** The floor's web ACL, if it exists. */
      const findWebAcl = Effect.gen(function* () {
        let NextMarker: string | undefined;
        do {
          const res = yield* tryAws((signal) =>
            aws.wafv2().send(new ListWebACLsCommand({ Scope: SCOPE, NextMarker }), { abortSignal: signal }),
          );
          const found = res.WebACLs?.find((w) => w.Name === platformNames.edgeWebAcl);
          if (found) return Option.some(found);
          NextMarker = res.WebACLs?.length ? res.NextMarker : undefined;
        } while (NextMarker);
        return Option.none<WebACLSummary>();
      });

      /** Creates the web ACL, or brings an existing one to `limit`; answers its ARN. */
      const ensureWebAcl = Effect.fnUntraced(function* (limit: number) {
        const definition = edgeFloorWebAcl(limit);
        const existing = yield* findWebAcl;
        if (Option.isNone(existing)) {
          const created = yield* tryAws((signal) =>
            aws.wafv2().send(
              new CreateWebACLCommand({
                Name: platformNames.edgeWebAcl,
                Scope: SCOPE,
                ...definition,
                Tags: Object.entries(platformTags('edge')).map(([Key, Value]) => ({ Key, Value })),
              }),
              { abortSignal: signal },
            ),
          ).pipe(
            Effect.map((res) => Option.fromNullishOr(res.Summary?.ARN)),
            // The alarm's job and the watchdog ran at once, and the other one created it.
            Effect.catchIf(AwsError.is('WAFDuplicateItemException'), () =>
              Effect.map(
                findWebAcl,
                Option.flatMap((w) => Option.fromNullishOr(w.ARN)),
              ),
            ),
          );
          return yield* Option.match(created, {
            onSome: Effect.succeed,
            onNone: () => Effect.die(new Error(`${platformNames.edgeWebAcl} was created but has no ARN`)),
          });
        }
        const { Id, ARN } = existing.value;
        if (!Id || !ARN) return yield* Effect.die(new Error(`${platformNames.edgeWebAcl} has no id`));
        const current = yield* tryAws((signal) =>
          aws.wafv2().send(new GetWebACLCommand({ Name: platformNames.edgeWebAcl, Scope: SCOPE, Id }), {
            abortSignal: signal,
          }),
        );
        if (current.WebACL?.Description !== definition.Description) {
          yield* tryAws((signal) =>
            aws.wafv2().send(
              new UpdateWebACLCommand({
                Name: platformNames.edgeWebAcl,
                Scope: SCOPE,
                Id,
                LockToken: current.LockToken,
                ...definition,
              }),
              { abortSignal: signal },
            ),
          );
          yield* Effect.logInfo('updated the edge floor’s web ACL').pipe(Effect.annotateLogs({ limit }));
        }
        return ARN;
      });

      /** Deletes the web ACL if it exists; false while WAF still sees it attached. */
      const deleteWebAcl = Effect.gen(function* () {
        const existing = yield* findWebAcl;
        if (Option.isNone(existing)) return true;
        const { Id, LockToken } = existing.value;
        return yield* tryAws((signal) =>
          aws
            .wafv2()
            .send(new DeleteWebACLCommand({ Name: platformNames.edgeWebAcl, Scope: SCOPE, Id, LockToken }), {
              abortSignal: signal,
            }),
        ).pipe(
          Effect.as(true),
          Effect.catchIf(AwsError.is('WAFNonexistentItemException'), () => Effect.succeed(true)),
          // Cleared too recently for WAF to see it, or something else attached it: the next run retries.
          Effect.catchIf(AwsError.is('WAFAssociatedItemException'), () => Effect.succeed(false)),
        );
      });

      const readDistribution = Effect.fnUntraced(function* (Id: string) {
        const res = yield* tryAws((signal) =>
          aws.cloudfront().send(new GetDistributionConfigCommand({ Id }), { abortSignal: signal }),
        );
        const config = res.DistributionConfig;
        if (!config) return yield* Effect.die(new Error(`distribution ${Id} has no config`));
        return { Id, config, etag: res.ETag, webAcl: config.WebACLId ?? '' };
      });

      /** Points the distribution at `webAcl` (empty: none), with the rest of its config as read. */
      const setDistributionWebAcl = (
        d: Effect.Success<ReturnType<typeof readDistribution>>,
        webAcl: string,
      ) =>
        // A change since the read fails on the ETag (PreconditionFailed); the next run retries.
        tryAws((signal) =>
          aws.cloudfront().send(
            new UpdateDistributionCommand({
              Id: d.Id,
              IfMatch: d.etag,
              DistributionConfig: { ...d.config, WebACLId: webAcl },
            }),
            { abortSignal: signal },
          ),
        );

      const readAlarm = Effect.gen(function* () {
        const res = yield* tryAws((signal) =>
          aws.cloudwatch().send(
            new DescribeAlarmsCommand({
              AlarmNames: [platformNames.edgeFloorAlarm],
              AlarmTypes: ['MetricAlarm'],
            }),
            {
              abortSignal: signal,
            },
          ),
        );
        const alarm = res.MetricAlarms?.[0];
        return alarm ? toEdgeAlarm(alarm) : undefined;
      });

      const reconcile = Effect.fn('EdgeFloor.reconcile')(function* (
        options: { readonly alarming?: boolean } = {},
      ) {
        const runtime = yield* settings.runtime;
        const { edgeRequestsPerMinute: limit, edgeFloorAt: threshold } = settings.platform.limits;
        const stored = Option.getOrUndefined(yield* store.getEdgeFloor);
        const state = (): EdgeFloorState => (stored ? { ...stored } : { on: false });
        // `plat dev` has no distribution, so no floor.
        const distributionId = runtime.distributionArn?.split('/').at(-1);
        if (!distributionId) return state();
        const configured = runtime.edgeFloor !== undefined && limit !== undefined && threshold !== undefined;
        const now = yield* Clock.currentTimeMillis;
        const read = configured ? yield* readAlarm : undefined;
        const alarm: EdgeAlarm | undefined =
          options.alarming && configured && read?.value !== 'ALARM' ? { value: 'ALARM', since: now } : read;
        const on = edgeFloorWanted({ configured, alarm, on: stored?.on === true, now });
        const distribution = yield* readDistribution(distributionId);
        // Never replaced or cleared: whoever set it owns it.
        const foreign = distribution.webAcl !== '' && !isEdgeFloorWebAcl(distribution.webAcl);
        if (foreign)
          yield* Effect.logWarning(
            'the router distribution has another web ACL; the edge floor leaves it',
          ).pipe(Effect.annotateLogs({ webAcl: distribution.webAcl }));

        if (on && limit !== undefined && threshold !== undefined) {
          if (foreign) return state();
          const arn = yield* ensureWebAcl(limit);
          const attached = distribution.webAcl !== arn;
          if (attached) yield* setDistributionWebAcl(distribution, arn);
          if (stored?.on !== true) {
            const turnedOn = {
              on: true,
              since: new Date(now).toISOString(),
              why: onReason(alarm, threshold),
            };
            if (yield* store.setEdgeFloor(turnedOn)) {
              yield* Effect.logWarning('the edge floor is on').pipe(
                Effect.annotateLogs({ why: turnedOn.why }),
              );
              return turnedOn;
            }
            return Option.getOrElse(yield* store.getEdgeFloor, () => turnedOn);
          }
          // A foundation deploy rewrote the distribution's config, which drops the web ACL.
          if (attached) yield* Effect.logWarning('put the edge floor back on the router distribution');
          return state();
        }

        if (distribution.webAcl !== '' && !foreign) yield* setDistributionWebAcl(distribution, '');
        // A web ACL bills by the hour while it exists, attached or not.
        const deleted = yield* deleteWebAcl;
        if (!deleted)
          yield* Effect.logInfo('the edge floor’s web ACL is still attached; deleting it next run');
        if (stored?.on === true) {
          const turnedOff = {
            on: false,
            since: new Date(now).toISOString(),
            why: offReason(configured ? threshold : undefined),
          };
          if (yield* store.setEdgeFloor(turnedOff))
            yield* Effect.logInfo('the edge floor is off').pipe(Effect.annotateLogs({ why: turnedOff.why }));
          return turnedOff;
        }
        return state();
      }, Effect.orDie);

      const samples = Effect.fnUntraced(function* (now: number) {
        const acl = yield* findWebAcl;
        if (Option.isNone(acl) || !acl.value.ARN) return [];
        const res = yield* tryAws((signal) =>
          aws.wafv2().send(
            new GetSampledRequestsCommand({
              WebAclArn: acl.value.ARN,
              RuleMetricName: platformNames.edgeFloorRule,
              Scope: SCOPE,
              // A minute's margin: a window reaching past three hours is refused.
              TimeWindow: { StartTime: new Date(now - SAMPLE_WINDOW_MS + 60_000), EndTime: new Date(now) },
              MaxItems: MAX_SAMPLES,
            }),
            { abortSignal: signal },
          ),
        ).pipe(
          // Deleted between the lookup and the read: the floor just turned off.
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
        const { edgeRequestsPerMinute: limit, edgeFloorAt: threshold } = settings.platform.limits;
        const stored = Option.getOrUndefined(yield* store.getEdgeFloor);
        const state: EdgeFloorState = stored
          ? { on: stored.on, since: stored.since, why: stored.why }
          : { on: false };
        const enabled = runtime.edgeFloor !== undefined;
        if (!enabled && !state.on)
          return {
            enabled,
            state,
            res: range.res,
            totals: { blocked: 0, allowed: 0 },
            points: [],
            samples: [],
          } satisfies EdgeFloorResponse;
        const now = yield* Clock.currentTimeMillis;
        const r = cloudWatchRange(range, now);
        // The web ACL keeps its name each time it's created, so its metrics cover every time it was on.
        const [blocked] = sumQueries(
          'AWS/WAFV2',
          ['BlockedRequests'],
          dimensions(platformNames.edgeFloorRule),
          r,
        );
        const [allowed] = sumQueries('AWS/WAFV2', ['AllowedRequests'], dimensions('ALL'), r);
        const [results, sampled] = yield* Effect.all(
          [
            readMetrics(aws, [blocked!, { ...allowed!, Id: 'm1' }], r),
            state.on ? samples(now) : Effect.succeed([]),
          ],
          { concurrency: 'unbounded' },
        );
        const { points, totals } = denseSeries(results, r, ['blocked', 'allowed']);
        return {
          enabled,
          state,
          ...(limit !== undefined ? { limit } : {}),
          ...(threshold !== undefined ? { threshold } : {}),
          res: r.res,
          totals,
          points,
          samples: sampled,
        } satisfies EdgeFloorResponse;
      }, Effect.orDie);

      return EdgeFloor.of({ stats, reconcile });
    }),
  );
}
