import type { SNSClient } from '@aws-sdk/client-sns';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { assert, it as effect } from '@effect/vitest';
import type { TelemetryEvent } from '@ericminassian/platform-core';
import { Effect, Layer, Option } from 'effect';
import { describe, expect, it } from 'vitest';
import { GitHub } from '../src/github.ts';
import { toLogLine } from '../src/logs.ts';
import { aggregate, maxFollowUps, parseLogMessage, rollupUpdateInput } from '../src/telemetry/aggregate.ts';
import {
  parseRange,
  summarizeHealth,
  toCustomMetricStats,
  toJobStats,
  toLimitStats,
  toMetricsPoints,
  toRouteStats,
  toServiceRuns,
  toUptimePoint,
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

  it('reads compact lines: no path when it is the route, spans counted, no first attempt', () => {
    const { path, ...compact } = req({ calls: 3, callMs: 12 }) as Extract<TelemetryEvent, { t: 'req' }>;
    expect(path).toBe('/api/todos');
    const line = JSON.stringify(compact);
    expect(parseLogMessage(line)).toEqual(compact);
    expect(toLogLine('web', T, line)).toMatchObject({ message: 'GET /api/todos 200 42ms', event: compact });
    const job = {
      ...base,
      t: 'job',
      ts: T,
      kind: 'queue',
      name: 'emails',
      status: 'ok',
      dur: 7,
      calls: 1,
      callMs: 3,
    };
    expect(parseLogMessage(JSON.stringify(job))).toEqual(job);
    const { rollups } = aggregate([compact, req({ route: '/api/todos/:id', path: '/api/todos/7' })]);
    const routes = rollups.filter((r) => r.pk === 'r#todo#prod#1h').map((r) => [r.sk, r.add.req]);
    expect(routes).toEqual([
      ['2026-11-14T10:00:00.000Z#GET /api/todos', 1],
      ['2026-11-14T10:00:00.000Z#GET /api/todos/:id', 1],
    ]);
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
    // Handling time, summed: what the compute chooser reads concurrency from.
    expect(minute!.add.dur).toBe(42 + 900 + 3);
    expect(agg.rollups.filter((r) => r.pk.startsWith('m#'))).toHaveLength(3);
    const routes = agg.rollups.filter((r) => r.pk === 'r#todo#prod#1h');
    expect(routes.map((r) => r.sk).toSorted()).toEqual([
      '2026-11-14T10:00:00.000Z#GET /api/todos',
      '2026-11-14T10:00:00.000Z#GET /api/todos/:id',
    ]);
    // 1m TTL = 3 days after the bucket.
    expect(minute!.ttl).toBe(Math.floor(Date.parse('2026-11-14T10:15:00Z') / 1000) + 3 * 86400);
  });

  it('leaves the platform’s health probes out of the traffic', () => {
    const health = { route: '/__platform/health', path: '/__platform/health' };
    const agg = aggregate([req(health), req({ ...health, status: 500, cold: true }), req()]);
    const minute = agg.rollups.find((r) => r.pk === 'm#todo#prod#1m');
    // Only the app's request counts, its handling time included (the compute chooser reads `dur`).
    expect(minute!.add).toEqual({ req: 1, dur: 42, s2xx: 1, l3: 1 });
    expect(agg.rollups.filter((r) => r.pk.startsWith('r#')).map((r) => r.sk)).toEqual([
      '2026-11-14T10:15:00.000Z#GET /api/todos',
      '2026-11-14T10:00:00.000Z#GET /api/todos',
      '2026-11-14T00:00:00.000Z#GET /api/todos',
    ]);
    expect(aggregate([req(health)]).rollups).toEqual([]);
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
    // A server's start carries its INIT, for the compute chooser's cold starts.
    expect(agg.rollups.find((r) => r.pk === 'm#todo#prod#1m')!.add).toEqual({
      webStarts: 1,
      webInitMs: 120,
      webInits: 1,
    });
  });

  it('counts rate limit checks per limit, allowed apart from denied', () => {
    const limit = (ts: number, name: string, ok: boolean): TelemetryEvent => ({
      ...base,
      t: 'limit',
      ts,
      name,
      ok,
    });
    const agg = aggregate([
      limit(T, 'signups', true),
      limit(T + 1000, 'signups', false),
      limit(T + 2000, 'signups', false),
      limit(T, 'writes', true),
    ]);
    const hourly = agg.rollups.filter((r) => r.pk === 'l#todo#prod#1h');
    expect(hourly.map((r) => [r.sk, r.add, r.set])).toEqual([
      ['2026-11-14T10:00:00.000Z#signups', { allowed: 1, denied: 2 }, { name: 'signups' }],
      ['2026-11-14T10:00:00.000Z#writes', { allowed: 1 }, { name: 'writes' }],
    ]);
    expect(agg.rollups.filter((r) => r.pk === 'l#todo#prod#1d')).toHaveLength(2);
    // Minute buckets too, for the explorer and alert rules.
    expect(agg.rollups.filter((r) => r.pk === 'l#todo#prod#1m').map((r) => r.sk)).toEqual([
      '2026-11-14T10:15:00.000Z#signups',
      '2026-11-14T10:15:00.000Z#writes',
    ]);
  });

  it('writes every series by the minute, routes with each status class and cold starts', () => {
    const agg = aggregate([
      req(),
      req({ status: 302, cold: true }),
      req({ status: 503 }),
      { ...base, t: 'job', ts: T, kind: 'queue', name: 'emails', status: 'ok', dur: 20 },
      { ...base, t: 'metric', ts: T, name: 'cart', value: 40, unit: 'usd' },
      { ...base, t: 'metric', ts: T + 1, name: 'cart', value: 90, unit: 'usd' },
      { ...base, t: 'metric', ts: T + 2, name: 'cart', value: 10, unit: 'usd' },
    ]);
    const minute = (prefix: string) => agg.rollups.find((r) => r.pk === `${prefix}#todo#prod#1m`);
    expect(minute('r')).toMatchObject({
      sk: '2026-11-14T10:15:00.000Z#GET /api/todos',
      add: { req: 3, s2xx: 1, s3xx: 1, s5xx: 1, cold: 1 },
      set: { method: 'GET', route: '/api/todos' },
    });
    // A minute row lives as long as the whole stage's.
    expect(minute('r')!.ttl).toBe(minute('m')!.ttl);
    expect(minute('j')).toMatchObject({ sk: '2026-11-14T10:15:00.000Z#queue:emails', add: { ok: 1 } });
    // Custom metrics keep their largest value too, at every resolution.
    expect(agg.rollups.filter((r) => r.pk.startsWith('c#')).map((r) => [r.pk, r.add, r.max])).toEqual([
      ['c#todo#prod#1m', { count: 3, sum: 140 }, { max: 90 }],
      ['c#todo#prod#1h', { count: 3, sum: 140 }, { max: 90 }],
      ['c#todo#prod#1d', { count: 3, sum: 140 }, { max: 90 }],
    ]);
  });
  it('counts a service’s container starts on the stage and next to its runs', () => {
    const agg = aggregate([
      { ...base, t: 'env', ts: T, event: 'start', runtime: 'service', name: 'ais' },
      { ...base, t: 'env', ts: T + 1, event: 'stop', runtime: 'service', name: 'ais', reason: 'SIGTERM' },
      { ...base, t: 'job', ts: T + 2, kind: 'service', name: 'ais', status: 'error', dur: 5000 },
      { ...base, t: 'job', ts: T + 3, kind: 'service', name: 'ais/poll', status: 'ok', dur: 20 },
    ]);
    expect(agg.rollups.find((r) => r.pk === 'm#todo#prod#1m')!.add).toEqual({ serviceStarts: 1 });
    const rows = agg.rollups.filter((r) => r.pk === 'j#todo#prod#1h');
    expect(rows.map((r) => r.sk).toSorted()).toEqual([
      '2026-11-14T10:00:00.000Z#service:ais',
      '2026-11-14T10:00:00.000Z#service:ais/poll',
    ]);
    const service = rows.find((r) => r.sk.endsWith('#service:ais'));
    expect(service!.add).toMatchObject({ starts: 1, error: 1 });
    expect(service!.set).toEqual({ kind: 'service', name: 'ais', lastRun: T + 2 });
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
    expect(input).not.toHaveProperty('ReturnValues');
  });

  it('keeps a maximum: set when the row has none, raised after when the batch beat it', () => {
    const u = { pk: 'p', sk: 's', add: { count: 1, sum: 7 }, set: {}, max: { max: 7 }, ttl: 9 };
    const input = rollupUpdateInput('tel', u);
    expect(input.UpdateExpression).toBe(
      'SET #ttl = :ttl, #x0 = if_not_exists(#x0, :x0) ADD #a0 :a0, #a1 :a1',
    );
    expect(input.ExpressionAttributeNames).toMatchObject({ '#x0': 'max' });
    expect(input.ReturnValues).toBe('ALL_NEW');
    // The row came back with its own (the batch's, or a larger one): nothing more to write.
    expect(maxFollowUps('tel', u, { max: 7 })).toEqual([]);
    expect(maxFollowUps('tel', u, { max: 12 })).toEqual([]);
    expect(maxFollowUps('tel', u, { max: 3 })).toEqual([
      {
        TableName: 'tel',
        Key: { pk: 'p', sk: 's' },
        UpdateExpression: 'SET #m = :m',
        ConditionExpression: '#m < :m',
        ExpressionAttributeNames: { '#m': 'max' },
        ExpressionAttributeValues: { ':m': 7 },
      },
    ]);
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

  it('sums custom metrics per name, zero-filled, with their latest unit', () => {
    const range = {
      from: Date.parse('2026-11-14T08:00:00Z'),
      to: Date.parse('2026-11-14T09:30:00Z'),
      res: '1h' as const,
    };
    const metrics = toCustomMetricStats(
      [
        { sk: '2026-11-14T08:00:00.000Z#signups', name: 'signups', unit: 'count', count: 3, sum: 3 },
        { sk: '2026-11-14T09:00:00.000Z#cart.total', name: 'cart.total', unit: 'usd', count: 2, sum: 85 },
        { sk: '2026-11-14T08:00:00.000Z#cart.total', name: 'cart.total', count: 1, sum: 10 },
      ],
      range,
    );
    expect(metrics).toEqual([
      {
        name: 'cart.total',
        unit: 'usd',
        count: 3,
        sum: 95,
        points: [
          { ts: '2026-11-14T08:00:00.000Z', count: 1, sum: 10 },
          { ts: '2026-11-14T09:00:00.000Z', count: 2, sum: 85 },
        ],
      },
      {
        name: 'signups',
        unit: 'count',
        count: 3,
        sum: 3,
        points: [
          { ts: '2026-11-14T08:00:00.000Z', count: 3, sum: 3 },
          { ts: '2026-11-14T09:00:00.000Z', count: 0, sum: 0 },
        ],
      },
    ]);
  });

  it('zero-fills each limit and puts the most denied first', () => {
    const range = {
      from: Date.parse('2026-11-14T08:00:00Z'),
      to: Date.parse('2026-11-14T10:30:00Z'),
      res: '1h' as const,
    };
    const limits = toLimitStats(
      [
        { sk: '2026-11-14T08:00:00.000Z#writes', name: 'writes', allowed: 40 },
        { sk: '2026-11-14T10:00:00.000Z#writes', name: 'writes', allowed: 2, denied: 1 },
        { sk: '2026-11-14T09:00:00.000Z#signups', name: 'signups', allowed: 3, denied: 9 },
      ],
      range,
    );
    expect(limits.map((l) => [l.name, l.allowed, l.denied])).toEqual([
      ['signups', 3, 9],
      ['writes', 42, 1],
    ]);
    expect(limits[1]!.points).toEqual([
      { ts: '2026-11-14T08:00:00.000Z', allowed: 40, denied: 0 },
      { ts: '2026-11-14T09:00:00.000Z', allowed: 0, denied: 0 },
      { ts: '2026-11-14T10:00:00.000Z', allowed: 2, denied: 1 },
    ]);
  });
  it('lists service runs as jobs, but not rows that only count container starts', () => {
    const items = [
      { sk: 'a#service:ais', kind: 'service', name: 'ais', starts: 2 },
      { sk: 'a#service:ais/poll', kind: 'service', name: 'ais/poll', ok: 3, l1: 3, lastRun: T },
      { sk: 'b#service:ais', kind: 'service', name: 'ais', starts: 1, ok: 1, error: 2, l9: 3 },
      { sk: 'b#queue:emails', kind: 'queue', name: 'emails', ok: 1 },
    ];
    expect(toJobStats(items.slice(0, 2)).map((j) => `${j.kind}:${j.name}`)).toEqual(['service:ais/poll']);
    expect(toJobStats(items).map((j) => [`${j.kind}:${j.name}`, j.ok, j.error])).toEqual([
      ['service:ais', 1, 2],
      ['service:ais/poll', 3, 0],
      ['queue:emails', 1, 0],
    ]);
    expect(toServiceRuns(items)).toEqual(new Map([['ais', { starts: 3, failedRuns: 2 }]]));
  });

  it('summarizes last-hour health', () => {
    const range = { from: T - 120_000, to: T, res: '1m' as const };
    const items = [{ sk: new Date(T - 60_000 - (T % 60_000)).toISOString(), req: 10, s5xx: 1, l4: 10 }];
    const h = summarizeHealth(toMetricsPoints(items, range), items, true);
    expect(h).toMatchObject({ up: true, errorRate: 0.1, p95: 100 });
    expect(h.reqPerMin).toBeGreaterThan(0);
  });

  it('reads uptime rows from traffic and checks, and older rows as checks', () => {
    const ts = '2026-11-16T12:00:20.000Z';
    expect(toUptimePoint({ sk: ts, source: 'traffic', ok: false, req: 40, s5xx: 31, ttl: 1 })).toEqual({
      ts,
      ok: false,
      source: 'traffic',
      req: 40,
      s5xx: 31,
    });
    expect(toUptimePoint({ sk: ts, source: 'check', ok: true, status: 200, ms: 41 })).toEqual({
      ts,
      ok: true,
      source: 'check',
      status: 200,
      ms: 41,
    });
    expect(toUptimePoint({ sk: ts, ok: false, status: 0, ms: 10_000 })).toEqual({
      ts,
      ok: false,
      source: 'check',
      status: 0,
      ms: 10_000,
    });
  });
});

describe('telemetry processor', () => {
  effect.effect('raises a custom metric’s max a batch beat, and lets a larger concurrent one stand', () => {
    const updates: Array<Record<string, unknown>> = [];
    const ddb = {
      send: async (command: { input: Record<string, unknown> }) => {
        updates.push(command.input);
        if (command.input.ConditionExpression) {
          // The daily row was raised past this batch's meanwhile.
          if ((command.input.Key as { pk: string }).pk.endsWith('#1d'))
            throw Object.assign(new Error('condition'), { name: 'ConditionalCheckFailedException' });
          return {};
        }
        // Rows already hold a max of 50, but the minute row is new (it gets the batch's).
        const pk = (command.input.Key as { pk: string }).pk;
        return { Attributes: { max: pk.endsWith('#1m') ? 90 : 50 } };
      },
    } as unknown as DynamoDBDocumentClient;
    const layer = TelemetryWriter.layer.pipe(
      Layer.provide([awsLayer({ ddb: () => ddb }), settingsLayer(), memoryStore(), Layer.mock(GitHub, {})]),
    );
    return Effect.gen(function* () {
      yield* TelemetryWriter.use((w) =>
        w.apply(aggregate([{ ...base, t: 'metric', ts: T, name: 'cart', value: 90 }])),
      );
      const raised = updates.filter((u) => u.ConditionExpression === '#m < :m');
      assert.deepStrictEqual(
        raised.map((u) => (u.Key as { pk: string }).pk),
        ['c#todo#prod#1h', 'c#todo#prod#1d'],
      );
    }).pipe(Effect.provide(layer));
  });

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
