import type { SNSClient } from '@aws-sdk/client-sns';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { assert, it as effect } from '@effect/vitest';
import type { TelemetryEvent } from '@ericminassian/platform-core';
import { Effect, Layer, Option } from 'effect';
import { describe, expect, it } from 'vitest';
import { GitHub } from '../src/github.ts';
import { aggregate, parseLogMessage, rollupUpdateInput } from '../src/telemetry/aggregate.ts';
import {
  parseRange,
  summarizeHealth,
  toJobStats,
  toMetricsPoints,
  toRouteStats,
} from '../src/telemetry/query.ts';
import { TelemetryWriter } from '../src/telemetry/write.ts';
import { awsLayer, githubApp, memoryStore, runtime, settingsLayer } from './support.ts';

const T = Date.parse('2026-11-14T10:15:30.000Z');
const base = { _p: 1 as const, app: 'todo', stage: 'prod', rev: 'd1' };

const req = (over: Partial<Extract<TelemetryEvent, { t: 'req' }>> = {}): TelemetryEvent => ({
  ...base,
  t: 'req',
  ts: T,
  method: 'GET',
  route: '/api/todos',
  path: '/api/todos',
  status: 200,
  dur: 42,
  ...over,
});

describe('parseLogMessage', () => {
  it('reads raw lines, text-format prefixes and JSON envelopes', () => {
    const line = JSON.stringify(req());
    expect(parseLogMessage(line)?.t).toBe('req');
    expect(parseLogMessage(`2026-11-14T10:15:30Z\tabc\tINFO\t${line}`)?.t).toBe('req');
    expect(parseLogMessage(JSON.stringify({ level: 'INFO', message: req() }))?.t).toBe('req');
    expect(parseLogMessage(JSON.stringify({ level: 'INFO', message: line }))?.t).toBe('req');
    expect(parseLogMessage('START RequestId: abc')).toBeNull();
    expect(parseLogMessage('{"not":"platform"}')).toBeNull();
  });
});

describe('aggregate', () => {
  it('merges requests into stage and route series per resolution', () => {
    const agg = aggregate([
      req(),
      req({ status: 500, dur: 900 }),
      req({ status: 404, dur: 3, cold: true, route: '/api/todos/:id', path: '/api/todos/7' }),
    ]);
    const minute = agg.rollups.find((r) => r.pk === 'm#todo#prod#1m');
    expect(minute).toMatchObject({ sk: '2026-11-14T10:15:00.000Z' });
    expect(minute!.add).toMatchObject({ req: 3, s2xx: 1, s4xx: 1, s5xx: 1, cold: 1, l0: 1, l3: 1, l7: 1 });
    expect(agg.rollups.filter((r) => r.pk.startsWith('m#'))).toHaveLength(3);
    const routes = agg.rollups.filter((r) => r.pk === 'r#todo#prod#1h');
    expect(routes.map((r) => r.sk).toSorted()).toEqual([
      '2026-11-14T10:00:00.000Z#GET /api/todos',
      '2026-11-14T10:00:00.000Z#GET /api/todos/:id',
    ]);
    // 1m TTL = 3 days after the bucket.
    expect(minute!.ttl).toBe(Math.floor(Date.parse('2026-11-14T10:15:00Z') / 1000) + 3 * 86400);
  });

  it('tracks jobs, metrics and environment starts', () => {
    const agg = aggregate([
      { ...base, t: 'job', ts: T, kind: 'queue', name: 'emails', status: 'ok', dur: 20 },
      { ...base, t: 'job', ts: T + 1000, kind: 'queue', name: 'emails', status: 'error', dur: 30 },
      { ...base, t: 'metric', ts: T, name: 'signup', value: 2 },
      { ...base, t: 'env', ts: T, event: 'start', runtime: 'web', initMs: 120 },
    ]);
    const job = agg.rollups.find((r) => r.pk === 'j#todo#prod#1h');
    expect(job!.add).toMatchObject({ ok: 1, error: 1 });
    expect(job!.set).toMatchObject({ kind: 'queue', name: 'emails', lastRun: T + 1000 });
    expect(agg.rollups.find((r) => r.pk === 'c#todo#prod#1d')!.add).toEqual({ count: 1, sum: 2 });
    expect(agg.rollups.find((r) => r.pk === 'm#todo#prod#1m')!.add).toEqual({ webStarts: 1 });
  });

  it('groups errors by fingerprint and keeps the latest sample', () => {
    const err = (ts: number, message: string): TelemetryEvent => ({
      ...base,
      t: 'err',
      ts,
      source: 'http',
      name: 'TypeError',
      message,
      fingerprint: 'abc',
      trace: `t${ts}`,
    });
    const agg = aggregate([err(T + 5, 'second'), err(T, 'first')]);
    expect(agg.errors).toHaveLength(1);
    expect(agg.errors[0]).toMatchObject({
      pk: 'e#todo#prod',
      sk: 'abc',
      count: 2,
      firstSeen: new Date(T).toISOString(),
      lastSeen: new Date(T + 5).toISOString(),
      message: 'second',
      sample: { trace: `t${T + 5}` },
    });
  });

  it('builds ADD/SET update expressions', () => {
    const input = rollupUpdateInput('tel', {
      pk: 'p',
      sk: 's',
      add: { req: 2 },
      set: { route: '/x' },
      ttl: 9,
    });
    expect(input.UpdateExpression).toBe('SET #ttl = :ttl, #s0 = :s0 ADD #a0 :a0');
    expect(input.ExpressionAttributeNames).toEqual({ '#ttl': 'ttl', '#a0': 'req', '#s0': 'route' });
    expect(input.ExpressionAttributeValues).toEqual({ ':ttl': 9, ':a0': 2, ':s0': '/x' });
  });
});

