import type { CloudWatchClient, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { assert, it as effect } from '@effect/vitest';
import { estimateContainerCost, parseManifest } from '@ericminassian/platform-core';
import type { ServiceRuntimeState } from '@ericminassian/platform-engine';
import { Effect, Layer } from 'effect';
import { describe, expect, it } from 'vitest';
import { StageEngine } from '../src/deploy.ts';
import {
  AppServices,
  alwaysOnCosts,
  FAILING_WINDOW_MS,
  serviceState,
  stoppedOnFailure,
  toServiceInfo,
  toUsagePoints,
  usageQueries,
} from '../src/jobs/services.ts';
import { TelemetryQuery } from '../src/telemetry/query.ts';
import { awsLayer, runtime, settingsLayer } from './support.ts';

const now = Date.parse('2026-11-16T12:00:00Z');
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

const ecs = (over: Partial<ServiceRuntimeState> = {}): ServiceRuntimeState => ({
  name: 'ais',
  desired: 1,
  running: 1,
  pending: 0,
  rollout: 'completed',
  events: [],
  ...over,
});

const { services } = parseManifest({
  name: 'shop',
  services: {
    ais: { entry: 'src/ais.ts' },
    feeds: { entry: 'src/feeds.ts', cpu: 1, memoryMb: 2048, spot: false },
  },
});

const containers = {
  cluster: 'platform',
  subnets: ['subnet-1'],
  securityGroups: ['sg-1'],
  repository: 'platform-containers',
  repositoryUri: '000000000000.dkr.ecr.us-east-1.amazonaws.com/platform-containers',
  executionRoleArn: 'arn:aws:iam::000000000000:role/platform/platform-container-execution',
  schedulerRoleArn: 'arn:aws:iam::000000000000:role/platform/platform-container-scheduler',
};

describe('service state', () => {
  it('is stopped at zero tasks, or when ECS has no such service', () => {
    expect(serviceState(ecs({ desired: 0, running: 0, rollout: 'failed' }), now)).toBe('stopped');
    expect(serviceState(undefined, now)).toBe('stopped');
  });

  it('is running once every task is up and the rollout finished', () => {
    expect(serviceState(ecs(), now)).toBe('running');
    // ECS reports no rollout state for some deployments; the task count decides then.
    expect(serviceState(ecs({ rollout: undefined }), now)).toBe('running');
    expect(serviceState(ecs({ rollout: 'in_progress' }), now)).toBe('starting');
  });

  it('is failing when the rollout failed or tasks keep stopping on failures', () => {
    expect(serviceState(ecs({ rollout: 'failed' }), now)).toBe('failing');
    const crashed = { at: ago(3), reason: 'Essential container in task exited', exitCode: 1 };
    expect(serviceState(ecs({ running: 0, pending: 1, lastStop: crashed }), now)).toBe('failing');
    // A task that never ran (no exit code) failed too.
    const pull = { at: ago(1), reason: 'CannotPullContainerError: pull image manifest has been retried' };
    expect(serviceState(ecs({ running: 0, lastStop: pull }), now)).toBe('failing');
    // Long enough ago, it's a replacement starting.
    const old = { ...crashed, at: new Date(now - FAILING_WINDOW_MS - 1).toISOString() };
    expect(serviceState(ecs({ running: 0, lastStop: old }), now)).toBe('starting');
  });

  it('is starting while a requested stop is replaced', () => {
    for (const reason of [
      'Scaling activity initiated by (deployment ecs-svc/123)',
      'Task stopped by user',
      'Your Spot Task was interrupted.',
    ]) {
      expect(stoppedOnFailure({ reason, exitCode: 143 })).toBe(false);
      expect(serviceState(ecs({ running: 0, lastStop: { at: ago(1), reason, exitCode: 143 } }), now)).toBe(
        'starting',
      );
    }
    expect(stoppedOnFailure({ reason: 'Essential container in task exited', exitCode: 0 })).toBe(false);
  });
});

describe('service info', () => {
  it('combines the declared size, ECS state, usage and runs', () => {
    const info = toServiceInfo({
      name: 'feeds',
      config: services.feeds!,
      runtime: ecs({
        name: 'feeds',
        deploymentId: 'd1',
        startedAt: ago(30),
        events: [{ at: ago(31), message: 'has reached a steady state.' }],
      }),
      points: [{ ts: ago(1), cpu: 4.2, memory: 31 }],
      runs: { starts: 2, failedRuns: 1 },
      now,
    });
    expect(info).toEqual({
      name: 'feeds',
      cpu: 1,
      memoryMb: 2048,
      spot: false,
      state: 'running',
      desired: 1,
      running: 1,
      pending: 0,
      deployment: 'd1',
      startedAt: ago(30),
      events: [{ at: ago(31), message: 'has reached a steady state.' }],
      starts: 2,
      failedRuns: 1,
      points: [{ ts: ago(1), cpu: 4.2, memory: 31 }],
      monthly: estimateContainerCost({ cpu: 1, memoryMb: 2048, spot: false }),
    });
    const missing = toServiceInfo({
      name: 'ais',
      config: services.ais!,
      runtime: undefined,
      points: [],
      runs: undefined,
      now,
    });
    expect([missing.state, missing.desired, missing.running, missing.starts]).toEqual(['stopped', 0, 0, 0]);
  });

  it('prices each service as if it ran all month', () => {
    expect(alwaysOnCosts('prod', services)).toEqual([
      {
        stage: 'prod',
        kind: 'service',
        name: 'ais',
        detail: '0.25 vCPU · 512 MB · Spot',
        monthly: { computeUsd: 2.21, publicIpv4Usd: 3.65, totalUsd: 5.86 },
      },
      {
        stage: 'prod',
        kind: 'service',
        name: 'feeds',
        detail: '1 vCPU · 2048 MB · on-demand',
        monthly: estimateContainerCost({ cpu: 1, memoryMb: 2048, spot: false }),
      },
    ]);
  });

  it('reads CPU and memory per service into dense series', () => {
    const range = { from: now - 3 * 60_000, to: now, res: '1m' as const };
    const queries = usageQueries('platform', 'shop', 'prod', ['ais', 'feeds'], range);
    expect(queries.map((q) => [q.Id, q.MetricStat.Metric.MetricName, q.MetricStat.Period])).toEqual([
      ['c0', 'CPUUtilization', 60],
      ['m0', 'MemoryUtilization', 60],
      ['c1', 'CPUUtilization', 60],
      ['m1', 'MemoryUtilization', 60],
    ]);
    expect(queries[2]?.MetricStat.Metric.Dimensions).toEqual([
      { Name: 'ClusterName', Value: 'platform' },
      { Name: 'ServiceName', Value: 'shop--prod--feeds' },
    ]);
    const points = toUsagePoints(
      [
        { Id: 'c0', Timestamps: [new Date(now - 60_000)], Values: [12.345] },
        { Id: 'm0', Timestamps: [new Date(now - 60_000), new Date(now)], Values: [40, 41] },
      ],
      ['ais', 'feeds'],
      range,
    );
    expect(points.get('ais')).toEqual([
      { ts: ago(3), cpu: null, memory: null },
      { ts: ago(2), cpu: null, memory: null },
      { ts: ago(1), cpu: 12.3, memory: 40 },
      { ts: ago(0), cpu: null, memory: 41 },
    ]);
    expect(points.get('feeds')?.every((p) => p.cpu === null && p.memory === null)).toBe(true);
  });

  effect.effect(
    'asks the engine, CloudWatch and telemetry, and leaves the chart empty if CloudWatch fails',
    () =>
      Effect.gen(function* () {
        const sent: GetMetricDataCommand[] = [];
        let cloudWatchFails = false;
        const cloudwatch = {
          send: (command: GetMetricDataCommand) => {
            sent.push(command);
            return cloudWatchFails
              ? Promise.reject(Object.assign(new Error('rate exceeded'), { name: 'Throttling' }))
              : Promise.resolve({
                  MetricDataResults: [{ Id: 'c0', Timestamps: [new Date(now - 3_600_000)], Values: [3] }],
                });
          },
        } as unknown as CloudWatchClient;
        const asked: Array<{ app: string; stage: string; cluster?: string }> = [];
        const layer = AppServices.layer.pipe(
          Layer.provide([
            awsLayer({ cloudwatch: () => cloudwatch }),
            settingsLayer({ runtime: Effect.succeed({ ...runtime, containers }) }),
            Layer.mock(StageEngine, {
              describeServices: (input) =>
                Effect.sync(() => {
                  asked.push({
                    app: input.app,
                    stage: input.stage,
                    cluster: input.platform.containers?.cluster,
                  });
                  return [ecs()];
                }),
            }),
            Layer.mock(TelemetryQuery, {
              serviceRuns: () => Effect.succeed(new Map([['ais', { starts: 4, failedRuns: 0 }]])),
            }),
          ]),
        );
        const range = { from: now - 2 * 3_600_000, to: now, res: '1h' as const };
        const stats = AppServices.use((s) => s.stats('shop', 'prod', services, range)).pipe(
          Effect.provide(layer),
        );

        const ok = yield* stats;
        assert.deepStrictEqual(asked, [{ app: 'shop', stage: 'prod', cluster: 'platform' }]);
        assert.strictEqual(ok.res, '1h');
        assert.deepStrictEqual(
          ok.services.map((s) => [s.name, s.state, s.starts]),
          [
            ['ais', 'running', 4],
            ['feeds', 'stopped', 0],
          ],
        );
        assert.deepStrictEqual(ok.services[0]?.points[1], { ts: ago(60), cpu: 3, memory: null });
        assert.strictEqual(sent[0]?.input.MetricDataQueries?.length, 4);

        cloudWatchFails = true;
        const degraded = yield* stats;
        assert.strictEqual(degraded.services[0]?.state, 'running');
        assert.isTrue(degraded.services[0]?.points.every((p) => p.cpu === null));
      }),
  );
});
