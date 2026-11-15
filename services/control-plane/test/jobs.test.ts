import { describe, expect, it } from 'vitest';
import { safeRedirect } from '../src/api/session.ts';
import { hostConflict, type Resolver } from '../src/dns.ts';
import { waitForEdge } from '../src/edge.ts';
import { PLATFORM_COST_KEY, parseCostResults, TOTAL_COST_KEY } from '../src/jobs/cost.ts';
import { nextUptimeState } from '../src/jobs/pinger.ts';
import { stalePreviews } from '../src/jobs/reaper.ts';
import { STUCK_AFTER_MS, stuckDeployments, suspectStages } from '../src/jobs/watchdog.ts';
import { describe as describeEvent, runtimeRecord, toFilterPattern, toLogLine } from '../src/logs.ts';
import type { DeploymentItem, StageItem } from '../src/store.ts';

describe('uptime state', () => {
  it('needs two failures before going down and alerts once', () => {
    let s = nextUptimeState({}, false);
    expect(s).toEqual({ up: true, failures: 1, transition: null });
    s = nextUptimeState(s, false);
    expect(s).toEqual({ up: false, failures: 2, transition: 'down' });
    s = nextUptimeState(s, false);
    expect(s).toEqual({ up: false, failures: 3, transition: null });
    expect(nextUptimeState(s, true)).toEqual({ up: true, failures: 0, transition: 'up' });
    expect(nextUptimeState({ up: true }, true).transition).toBeNull();
  });
});

describe('cost parsing', () => {
  it('splits by app tag and totals', () => {
    const parsed = parseCostResults([
      {
        TimePeriod: { Start: '2026-11-01', End: '2026-11-02' },
        Groups: [
          { Keys: ['platform:app$todo'], Metrics: { UnblendedCost: { Amount: '0.12', Unit: 'USD' } } },
          { Keys: ['platform:app$'], Metrics: { UnblendedCost: { Amount: '0.50', Unit: 'USD' } } },
        ],
      },
    ]);
    expect(parsed.get('todo')?.get('2026-11-01')).toBeCloseTo(0.12);
    expect(parsed.get(PLATFORM_COST_KEY)?.get('2026-11-01')).toBeCloseTo(0.5);
    expect(parsed.get(TOTAL_COST_KEY)?.get('2026-11-01')).toBeCloseTo(0.62);
  });
});

describe('reaper', () => {
  const stage = (s: string, updatedAt: string, status: StageItem['status'] = 'active'): StageItem => ({
    app: 'todo',
    stage: s,
    host: 'h',
    url: 'u',
    status,
    preview: s.startsWith('pr-'),
    createdAt: updatedAt,
    updatedAt,
  });
  it('only reaps old, live preview stages', () => {
    const now = Date.parse('2026-11-14T00:00:00Z');
    const out = stalePreviews(
      [
        stage('prod', '2026-01-01T00:00:00Z'),
        stage('pr-1', '2026-11-01T00:00:00Z'),
        stage('pr-2', '2026-11-13T00:00:00Z'),
        stage('pr-3', '2026-11-01T00:00:00Z', 'destroyed'),
      ],
      7,
      now,
    );
    expect(out.map((s) => s.stage)).toEqual(['pr-1']);
  });
});

describe('dns conflicts', () => {
  const none = Object.assign(new Error('no data'), { code: 'ENODATA' });
  const resolver = (over: Partial<Resolver>): Resolver => ({
    resolveNs: async () => Promise.reject(none),
    resolveCname: async () => Promise.reject(none),
    resolve4: async () => Promise.reject(none),
    ...over,
  });
  it('accepts free names and the platform wildcard', async () => {
    expect(await hostConflict('a.example.com', 'edge.example.com', resolver({}))).toBeNull();
    expect(
      await hostConflict(
        'a.example.com',
        'edge.example.com',
        resolver({ resolveCname: async () => ['edge.example.com.'] }),
      ),
    ).toBeNull();
  });
  it('rejects delegations, foreign CNAMEs and A records', async () => {
    expect(await hostConflict('a.example.com', 'e', resolver({ resolveNs: async () => ['ns1'] }))).toMatch(
      /delegated/,
    );
    expect(
      await hostConflict('a.example.com', 'e', resolver({ resolveCname: async () => ['x.github.io'] })),
    ).toMatch(/points at x.github.io/);
    expect(await hostConflict('a.example.com', 'e', resolver({ resolve4: async () => ['1.2.3.4'] }))).toMatch(
      /A record/,
    );
  });
});

