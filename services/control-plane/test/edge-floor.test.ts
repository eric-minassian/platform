import {
  type CloudFrontClient,
  GetDistributionConfigCommand,
  type GetDistributionConfigResult,
  UpdateDistributionCommand,
} from '@aws-sdk/client-cloudfront';
import {
  type CloudWatchClient,
  DescribeAlarmsCommand,
  GetMetricDataCommand,
  type MetricAlarm,
} from '@aws-sdk/client-cloudwatch';
import {
  CreateWebACLCommand,
  DeleteWebACLCommand,
  GetSampledRequestsCommand,
  GetWebACLCommand,
  ListWebACLsCommand,
  UpdateWebACLCommand,
  type WAFV2Client,
} from '@aws-sdk/client-wafv2';
import { assert, describe, it } from '@effect/vitest';
import { EDGE_RATE_LIMITED_BODY, type PlatformRuntimeConfig } from '@ericminassian/platform-core';
import { Effect, Layer, Option } from 'effect';
import { TestClock } from 'effect/testing';
import { expect } from 'vitest';
import {
  EDGE_FLOOR_HOLD_MS,
  EdgeFloor,
  edgeFloorWanted,
  edgeFloorWebAcl,
  offReason,
  onReason,
  toEdgeAlarm,
} from '../src/edge-floor.ts';
import { type EdgeFloorItem, Store } from '../src/store.ts';
import { awsLayer, memoryStore, platform, runtime, settingsLayer } from './support.ts';

const minute = 60_000;
const hour = 3_600_000;
const t0 = Date.parse('2026-11-16T10:00:00.000Z');
const distributionArn = 'arn:aws:cloudfront::000000000000:distribution/E1';
const floorAcl = (id: string) =>
  `arn:aws:wafv2:us-east-1:000000000000:global/webacl/platform-edge-floor/${id}`;
const withFloor: PlatformRuntimeConfig = {
  ...runtime,
  distributionArn,
  edgeFloor: {
    alarmArn: 'arn:aws:cloudwatch:us-east-1:000000000000:alarm:platform-edge-floor',
    ruleArn: 'arn:aws:events:us-east-1:000000000000:rule/platform-edge-floor',
  },
};

/** CloudWatch, CloudFront and WAF as far as the floor uses them, recording each write. */
interface World {
  alarm?: MetricAlarm;
  acl?: { Id: string; ARN: string; Description: string };
  distributionAcl: string;
  etag: number;
  /** WAF still sees the web ACL attached (cleared moments ago). */
  attachedForWaf?: boolean;
  writes: string[];
  created?: CreateWebACLCommand['input'];
  updatedAcl?: UpdateWebACLCommand['input'];
  updatedDistribution?: UpdateDistributionCommand['input'];
}

const rejectWith = (name: string) => Promise.reject(Object.assign(new Error(name), { name }));