describe('query mapping', () => {
  it('parses ranges and picks resolutions', () => {
    expect(parseRange({ range: '1h' }, T)).toEqual({ from: T - 3_600_000, to: T, res: '1m' });
    expect(parseRange({ range: '7d' }, T).res).toBe('1h');
    expect(parseRange({ range: '90d' }, T).res).toBe('1d');
    expect(parseRange({ from: '2026-11-01T00:00:00Z', to: String(T), res: '1h' }, T).from).toBe(
      Date.parse('2026-11-01T00:00:00Z'),
    );
  });

  it('zero-fills metric points and computes percentiles', () => {
    const range = {
      from: Date.parse('2026-11-14T10:00:00Z'),
      to: Date.parse('2026-11-14T10:03:00Z'),
      res: '1m' as const,
    };
    const points = toMetricsPoints(
      [{ sk: '2026-11-14T10:01:00.000Z', req: 4, s2xx: 3, s5xx: 1, l3: 3, l7: 1 }],
      range,
    );
    expect(points).toHaveLength(4);
    expect(points[0]).toMatchObject({ req: 0, p50: null });
    expect(points[1]).toMatchObject({ req: 4, s2xx: 3, s5xx: 1, p50: 50, p99: 1000 });
  });

  it('sums route and job stats across buckets', () => {
    const routes = toRouteStats([
      { sk: 'a#GET /x', method: 'GET', route: '/x', req: 2, l2: 2 },
      { sk: 'b#GET /x', method: 'GET', route: '/x', req: 3, s5xx: 1, l2: 3 },
      { sk: 'b#POST /y', method: 'POST', route: '/y', req: 1, l5: 1 },
    ]);
    expect(routes[0]).toMatchObject({ route: '/x', req: 5, s5xx: 1, p95: 25 });
    expect(routes).toHaveLength(2);
    const jobs = toJobStats(
      [{ sk: 'a#cron:nightly', kind: 'cron', name: 'nightly', ok: 1, lastRun: T }],
      [
        { kind: 'cron', name: 'nightly' },
        { kind: 'queue', name: 'emails' },
      ],
    );
    expect(jobs).toEqual([
      { kind: 'cron', name: 'nightly', ok: 1, error: 0, p95: null, lastRun: new Date(T).toISOString() },
      { kind: 'queue', name: 'emails', ok: 0, error: 0, p95: null },
    ]);
  });

  it('summarizes last-hour health', () => {
    const range = { from: T - 120_000, to: T, res: '1m' as const };
    const items = [{ sk: new Date(T - 60_000 - (T % 60_000)).toISOString(), req: 10, s5xx: 1, l4: 10 }];
    const h = summarizeHealth(toMetricsPoints(items, range), items, true);
    expect(h).toMatchObject({ up: true, errorRate: 0.1, p95: 100 });
    expect(h.reqPerMin).toBeGreaterThan(0);
  });
});