describe('logs', () => {
  it('turns telemetry lines into readable log lines', () => {
    const line = toLogLine(
      'web',
      0,
      JSON.stringify({
        _p: 1,
        t: 'req',
        ts: 1000,
        app: 'a',
        stage: 'prod',
        rev: 'd',
        method: 'GET',
        route: '/',
        path: '/',
        status: 503,
        dur: 12,
        trace: 'abc',
      }),
    );
    expect(line).toMatchObject({ level: 'error', message: 'GET / 503 12ms', trace: 'abc', stream: 'web' });
    expect(toLogLine('worker', 5, 'plain text\n')).toEqual({
      ts: new Date(5).toISOString(),
      stream: 'worker',
      message: 'plain text',
    });
    expect(
      describeEvent({
        _p: 1,
        t: 'metric',
        ts: 0,
        app: 'a',
        stage: 's',
        rev: 'r',
        name: 'n',
        value: 3,
        unit: 'ms',
      }),
    ).toBe('metric n=3ms');
  });
  it('builds filter patterns', () => {
    expect(toFilterPattern(undefined)).toBeUndefined();
    expect(toFilterPattern('timeout')).toBe('"timeout"');
    expect(toFilterPattern('{ $.status = 500 }')).toBe('{ $.status = 500 }');
  });
});

describe('redirects', () => {
  it('only allows same-origin paths', () => {
    expect(safeRedirect('/apps/todo')).toBe('/apps/todo');
    expect(safeRedirect('//evil.com')).toBe('/');
    expect(safeRedirect('https://evil.com')).toBe('/');
    expect(safeRedirect(undefined)).toBe('/');
  });
});

describe('watchdog', () => {
  const now = Date.parse('2026-11-15T12:00:00Z');
  const ago = (ms: number) => new Date(now - ms).toISOString();
  const dep = (
    id: string,
    status: DeploymentItem['status'],
    startedMsAgo: number,
    stage = 'prod',
  ): DeploymentItem => ({
    id,
    app: 'shop',
    stage,
    status,
    actor: 'eric-minassian',
    events: [],
    createdAt: ago(startedMsAgo + 1000),
    startedAt: ago(startedMsAgo),
  });

  it('fails only in-flight deployments of that stage older than the worker can run', () => {
    const deps = [
      dep('old-running', 'running', STUCK_AFTER_MS + 1),
      dep('old-queued', 'queued', STUCK_AFTER_MS + 60_000),
      dep('fresh', 'running', 60_000),
      dep('done', 'succeeded', STUCK_AFTER_MS * 3),
      dep('other-stage', 'running', STUCK_AFTER_MS * 2, 'pr-3'),
    ];
    expect(stuckDeployments(deps, 'prod', now).map((d) => d.id)).toEqual(['old-running', 'old-queued']);
  });

  it('only suspects stages left deploying past the cutoff', () => {
    const stage = (name: string, status: StageItem['status'], msAgo: number): StageItem => ({
      app: 'shop',
      stage: name,
      host: `shop--${name}.example.com`,
      url: `https://shop--${name}.example.com`,
      status,
      preview: name !== 'prod',
      createdAt: ago(msAgo),
      updatedAt: ago(msAgo),
    });
    const stages = [
      stage('prod', 'deploying', STUCK_AFTER_MS + 1),
      stage('pr-1', 'deploying', 60_000),
      stage('pr-2', 'active', STUCK_AFTER_MS * 5),
    ];
    expect(suspectStages(stages, now).map((s) => s.stage)).toEqual(['prod']);
  });
});

describe('edge wait', () => {
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

  it('resolves once the edge serves the new deployment', async () => {
    const answers = [reply(404, {}), reply(200, { revision: 'd-old' }), reply(200, { revision: 'd-new' })];
    const fetch = (async () =>
      answers.shift() ?? reply(200, { revision: 'd-new' })) as typeof globalThis.fetch;
    expect(await waitForEdge('https://x.example.com', 'd-new', { fetch, intervalMs: 1 })).toBe(true);
    expect(answers).toHaveLength(0);
  });

  it('gives up at the deadline without throwing', async () => {
    const fetch = (async () => {
      throw new Error('ENOTFOUND');
    }) as typeof globalThis.fetch;
    expect(await waitForEdge('https://x.example.com', 'd', { fetch, timeoutMs: 20, intervalMs: 5 })).toBe(
      false,
    );
  });
});

describe('runtime records', () => {
  it('summarizes Lambda runtime JSON as system lines', () => {
    const summary = JSON.stringify({
      type: 'platform.invokeSummary',
      record: { metrics: { requests: 6, cpuTimeMs: 209, maxMemoryUsageMb: 218 } },
    });
    expect(toLogLine('web', 1, summary)).toEqual({
      ts: new Date(1).toISOString(),
      stream: 'web',
      level: 'system',
      message: 'runtime: 6 requests in the last minute, 209 ms CPU, 218 MB',
    });
    expect(
      runtimeRecord(
        JSON.stringify({
          type: 'platform.initReport',
          record: { status: 'success', metrics: { totalDurationMs: 416 } },
        }),
      ),
    ).toBe('runtime: init success in 416 ms');
    expect(runtimeRecord('{"t":"req","_p":1}')).toBeUndefined();
    expect(runtimeRecord('plain text')).toBeUndefined();
  });
});