const fakeAws = (world: World) => {
  let ids = 0;
  const cloudfront = {
    send: (command: unknown) => {
      if (command instanceof GetDistributionConfigCommand)
        return Promise.resolve({
          ETag: `E${world.etag}`,
          DistributionConfig: {
            CallerReference: 'ref',
            Comment: 'platform-edge',
            Enabled: true,
            WebACLId: world.distributionAcl,
          },
        } as GetDistributionConfigResult);
      if (command instanceof UpdateDistributionCommand) {
        if (command.input.IfMatch !== `E${world.etag}`) return rejectWith('PreconditionFailed');
        world.updatedDistribution = command.input;
        world.distributionAcl = command.input.DistributionConfig?.WebACLId ?? '';
        world.etag++;
        world.writes.push(world.distributionAcl ? 'attach' : 'detach');
        return Promise.resolve({});
      }
      return rejectWith('Unexpected');
    },
  } as unknown as CloudFrontClient;
  const wafv2 = {
    send: (command: unknown) => {
      if (command instanceof ListWebACLsCommand)
        return Promise.resolve({
          WebACLs: [
            {
              Name: 'something-else',
              Id: 'x',
              ARN: 'arn:aws:wafv2:us-east-1:0:global/webacl/something-else/x',
            },
            ...(world.acl
              ? [{ Name: 'platform-edge-floor', Id: world.acl.Id, ARN: world.acl.ARN, LockToken: 'lock' }]
              : []),
          ],
        });
      if (command instanceof CreateWebACLCommand) {
        if (world.acl) return rejectWith('WAFDuplicateItemException');
        const Id = `acl${++ids}`;
        world.acl = { Id, ARN: floorAcl(Id), Description: command.input.Description ?? '' };
        world.created = command.input;
        world.writes.push('create');
        return Promise.resolve({ Summary: { Id, ARN: world.acl.ARN, LockToken: 'lock' } });
      }
      if (command instanceof GetWebACLCommand)
        return world.acl
          ? Promise.resolve({ WebACL: { Description: world.acl.Description }, LockToken: 'lock' })
          : rejectWith('WAFNonexistentItemException');
      if (command instanceof UpdateWebACLCommand) {
        world.updatedAcl = command.input;
        if (world.acl) world.acl.Description = command.input.Description ?? '';
        world.writes.push('update');
        return Promise.resolve({});
      }
      if (command instanceof DeleteWebACLCommand) {
        if (!world.acl || command.input.Id !== world.acl.Id) return rejectWith('WAFNonexistentItemException');
        if (world.attachedForWaf || world.distributionAcl === world.acl.ARN)
          return rejectWith('WAFAssociatedItemException');
        world.acl = undefined;
        world.writes.push('delete');
        return Promise.resolve({});
      }
      if (command instanceof GetSampledRequestsCommand)
        return Promise.resolve({
          SampledRequests: [
            {
              Timestamp: new Date(t0 - 2 * minute),
              Action: 'BLOCK',
              Weight: 1,
              Request: {
                ClientIP: '203.0.113.7',
                Country: 'NL',
                Method: 'POST',
                URI: '/api/strokes',
                Headers: [{ Name: 'Host', Value: 'draw.example.com' }],
              },
            },
            {
              Timestamp: new Date(t0 - minute),
              Action: 'BLOCK',
              Weight: 1,
              Request: { ClientIP: '2001:db8::7', Method: 'GET', URI: '/', Headers: [] },
            },
          ],
        });
      return rejectWith('Unexpected');
    },
  } as unknown as WAFV2Client;
  const cloudwatch = {
    send: (command: unknown) => {
      if (command instanceof DescribeAlarmsCommand)
        return Promise.resolve({ MetricAlarms: world.alarm ? [world.alarm] : [] });
      if (command instanceof GetMetricDataCommand) {
        world.writes.push('metrics');
        return Promise.resolve({
          MetricDataResults: [
            { Id: 'm0', Timestamps: [new Date(t0 - hour)], Values: [42] },
            { Id: 'm1', Timestamps: [new Date(t0 - 2 * hour), new Date(t0 - hour)], Values: [900, 1000] },
          ],
        });
      }
      return rejectWith('Unexpected');
    },
  } as unknown as CloudWatchClient;
  return awsLayer({ cloudfront: () => cloudfront, wafv2: () => wafv2, cloudwatch: () => cloudwatch });
};

const alarm = (value: 'OK' | 'ALARM' | 'INSUFFICIENT_DATA', since: number, peak?: number): MetricAlarm => ({
  AlarmName: 'platform-edge-floor',
  StateValue: value,
  StateTransitionedTimestamp: new Date(since),
  StateUpdatedTimestamp: new Date(since),
  ...(peak !== undefined
    ? { StateReasonData: JSON.stringify({ version: '1.0', recentDatapoints: [peak], threshold: 1000 }) }
    : {}),
});