describe('telemetry processor', () => {
  const err = (fingerprint: string, stage = 'prod'): TelemetryEvent => ({
    ...base,
    stage,
    t: 'err',
    ts: T,
    source: 'http',
    name: 'TypeError',
    message: `boom ${fingerprint}`,
    fingerprint,
  });

  effect.effect('writes rollups and groups, and alerts on new and regressed groups only', () => {
    const updates: Array<Record<string, unknown>> = [];
    const published: string[] = [];
    const issues: string[] = [];
    // fp-new has never been seen, fp-back was resolved, fp-known is open.
    const before: Record<string, Record<string, unknown> | undefined> = {
      'fp-back': { status: 'resolved' },
      'fp-known': { status: 'open' },
    };
    const ddb = {
      send: async (command: { input: Record<string, unknown> }) => {
        updates.push(command.input);
        const sk = (command.input.Key as { sk: string }).sk;
        return command.input.ReturnValues === 'ALL_OLD' ? { Attributes: before[sk] } : {};
      },
    } as unknown as DynamoDBDocumentClient;
    const sns = {
      send: async (command: { input: { Subject: string } }) => void published.push(command.input.Subject),
    } as unknown as SNSClient;
    const layer = TelemetryWriter.layer.pipe(
      Layer.provide([
        awsLayer({ ddb: () => ddb, sns: () => sns }),
        settingsLayer({
          runtime: Effect.succeed({ ...runtime, alertsTopicArn: 'arn:aws:sns:us-east-1:0:alerts' }),
          githubApp: Effect.succeedSome(githubApp),
        }),
        memoryStore({
          apps: [{ name: 'todo', repo: 'eric/todo', owners: ['eric'], createdBy: 'eric', createdAt: 'x' }],
        }),
        Layer.mock(GitHub, {
          openIssue: (_app, repo, issue) =>
            Effect.sync(() => {
              issues.push(`${repo}: ${issue.title}`);
              return Option.some('https://github.com/eric/todo/issues/1');
            }),
        }),
      ]),
    );
    return Effect.gen(function* () {
      const agg = aggregate([req(), err('fp-new'), err('fp-back'), err('fp-known')]);
      const fresh = yield* TelemetryWriter.use((w) => w.apply(agg));
      assert.deepStrictEqual(
        fresh.map((g) => g.sk),
        ['fp-new', 'fp-back'],
      );
      const reopened = updates.filter((u) => u.UpdateExpression === 'SET #status = :open');
      assert.deepStrictEqual(
        reopened.map((u) => (u.Key as { sk: string }).sk),
        ['fp-back'],
      );
      assert.strictEqual(updates.filter((u) => u.TableName === 'platform-telemetry').length, updates.length);
      assert.sameMembers(published, ['[platform] todo/prod: TypeError', '[platform] todo/prod: TypeError']);
      assert.sameMembers(issues, [
        'eric/todo: [error] TypeError: boom fp-new',
        'eric/todo: [error] TypeError: boom fp-back',
      ]);
    }).pipe(Effect.provide(layer));
  });
});
