import type { CloudWatchClient, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { assert, describe, it } from '@effect/vitest';
import { type AppRecord, type MinuteTraffic, parseManifest } from '@ericminassian/platform-core';
import { Effect, Layer, Option } from 'effect';
import { TestClock } from 'effect/testing';
import { stageComputeCost } from '../src/api/observe.ts';
import { Artifacts } from '../src/artifacts.ts';
import { WorkerJobs } from '../src/jobs/call.ts';
import { ComputeChooser, decideCompute, switchMessage } from '../src/jobs/compute.ts';
import { type DeploymentItem, type StageItem, Store } from '../src/store.ts';
import { TelemetryQuery, toStageTraffic } from '../src/telemetry/query.ts';
import { awsLayer, memoryStore } from './support.ts';

const now = Date.parse('2026-11-16T07:30:00.000Z');
const MINUTE = 60_000;

const shop: AppRecord = {
  name: 'shop',
  repo: 'bob/shop',
  owners: ['bob'],
  createdBy: 'bob',
  createdAt: '2026-11-01T00:00:00Z',
};

const live = (over: Partial<DeploymentItem> = {}): DeploymentItem => ({
  id: 'd1',
  app: 'shop',
  stage: 'prod',
  status: 'succeeded',
  actor: 'bob',
  commit: 'abc1234',
  manifest: parseManifest({ name: 'shop', web: { server: 'src/server.ts' } }),
  sdk: '0.4.0',
  compute: 'request',
  events: [],
  createdAt: '2026-11-10T00:00:00.000Z',
  ...over,
});

const prod = (over: Partial<StageItem> = {}): StageItem => ({
  app: 'shop',
  stage: 'prod',
  host: 'shop.example.com',
  url: 'https://shop.example.com',
  status: 'active',
  preview: false,
  currentDeployment: 'd1',
  compute: 'request',
  route: { v: 1, app: 'shop', stage: 'prod', d: 'd1', o: 'u.lambda-url.example', c: 'r', k: 's' },
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-10T00:00:00.000Z',
  ...over,
});

/** Busy all day, every minute: overlapping requests, which a Web Function serves for less. */
const busy: MinuteTraffic[] = Array.from({ length: 3 * 1440 }, (_, i) => ({
  ts: now - (3 * 1440 - i) * MINUTE,
  req: 600,
  durMs: 300_000,
}));
/** Ten requests a day. */
const quiet: MinuteTraffic[] = Array.from({ length: 30 }, (_, i) => ({
  ts: now - (30 - i) * 144 * MINUTE,
  req: 1,
  durMs: 40,
}));

describe('decideCompute', () => {
  it('prices both modes and counts a day toward a switch on auto', () => {
    const d = decideCompute({ stage: prod(), live: live(), traffic: { minutes: busy }, now });
    assert.isFalse('skip' in d);
    if ('skip' in d) return;
    assert.strictEqual(d.current, 'request');
    assert.isBelow(d.estimate.instance.monthlyUsd, d.estimate.request.monthlyUsd * 0.75);
    assert.deepStrictEqual(d.streak, { to: 'instance', days: 1, day: '2026-11-16' });
    assert.isUndefined(d.switchTo);
  });

  it('switches on the third day running', () => {
    const d = decideCompute({
      stage: prod({ computeStreak: { to: 'instance', days: 2, day: '2026-11-15' } }),
      live: live(),
      traffic: { minutes: busy },
      now,
    });
    assert.deepStrictEqual('switchTo' in d && d.switchTo, 'instance');
  });

  it('moves a quiet stage back to request mode only on an account with the concurrency for it', () => {
    const due = (accountConcurrency: number) =>
      decideCompute({
        stage: prod({ compute: 'instance', computeStreak: { to: 'request', days: 2, day: '2026-11-15' } }),
        live: live(),
        traffic: { minutes: quiet },
        accountConcurrency,
        now,
      });
    const open = due(1000);
    assert.isTrue(!('skip' in open) && open.switchTo === 'request');
    const held = due(10);
    assert.isTrue(!('skip' in held) && held.switchTo === undefined && held.estimate !== undefined);
  });

  it('only estimates a stage that set its mode, and keeps a quiet stage where it is', () => {
    const fixed = decideCompute({
      stage: prod({ compute: 'instance', computeStreak: { to: 'request', days: 2, day: '2026-11-15' } }),
      live: live({
        manifest: parseManifest({ name: 'shop', web: { server: 'src/server.ts', compute: 'instance' } }),
      }),
      traffic: { minutes: quiet },
      now,
    });
    assert.isFalse('skip' in fixed);
    assert.isTrue(!('skip' in fixed) && fixed.streak === undefined && fixed.switchTo === undefined);

    const stays = decideCompute({ stage: prod(), live: live(), traffic: { minutes: quiet }, now });
    assert.isTrue(!('skip' in stays) && stays.streak === undefined);
  });

  it('skips stages it can’t compare', () => {
    const skip = (d: ReturnType<typeof decideCompute>) => ('skip' in d ? d.skip : undefined);
    assert.strictEqual(
      skip(
        decideCompute({
          stage: prod(),
          live: live({ manifest: parseManifest({ name: 'shop', web: { static: 'dist' } }) }),
          traffic: { minutes: busy },
          now,
        }),
      ),
      'no server',
    );
    assert.strictEqual(
      skip(decideCompute({ stage: prod(), live: live({ sdk: undefined }), traffic: { minutes: busy }, now })),
      'built with an SDK before request mode',
    );
  });

  it('explains a switch in the deployment history', () => {
    const d = decideCompute({ stage: prod(), live: live(), traffic: { minutes: busy }, now });
    if ('skip' in d) throw new Error('skipped');
    assert.match(
      switchMessage('request', 'instance', d.estimate),
      /^Compute switch to instance mode: ≈ \$\d+\.\d{2} a month against ≈ \$\d+\.\d{2} in request mode, from the last 3 days of traffic$/,
    );
  });
});

describe('the chooser’s traffic', () => {
  it('reads busy minutes, falling back to the latency histogram for older rows', () => {
    const traffic = toStageTraffic([
      { sk: '2026-11-16T07:00:00.000Z', req: 3, dur: 120, webInitMs: 1100, webInits: 2 },
      // Three requests in the 25–50 ms bucket and one in the 100–250 ms one.
      { sk: '2026-11-16T07:01:00.000Z', req: 4, l3: 3, l5: 1 },
      { sk: '2026-11-16T07:02:00.000Z', webStarts: 1 },
    ]);
    assert.deepStrictEqual(traffic, {
      minutes: [
        { ts: Date.parse('2026-11-16T07:00:00.000Z'), req: 3, durMs: 120 },
        { ts: Date.parse('2026-11-16T07:01:00.000Z'), req: 4, durMs: 3 * 37.5 + 175 },
      ],
      initMs: 550,
    });
  });
});

describe('ComputeChooser.run', () => {
  const setup = (options: {
    stages: ReadonlyArray<StageItem>;
    deployments: ReadonlyArray<DeploymentItem>;
    minutes: ReadonlyArray<MinuteTraffic>;
    expired?: boolean;
  }) => {
    const invoked: Array<{ name: string; payload: unknown }> = [];
    const metricCalls: GetMetricDataCommand[] = [];
    const cloudwatch = {
      send: (command: GetMetricDataCommand) => {
        metricCalls.push(command);
        return Promise.resolve({ MetricDataResults: [{ Id: 'memory', Values: [180, 210] }] });
      },
    } as unknown as CloudWatchClient;
    const layer = ComputeChooser.layer.pipe(
      Layer.provide([
        awsLayer({ cloudwatch: () => cloudwatch }),
        Layer.mock(TelemetryQuery, {
          stageTraffic: () => Effect.succeed({ minutes: options.minutes }),
        }),
        Layer.mock(Artifacts, {
          locate: (ref, file) =>
            Effect.succeed(
              options.expired
                ? Option.none()
                : Option.some({ bucket: 'artifacts', key: `${ref.deployment}/${file}` }),
            ),
        }),
        Layer.mock(WorkerJobs, {
          start: ({ kind, ...payload }) => Effect.sync(() => void invoked.push({ name: kind, payload })),
        }),
      ]),
      Layer.provideMerge(
        memoryStore({ apps: [shop], stages: options.stages, deployments: options.deployments }),
      ),
    );
    return { layer, invoked, metricCalls };
  };

  it.effect('keeps the estimate and streak on the stage', () => {
    const t = setup({ stages: [prod()], deployments: [live()], minutes: busy });
    return Effect.gen(function* () {
      yield* TestClock.setTime(now);
      const result = yield* ComputeChooser.use((c) => c.run);
      assert.deepStrictEqual(result, { estimated: 1, switched: [] });
      const stage = Option.getOrThrow(yield* (yield* Store).getStage('shop', 'prod'));
      assert.strictEqual(stage.computeEstimate?.at, '2026-11-16T07:30:00.000Z');
      assert.deepStrictEqual(stage.computeStreak, { to: 'instance', days: 1, day: '2026-11-16' });
      // The Web Function's measured memory prices instance mode.
      const query = t.metricCalls[0]?.input.MetricDataQueries?.[0]?.MetricStat;
      assert.deepStrictEqual(
        [query?.Metric?.Namespace, query?.Metric?.MetricName, query?.Metric?.Dimensions, query?.Stat],
        [
          'AWS/Lambda/Web',
          'EnvironmentMaxMemoryUsage',
          [{ Name: 'FunctionName', Value: 'shop--prod' }],
          'Maximum',
        ],
      );
      assert.deepStrictEqual(t.invoked, []);
    }).pipe(Effect.provide(t.layer));
  });

  it.effect('switches a stage due, as a platform deployment of the live build', () => {
    const t = setup({
      stages: [prod({ computeStreak: { to: 'instance', days: 2, day: '2026-11-15' } })],
      // The live deployment is itself a switch: the build is still the one d0 uploaded.
      deployments: [live({ computeSwitchOf: 'd0' })],
      minutes: busy,
    });
    return Effect.gen(function* () {
      yield* TestClock.setTime(now);
      const result = yield* ComputeChooser.use((c) => c.run);
      assert.deepStrictEqual(result.switched, ['shop/prod']);
      const store = yield* Store;
      const created = (yield* store.listDeployments('shop')).find((d) => d.id !== 'd1');
      assert.deepInclude(created, {
        status: 'queued',
        actor: 'platform',
        commit: 'abc1234',
        sdk: '0.4.0',
        compute: 'instance',
        computeSwitchOf: 'd0',
      });
      assert.match(created?.message ?? '', /^Compute switch to instance mode/);
      assert.deepStrictEqual(t.invoked, [{ name: 'deploy', payload: { id: created?.id } }]);
      const stage = Option.getOrThrow(yield* store.getStage('shop', 'prod'));
      assert.strictEqual(stage.status, 'deploying');
      assert.isUndefined(stage.computeStreak);
    }).pipe(Effect.provide(t.layer));
  });

  it.effect('keeps a switch due when the live build has expired', () => {
    const t = setup({
      stages: [prod({ computeStreak: { to: 'instance', days: 2, day: '2026-11-15' } })],
      deployments: [live()],
      minutes: busy,
      expired: true,
    });
    return Effect.gen(function* () {
      yield* TestClock.setTime(now);
      assert.deepStrictEqual((yield* ComputeChooser.use((c) => c.run)).switched, []);
      const store = yield* Store;
      assert.strictEqual((yield* store.listDeployments('shop')).length, 1);
      const stage = Option.getOrThrow(yield* store.getStage('shop', 'prod'));
      assert.deepStrictEqual(stage.computeStreak, { to: 'instance', days: 3, day: '2026-11-16' });
      assert.strictEqual(stage.status, 'active');
    }).pipe(Effect.provide(t.layer));
  });

  it.effect('leaves previews, stages being deployed and stages without a server alone', () => {
    const stale = {
      at: '2026-11-10T07:30:00.000Z',
      request: { monthlyUsd: 1, coldStartsPerMonth: 1 },
      instance: { monthlyUsd: 1, environmentHoursPerMonth: 1 },
      requestsPerMonth: 1,
      days: 3,
    };
    const t = setup({
      stages: [
        prod({ stage: 'pr-3', preview: true }),
        prod({ app: 'blog', status: 'deploying' }),
        // Its server went away since its last estimate.
        prod({ app: 'docs', currentDeployment: 'd9', computeEstimate: stale }),
      ],
      deployments: [
        live(),
        live({ id: 'd9', app: 'docs', manifest: parseManifest({ name: 'docs', web: { static: 'dist' } }) }),
      ],
      minutes: busy,
    });
    return Effect.gen(function* () {
      yield* TestClock.setTime(now);
      // Only docs/prod is looked at, and it has no server to price.
      assert.deepStrictEqual(yield* ComputeChooser.use((c) => c.run), { estimated: 1, switched: [] });
      assert.deepStrictEqual(t.metricCalls, []);
      const docs = Option.getOrThrow(yield* (yield* Store).getStage('docs', 'prod'));
      assert.isUndefined(docs.computeEstimate);
    }).pipe(Effect.provide(t.layer));
  });
});

describe('the Cost tab', () => {
  it('lists servers with their mode, setting and estimate', () => {
    const estimate = {
      at: '2026-11-16T07:30:00.000Z',
      request: { monthlyUsd: 0.01, coldStartsPerMonth: 300 },
      instance: { monthlyUsd: 3, environmentHoursPerMonth: 30 },
      requestsPerMonth: 300,
      days: 3,
    };
    assert.deepStrictEqual(stageComputeCost(prod({ computeEstimate: estimate }), live()), [
      { stage: 'prod', setting: 'auto', compute: 'request', estimate },
    ]);
    // Deployed before servers had modes: the route tells.
    assert.deepStrictEqual(
      stageComputeCost(
        prod({ compute: undefined, route: { v: 1, app: 'shop', stage: 'prod', d: 'd1', o: 'x' } }),
        live(),
      ),
      [{ stage: 'prod', setting: 'auto', compute: 'instance' }],
    );
    assert.deepStrictEqual(
      stageComputeCost(prod(), live({ manifest: parseManifest({ name: 'shop', web: { static: 'dist' } }) })),
      [],
    );
  });
});
