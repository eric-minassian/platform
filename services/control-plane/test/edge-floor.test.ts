import type { CloudWatchClient, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import type { GetSampledRequestsCommand, WAFV2Client } from '@aws-sdk/client-wafv2';
import { assert, describe, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { TestClock } from 'effect/testing';
import { EdgeFloor } from '../src/edge-floor.ts';
import { awsLayer, platform, runtime, settingsLayer } from './support.ts';

const hour = 3_600_000;
const t0 = Date.parse('2026-11-15T10:00:00.000Z');
const acl = 'arn:aws:wafv2:us-east-1:000000000000:global/webacl/platform-edge/abc';

/** The service over fake CloudWatch and WAF clients that record what they're sent. */
const setup = (options: { webAcl?: boolean; samplesFail?: string } = {}) => {
  const metricCalls: GetMetricDataCommand[] = [];
  const sampleCalls: GetSampledRequestsCommand[] = [];
  const cloudwatch = {
    send: (command: GetMetricDataCommand) => {
      metricCalls.push(command);
      return Promise.resolve({
        MetricDataResults: [
          { Id: 'm0', Timestamps: [new Date(t0 + hour)], Values: [42] },
          { Id: 'm1', Timestamps: [new Date(t0), new Date(t0 + hour)], Values: [900, 1000] },
        ],
      });
    },
  } as unknown as CloudWatchClient;
  const wafv2 = {
    send: (command: GetSampledRequestsCommand) => {
      sampleCalls.push(command);
      if (options.samplesFail)
        return Promise.reject(Object.assign(new Error('gone'), { name: options.samplesFail }));
      return Promise.resolve({
        SampledRequests: [
          {
            Timestamp: new Date(t0 + 60_000),
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
            Timestamp: new Date(t0 + 120_000),
            Action: 'BLOCK',
            Weight: 1,
            Request: { ClientIP: '2001:db8::7', Method: 'GET', URI: '/', Headers: [] },
          },
        ],
      });
    },
  } as unknown as WAFV2Client;
  const layer = EdgeFloor.layer.pipe(
    Layer.provide([
      awsLayer({ cloudwatch: () => cloudwatch, wafv2: () => wafv2 }),
      settingsLayer({
        platform: { ...platform, limits: { ...platform.limits, edgeRequestsPerMinute: 1000 } },
        runtime: Effect.succeed(options.webAcl === false ? runtime : { ...runtime, edgeWebAclArn: acl }),
      }),
    ]),
  );
  const stats = EdgeFloor.use((e) => e.stats({ from: t0, to: t0 + hour, res: '1h' })).pipe(
    Effect.provide(layer),
  );
  return { metricCalls, sampleCalls, stats };
};

describe('edge floor', () => {
  it.effect('reads blocked and allowed requests and the recent sample, newest first', () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(t0 + 2 * hour);
      const { metricCalls, sampleCalls, stats } = setup();
      const s = yield* stats;
      assert.deepStrictEqual(s.totals, { blocked: 42, allowed: 1900 });
      assert.deepStrictEqual(s.points, [
        { ts: '2026-11-15T10:00:00.000Z', blocked: 0, allowed: 900 },
        { ts: '2026-11-15T11:00:00.000Z', blocked: 42, allowed: 1000 },
      ]);
      assert.strictEqual(s.limit, 1000);
      assert.deepStrictEqual(s.samples, [
        { at: '2026-11-15T10:02:00.000Z', host: '-', client: '2001:db8::7', method: 'GET', path: '/' },
        {
          at: '2026-11-15T10:01:00.000Z',
          host: 'draw.example.com',
          client: '203.0.113.7',
          country: 'NL',
          method: 'POST',
          path: '/api/strokes',
        },
      ]);

      const [blocked, allowed] = metricCalls[0]!.input.MetricDataQueries!;
      assert.deepStrictEqual(blocked!.MetricStat!.Metric, {
        Namespace: 'AWS/WAFV2',
        MetricName: 'BlockedRequests',
        Dimensions: [
          { Name: 'WebACL', Value: 'platform-edge' },
          { Name: 'Rule', Value: 'requests-per-client' },
        ],
      });
      assert.strictEqual(allowed!.Id, 'm1');
      assert.deepStrictEqual(allowed!.MetricStat!.Metric!.Dimensions, [
        { Name: 'WebACL', Value: 'platform-edge' },
        { Name: 'Rule', Value: 'ALL' },
      ]);
      // WAF keeps three hours of samples, and refuses a window reaching past them.
      const { input } = sampleCalls[0]!;
      assert.strictEqual(input.WebAclArn, acl);
      assert.strictEqual(input.Scope, 'CLOUDFRONT');
      assert.strictEqual(input.RuleMetricName, 'requests-per-client');
      assert.strictEqual(input.TimeWindow!.EndTime!.getTime(), t0 + 2 * hour);
      assert.strictEqual(input.TimeWindow!.StartTime!.getTime(), t0 - hour + 60_000);
    }),
  );

  it.effect('reports the floor off, without a call, when the platform has none', () =>
    Effect.gen(function* () {
      const { metricCalls, sampleCalls, stats } = setup({ webAcl: false });
      const s = yield* stats;
      assert.strictEqual(s.enabled, false);
      assert.deepStrictEqual([s.points, s.samples], [[], []]);
      assert.strictEqual(metricCalls.length + sampleCalls.length, 0);
    }),
  );

  it.effect('shows no samples for a web ACL that is already gone', () =>
    Effect.gen(function* () {
      const s = yield* setup({ samplesFail: 'WAFNonexistentItemException' }).stats;
      assert.deepStrictEqual(s.samples, []);
      assert.strictEqual(s.totals.blocked, 42);
    }),
  );
});
