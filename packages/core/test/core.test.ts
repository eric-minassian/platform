import { describe, expect, it } from 'vitest';
import { buildRouterFunctionCode } from '../src/cloudfront-function.ts';
import {
  decide,
  errorFingerprint,
  latencyBucket,
  names,
  newDeploymentId,
  parseManifest,
  parseStageHost,
  percentile,
  type RouteRecord,
  stageHost,
  toSchedulerExpression,
  validateAppName,
  validateStageName,
} from '../src/index.ts';

describe('naming', () => {
  it('validates app and stage names', () => {
    expect(validateAppName('todo')).toBeNull();
    expect(validateAppName('my-app2')).toBeNull();
    expect(validateAppName('ab')).toMatch(/3-30/);
    expect(validateAppName('a--b')).toMatch(/single hyphens/);
    expect(validateAppName('platform')).toMatch(/reserved/);
    expect(validateAppName('orbit', ['orbit'])).toMatch(/reserved/);
    expect(validateStageName('prod')).toBeNull();
    expect(validateStageName('pr-12')).toBeNull();
    expect(validateStageName('PR')).not.toBeNull();
  });

  it('round-trips hosts', () => {
    expect(stageHost('foo', 'prod', 'example.com')).toBe('foo.example.com');
    expect(stageHost('foo', 'pr-12', 'example.com')).toBe('foo--pr-12.example.com');
    expect(parseStageHost('foo--pr-12.example.com', 'example.com')).toEqual({ app: 'foo', stage: 'pr-12' });
    expect(parseStageHost('foo.example.com:443', 'example.com')).toEqual({ app: 'foo', stage: 'prod' });
    expect(parseStageHost('a.b.example.com', 'example.com')).toBeNull();
    expect(parseStageHost('foo.other.com', 'example.com')).toBeNull();
  });

  it('keeps resource names within AWS limits', () => {
    const app = 'a'.repeat(30);
    const stage = 'b'.repeat(20);
    expect(names.workerFunction(app, stage).length).toBeLessThanOrEqual(64);
    expect(names.deadLetterQueue(app, stage, 'c'.repeat(20)).length).toBeLessThanOrEqual(80);
    expect(names.eventRule(app, stage, 'x'.repeat(60)).length).toBeLessThanOrEqual(64);
  });
});

describe('cron', () => {
  it('converts unix cron to EventBridge Scheduler syntax', () => {
    expect(toSchedulerExpression('0 8 * * *')).toBe('cron(0 8 * * ? *)');
    expect(toSchedulerExpression('*/5 * * * *')).toBe('cron(*/5 * * * ? *)');
    expect(toSchedulerExpression('0 9 * * 1-5')).toBe('cron(0 9 ? * 2-6 *)');
    expect(toSchedulerExpression('0 9 * * 0')).toBe('cron(0 9 ? * 1 *)');
    expect(toSchedulerExpression('rate(5 minutes)')).toBe('rate(5 minutes)');
    expect(() => toSchedulerExpression('bad')).toThrow();
  });
});

describe('manifest', () => {
  it('applies defaults and derives the worker', () => {
    const m = parseManifest({
      name: 'todo',
      db: true,
      queues: { emails: {} },
      web: { server: 'src/server.ts' },
    });
    expect(m.worker?.entry).toBe('src/worker.ts');
    expect(m.queues.emails?.visibilityTimeoutSeconds).toBe(360);
    expect(m.auth).toEqual({ enabled: false, required: false });
    expect(m.web?.serverRoutes).toEqual(['/api/']);
  });

  it('reports readable errors', () => {
    expect(() => parseManifest({ name: 'x', crons: { nightly: 'nope' } })).toThrow(/name.*crons\.nightly/s);
  });
});

describe('router decide', () => {
  const both: RouteRecord = {
    v: 1,
    app: 'a',
    stage: 'prod',
    d: 'd1',
    o: 'fn.example',
    s: 'a/prod/d1',
    r: ['/api/'],
    spa: 1,
  };
  it('routes api, files and spa fallbacks', () => {
    expect(decide(both, '/api/todos')).toEqual({ t: 'server' });
    expect(decide(both, '/api')).toEqual({ t: 'server' });
    expect(decide(both, '/__platform/health')).toEqual({ t: 'server' });
    expect(decide(both, '/assets/app.js')).toEqual({ t: 'static', key: '/a/prod/d1/assets/app.js' });
    expect(decide(both, '/settings')).toEqual({ t: 'static', key: '/a/prod/d1/index.html' });
  });
  it('handles server-only, static-only and ssr', () => {
    expect(decide({ v: 1, app: 'a', stage: 'p', d: 'd', o: 'fn' }, '/x')).toEqual({ t: 'server' });
    expect(decide({ v: 1, app: 'a', stage: 'p', d: 'd', s: 'p' }, '/__platform/health')).toEqual({
      t: 'notfound',
    });
    expect(decide({ v: 1, app: 'a', stage: 'p', d: 'd', s: 'p' }, '/docs/')).toEqual({
      t: 'static',
      key: '/p/docs/index.html',
    });
    expect(decide({ v: 1, app: 'a', stage: 'p', d: 'd', o: 'fn', s: 'p', r: [], spa: 0 }, '/page')).toEqual({
      t: 'server',
    });
    expect(decide(null, '/')).toEqual({ t: 'notfound' });
  });
  it('builds a CloudFront Function with the decision inlined', () => {
    const code = buildRouterFunctionCode({ kvsId: 'kvs-123' });
    expect(code).toContain('cf.kvs("kvs-123")');
    expect(code).toContain('function decide(rec, uri)');
    expect(code).not.toContain('export ');
    expect(code.length).toBeLessThan(10 * 1024);
    // Runtime 2.0 rejects `await` inside call arguments ("await in arguments not supported").
    expect(code).not.toMatch(/\(\s*await\b/);
  });
});

describe('telemetry', () => {
  it('computes percentiles from fixed buckets', () => {
    const hist = new Array(13).fill(0);
    for (const ms of [3, 8, 40, 40, 90, 200, 400, 900, 2000, 20000]) hist[latencyBucket(ms)]++;
    expect(percentile(hist, 50)).toBe(100);
    expect(percentile(hist, 95)).toBe(30000);
    expect(percentile([], 50)).toBeNull();
  });
  it('groups similar errors', () => {
    const a = errorFingerprint('Error', 'user 123 not found', 'Error\n    at handler (/app/src/x.ts:1:2)');
    const b = errorFingerprint('Error', 'user 456 not found', 'Error\n    at handler (/app/src/x.ts:9:9)');
    expect(a).toBe(b);
  });
  it('makes sortable deployment ids', () => {
    const a = newDeploymentId();
    expect(a).toMatch(/^d[0-9a-z]{26}$/);
  });
});