const setup = (
  world: World,
  options: { runtime?: PlatformRuntimeConfig; stored?: EdgeFloorItem; floor?: boolean; limit?: number } = {},
) => {
  const limits =
    options.floor === false
      ? platform.limits
      : { ...platform.limits, edgeRequestsPerMinute: options.limit ?? 1000, edgeFloorAt: 1000 };
  return EdgeFloor.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        fakeAws(world),
        settingsLayer({
          platform: { ...platform, limits },
          runtime: Effect.succeed(options.runtime ?? withFloor),
        }),
        memoryStore(options.stored ? { edgeFloor: options.stored } : {}),
      ),
    ),
  );
};

const reconcile = (options?: { alarming?: boolean }) => EdgeFloor.use((f) => f.reconcile(options));
const stored = Store.use((s) => s.getEdgeFloor).pipe(Effect.map(Option.getOrUndefined));

const onSince = (since: number): EdgeFloorItem => ({
  on: true,
  since: new Date(since).toISOString(),
  why: onReason({ value: 'ALARM', since, peak: 1532 }, 1000),
});

describe('edge floor', () => {
  it('blocks a client over the limit for one host with a RateLimited 429', () => {
    const acl = edgeFloorWebAcl(1000);
    expect(acl.Description).toBe('At most 1000 requests per client per app host per minute');
    expect(acl.DefaultAction).toEqual({ Allow: {} });
    expect(acl.CustomResponseBodies).toEqual({
      'rate-limited': { ContentType: 'APPLICATION_JSON', Content: JSON.stringify(EDGE_RATE_LIMITED_BODY) },
    });
    expect(acl.Rules).toEqual([
      {
        Name: 'requests-per-client',
        Priority: 0,
        Statement: {
          RateBasedStatement: {
            Limit: 1000,
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
              CustomResponseBodyKey: 'rate-limited',
              ResponseHeaders: [{ Name: 'retry-after', Value: '60' }],
            },
          },
        },
        VisibilityConfig: {
          CloudWatchMetricsEnabled: true,
          MetricName: 'requests-per-client',
          SampledRequestsEnabled: true,
        },
      },
    ]);
    expect(acl.VisibilityConfig).toEqual({
      CloudWatchMetricsEnabled: true,
      MetricName: 'platform-edge-floor',
      SampledRequestsEnabled: true,
    });
  });

  it('is on while the alarm is, and until it has been OK for an hour', () => {
    const now = t0;
    const want = (a: Parameters<typeof edgeFloorWanted>[0]['alarm'], on: boolean, configured = true) =>
      edgeFloorWanted({ configured, alarm: a, on, now });
    expect(want({ value: 'ALARM', since: now - minute }, false)).toBe(true);
    expect(want({ value: 'ALARM', since: now - 5 * hour }, true)).toBe(true);
    expect(want({ value: 'OK', since: now - 30 * minute }, true)).toBe(true);
    expect(want({ value: 'OK', since: now - EDGE_FLOOR_HOLD_MS }, true)).toBe(false);
    // No requests at all: as good as OK.
    expect(want({ value: 'INSUFFICIENT_DATA', since: now - 2 * hour }, true)).toBe(false);
    // An OK alarm never turns it on.
    expect(want({ value: 'OK', since: now - 5 * minute }, false)).toBe(false);
    // Without the setting, or the alarm, it's off whatever happened before.
    expect(want({ value: 'ALARM', since: now }, true, false)).toBe(false);
    expect(want(undefined, true)).toBe(false);
  });

  it('reads the alarm’s state, since when, and the minute that set it off', () => {
    expect(toEdgeAlarm(alarm('ALARM', t0, 1532))).toEqual({ value: 'ALARM', since: t0, peak: 1532 });
    expect(toEdgeAlarm({ ...alarm('OK', t0), StateReasonData: 'not json' })).toEqual({
      value: 'OK',
      since: t0,
      peak: undefined,
    });
    expect(toEdgeAlarm({ AlarmName: 'platform-edge-floor' })).toBeUndefined();
    expect(onReason({ value: 'ALARM', since: t0, peak: 1532 }, 1000)).toBe(
      '1,532 requests in a minute across the edge, at least 1,000',
    );
    expect(offReason(1000)).toBe('under 1,000 requests a minute across the edge for an hour');
  });

  it.effect('turns on when the alarm goes off: creates the web ACL and attaches it', () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(t0);
      const world: World = {
        alarm: alarm('ALARM', t0 - minute, 1532),
        distributionAcl: '',
        etag: 1,
        writes: [],
      };
      const { state, after } = yield* Effect.gen(function* () {
        return { state: yield* reconcile({ alarming: true }), after: yield* stored };
      }).pipe(Effect.provide(setup(world)));
      assert.deepStrictEqual(world.writes, ['create', 'attach']);
      assert.strictEqual(world.created?.Name, 'platform-edge-floor');
      assert.strictEqual(world.created?.Scope, 'CLOUDFRONT');
      assert.deepStrictEqual(world.created?.Rules, edgeFloorWebAcl(1000).Rules);
      assert.deepStrictEqual(world.created?.Tags, [
        { Key: 'platform:managed', Value: 'true' },
        { Key: 'platform:component', Value: 'edge' },
      ]);
      // The rest of the distribution's config goes back as it was.
      assert.strictEqual(world.updatedDistribution?.Id, 'E1');
      assert.strictEqual(world.updatedDistribution?.IfMatch, 'E1');
      assert.strictEqual(world.updatedDistribution?.DistributionConfig?.Comment, 'platform-edge');
      assert.strictEqual(world.distributionAcl, floorAcl('acl1'));
      const turnedOn = {
        on: true,
        since: '2026-11-16T10:00:00.000Z',
        why: '1,532 requests in a minute across the edge, at least 1,000',
      };
      assert.deepStrictEqual(state, turnedOn);
      assert.deepStrictEqual(after, turnedOn);
    }),
  );

  it.effect('trusts the alarm’s event over a read of it that lags', () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(t0);
      const world: World = { alarm: alarm('OK', t0 - hour), distributionAcl: '', etag: 1, writes: [] };
      const state = yield* reconcile({ alarming: true }).pipe(Effect.provide(setup(world)));
      assert.strictEqual(state.on, true);
      assert.deepStrictEqual(world.writes, ['create', 'attach']);
      assert.strictEqual(state.why, 'at least 1,000 requests in a minute across the edge');
    }),
  );

  it.effect('changes nothing while it’s on and attached, or off and gone', () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(t0);
      const on: World = {
        alarm: alarm('ALARM', t0 - 10 * minute),
        acl: { Id: 'acl1', ARN: floorAcl('acl1'), Description: edgeFloorWebAcl(1000).Description },
        distributionAcl: floorAcl('acl1'),
        etag: 1,
        writes: [],
      };
      const state = yield* reconcile().pipe(Effect.provide(setup(on, { stored: onSince(t0 - 10 * minute) })));
      assert.deepStrictEqual(on.writes, []);
      assert.deepStrictEqual(state, onSince(t0 - 10 * minute));

      const off: World = { alarm: alarm('OK', t0 - 5 * hour), distributionAcl: '', etag: 1, writes: [] };
      assert.deepStrictEqual(yield* reconcile().pipe(Effect.provide(setup(off))), { on: false });
      assert.deepStrictEqual(off.writes, []);
    }),
  );

  it.effect('puts the web ACL back when a foundation deploy took it off', () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(t0);
      const world: World = {
        alarm: alarm('OK', t0 - 20 * minute),
        acl: { Id: 'acl1', ARN: floorAcl('acl1'), Description: edgeFloorWebAcl(1000).Description },
        distributionAcl: '',
        etag: 7,
        writes: [],
      };
      const state = yield* reconcile().pipe(Effect.provide(setup(world, { stored: onSince(t0 - hour) })));
      assert.deepStrictEqual(world.writes, ['attach']);
      assert.strictEqual(world.distributionAcl, floorAcl('acl1'));
      // Still on since it first turned on.
      assert.deepStrictEqual(state, onSince(t0 - hour));
    }),
  );

  it.effect('brings the web ACL to a changed limit', () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(t0);
      const world: World = {
        alarm: alarm('ALARM', t0 - minute),
        acl: { Id: 'acl1', ARN: floorAcl('acl1'), Description: edgeFloorWebAcl(1000).Description },
        distributionAcl: floorAcl('acl1'),
        etag: 1,
        writes: [],
      };
      yield* reconcile().pipe(Effect.provide(setup(world, { stored: onSince(t0 - minute), limit: 500 })));
      assert.deepStrictEqual(world.writes, ['update']);
      assert.strictEqual(world.updatedAcl?.Id, 'acl1');
      assert.strictEqual(world.updatedAcl?.LockToken, 'lock');
      assert.deepStrictEqual(world.updatedAcl?.Rules, edgeFloorWebAcl(500).Rules);
    }),
  );

  it.effect('turns off an hour after the alarm is back to OK: detaches, then deletes the web ACL', () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(t0);
      const world: World = {
        alarm: alarm('OK', t0 - hour),
        acl: { Id: 'acl1', ARN: floorAcl('acl1'), Description: edgeFloorWebAcl(1000).Description },
        distributionAcl: floorAcl('acl1'),
        etag: 1,
        writes: [],
      };
      const { state, after } = yield* Effect.gen(function* () {
        return { state: yield* reconcile(), after: yield* stored };
      }).pipe(Effect.provide(setup(world, { stored: onSince(t0 - 2 * hour) })));
      assert.deepStrictEqual(world.writes, ['detach', 'delete']);
      assert.strictEqual(world.distributionAcl, '');
      const turnedOff = {
        on: false,
        since: '2026-11-16T10:00:00.000Z',
        why: 'under 1,000 requests a minute across the edge for an hour',
      };
      assert.deepStrictEqual(state, turnedOff);
      assert.deepStrictEqual(after, turnedOff);
    }),
  );

  it.effect('deletes a web ACL WAF still sees attached on the next run', () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(t0);
      const world: World = {
        alarm: alarm('OK', t0 - 2 * hour),
        acl: { Id: 'acl1', ARN: floorAcl('acl1'), Description: edgeFloorWebAcl(1000).Description },
        distributionAcl: floorAcl('acl1'),
        etag: 1,
        attachedForWaf: true,
        writes: [],
      };
      const layer = setup(world, { stored: onSince(t0 - 3 * hour) });
      const first = yield* reconcile().pipe(Effect.provide(layer));
      assert.strictEqual(first.on, false);
      assert.deepStrictEqual(world.writes, ['detach']);
      world.attachedForWaf = false;
      yield* reconcile().pipe(Effect.provide(setup(world, { stored: first as EdgeFloorItem })));
      assert.deepStrictEqual(world.writes, ['detach', 'delete']);
      assert.isUndefined(world.acl);
    }),
  );

  it.effect('takes the floor down when the platform stops setting it', () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(t0);
      const world: World = {
        // The stack deleted the alarm with the setting.
        acl: { Id: 'acl1', ARN: floorAcl('acl1'), Description: edgeFloorWebAcl(1000).Description },
        distributionAcl: floorAcl('acl1'),
        etag: 1,
        writes: [],
      };
      const { edgeFloor: _, ...bare } = withFloor;
      const state = yield* reconcile().pipe(
        Effect.provide(setup(world, { runtime: bare, floor: false, stored: onSince(t0 - 10 * minute) })),
      );
      assert.deepStrictEqual(world.writes, ['detach', 'delete']);
      assert.strictEqual(state.why, 'the platform no longer sets limits.edgeFloorAt');
    }),
  );

  it.effect('never replaces or clears a web ACL that isn’t the floor’s', () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(t0);
      const other = 'arn:aws:wafv2:us-east-1:000000000000:global/webacl/platform-edge/old';
      const on: World = { alarm: alarm('ALARM', t0), distributionAcl: other, etag: 1, writes: [] };
      yield* reconcile().pipe(Effect.provide(setup(on)));
      // Not even a web ACL of its own, which would bill unattached.
      assert.deepStrictEqual(on.writes, []);
      assert.strictEqual(on.distributionAcl, other);
      const off: World = { alarm: alarm('OK', t0 - 5 * hour), distributionAcl: other, etag: 1, writes: [] };
      yield* reconcile().pipe(Effect.provide(setup(off)));
      assert.deepStrictEqual(off.writes, []);
    }),
  );

  it.effect('does nothing without a router distribution (plat dev)', () =>
    Effect.gen(function* () {
      const world: World = { alarm: alarm('ALARM', t0), distributionAcl: '', etag: 1, writes: [] };
      const state = yield* reconcile({ alarming: true }).pipe(Effect.provide(setup(world, { runtime })));
      assert.deepStrictEqual(state, { on: false });
      assert.deepStrictEqual(world.writes, []);
    }),
  );

  it.effect('shows what it blocked while on, with the recent sample, newest first', () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(t0);
      const world: World = {
        acl: { Id: 'acl1', ARN: floorAcl('acl1'), Description: '' },
        distributionAcl: floorAcl('acl1'),
        etag: 1,
        writes: [],
      };
      const s = yield* EdgeFloor.use((e) => e.stats({ from: t0 - 3 * hour, to: t0, res: '1h' })).pipe(
        Effect.provide(setup(world, { stored: onSince(t0 - 30 * minute) })),
      );
      assert.deepStrictEqual(s.state, onSince(t0 - 30 * minute));
      assert.deepStrictEqual([s.enabled, s.limit, s.threshold], [true, 1000, 1000]);
      assert.deepStrictEqual(s.totals, { blocked: 42, allowed: 1900 });
      assert.deepStrictEqual(
        s.points.map((p) => [p.ts, p.blocked, p.allowed]),
        [
          ['2026-11-16T07:00:00.000Z', 0, 0],
          ['2026-11-16T08:00:00.000Z', 0, 900],
          ['2026-11-16T09:00:00.000Z', 42, 1000],
          ['2026-11-16T10:00:00.000Z', 0, 0],
        ],
      );
      assert.deepStrictEqual(s.samples, [
        { at: '2026-11-16T09:59:00.000Z', host: '-', client: '2001:db8::7', method: 'GET', path: '/' },
        {
          at: '2026-11-16T09:58:00.000Z',
          host: 'draw.example.com',
          client: '203.0.113.7',
          country: 'NL',
          method: 'POST',
          path: '/api/strokes',
        },
      ]);
    }),
  );

  it.effect('shows the last day’s counts while off, without samples', () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(t0);
      const world: World = { distributionAcl: '', etag: 1, writes: [] };
      const s = yield* EdgeFloor.use((e) => e.stats({ from: t0 - 3 * hour, to: t0, res: '1h' })).pipe(
        Effect.provide(setup(world)),
      );
      assert.deepStrictEqual(s.state, { on: false });
      assert.strictEqual(s.totals.blocked, 42);
      assert.deepStrictEqual(s.samples, []);
    }),
  );

  it.effect('reports the floor off, without a call, when the platform has none', () =>
    Effect.gen(function* () {
      const world: World = { distributionAcl: '', etag: 1, writes: [] };
      const { edgeFloor: _, ...bare } = withFloor;
      const s = yield* EdgeFloor.use((e) => e.stats({ from: t0 - hour, to: t0, res: '1h' })).pipe(
        Effect.provide(setup(world, { runtime: bare, floor: false })),
      );
      assert.strictEqual(s.enabled, false);
      assert.deepStrictEqual([s.points, s.samples], [[], []]);
      assert.deepStrictEqual(world.writes, []);
    }),
  );
});
