import type { MetricDataResult } from '@aws-sdk/client-cloudwatch';
import { assert, it as effect } from '@effect/vitest';
import type { AppRecord, SeriesQuery } from '@ericminassian/platform-core';
import { captureTelemetry, resetPlatform, useTestBindings } from '@ericminassian/platform/testing';
import { Effect } from 'effect';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cloudWatchSeriesRes } from '../src/cloudwatch.ts';
import { toRealtimeSeriesResponse } from '../src/jobs/realtime.ts';
import { toServiceSeriesResponse } from '../src/jobs/services.ts';
import type { StageItem } from '../src/store.ts';
import {
  type SeriesFamily,
  type SeriesRange,
  seriesFamily,
  seriesPlan,
  statusCounts,
  toSeriesResponse,
  windowValue,
} from '../src/telemetry/query.ts';
import { api, memoryStore, type TestServices, testServices } from './support.ts';

const T0 = Date.parse('2026-11-16T10:00:00.000Z');
const MIN = 60_000;
const DAY = 86_400_000;
const at = (minutes: number) => new Date(T0 + minutes * MIN).toISOString();

/** Minutes 0 to 2 by the minute. */
const minutes3: SeriesRange = { from: T0, to: T0 + 2 * MIN, res: '1m' };

const answer = (
  items: ReadonlyArray<Record<string, unknown>>,
  q: SeriesQuery,
  range: SeriesRange = minutes3,
  family: SeriesFamily = seriesFamily(q)!,
) => toSeriesResponse(items, q, family, range);

/** `key: values` of each line. */
const lines = (r: { series: ReadonlyArray<{ key: string; values: ReadonlyArray<number | null> }> }) =>
  Object.fromEntries(r.series.map((s) => [s.key, s.values]));

describe('series from rollups', () => {
  const stageRows = [
    { sk: at(0), req: 10, s2xx: 7, s3xx: 1, s4xx: 1, s5xx: 1 },
    { sk: at(1), req: 4, s2xx: 4 },
  ];

  it('reads whole-stage rows unless a query filters or groups by route', () => {
    expect(seriesFamily({ metric: 'requests', stat: 'count' })).toBe('stage');
    expect(seriesFamily({ metric: 'latency', stat: 'p95', groupBy: 'route' })).toBe('route');
    expect(seriesFamily({ metric: 'cold_starts', stat: 'count', filter: { routes: ['GET /a'] } })).toBe(
      'route',
    );
    expect(seriesFamily({ metric: 'job_duration', stat: 'p50' })).toBe('job');
    expect(seriesFamily({ metric: 'realtime', stat: 'sum', filter: { measure: 'events' } })).toBeUndefined();
  });

  it('answers requests by status class: counts, shares, and dense zero-filled buckets', () => {
    const counts = answer(stageRows, { metric: 'requests', stat: 'count', groupBy: 'status' });
    expect(counts.timestamps).toEqual([at(0), at(1), at(2)]);
    expect(counts.unit).toBe('count');
    expect(lines(counts)).toEqual({ '2xx': [7, 4, 0], '3xx': [1, 0, 0], '4xx': [1, 0, 0], '5xx': [1, 0, 0] });
    // A share is null in a bucket with no requests behind it.
    const shares = answer(stageRows, { metric: 'requests', stat: 'percent', filter: { status: ['5xx'] } });
    expect(shares.unit).toBe('percent');
    expect(lines(shares)).toEqual({ all: [10, 0, null] });
    const rate = answer(stageRows, { metric: 'requests', stat: 'rate' });
    expect(rate.unit).toBe('per_second');
    expect(lines(rate)).toEqual({ all: [0.166667, 0.0666667, 0] });
  });

  it('reads route rows from before they counted 2xx and 3xx as 2xx for the rest', () => {
    expect(statusCounts({ req: 5, s4xx: 1, s5xx: 1 })).toEqual({ '2xx': 3, '3xx': 0, '4xx': 1, '5xx': 1 });
    expect(statusCounts({ req: 2, s4xx: 2 })).toEqual({ '2xx': 0, '3xx': 0, '4xx': 2, '5xx': 0 });
    const rows = [
      { sk: `${at(0)}#GET /a`, req: 5, s4xx: 1, s5xx: 1 },
      { sk: `${at(1)}#GET /a`, req: 2, s2xx: 1, s3xx: 1, cold: 1 },
      { sk: `${at(0)}#POST /b`, req: 9, s5xx: 9, cold: 3 },
    ];
    const q: SeriesQuery = {
      metric: 'requests',
      stat: 'count',
      groupBy: 'status',
      filter: { routes: ['GET /a'] },
    };
    expect(lines(answer(rows, q))).toEqual({
      '2xx': [3, 1, 0],
      '3xx': [0, 1, 0],
      '4xx': [1, 0, 0],
      '5xx': [1, 0, 0],
    });
    expect(
      lines(answer(rows, { metric: 'cold_starts', stat: 'percent', filter: { routes: ['POST /b'] } })),
    ).toEqual({ all: [33.3333, null, null] });
  });

  it('sums minute rows into coarser buckets, histograms included, with null percentiles where empty', () => {
    const rows = [
      { sk: `${at(0)}#GET /a`, req: 4, l2: 4 },
      { sk: `${at(3)}#GET /a`, req: 1, l5: 1 },
    ];
    const range: SeriesRange = { from: T0, to: T0 + 9 * MIN, res: '5m' };
    const q: SeriesQuery = { metric: 'latency', stat: 'p95', filter: { routes: ['GET /a'] } };
    const p95 = answer(rows, q, range);
    expect(p95).toEqual({
      res: '5m',
      timestamps: [at(0), at(5)],
      unit: 'ms',
      series: [{ key: 'all', values: [250, null] }],
    });
    expect(lines(answer(rows, { ...q, stat: 'p50' }, range))).toEqual({ all: [25, null] });
    const hist = answer(rows, { ...q, stat: 'histogram' }, range);
    expect(lines(hist)).toEqual({ all: [5, 0] });
    expect(hist.histogram).toEqual([
      [0, 0, 4, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    ]);
  });

  it('answers jobs by job and by outcome, leaving out rows that only count service starts', () => {
    const rows = [
      { sk: `${at(0)}#queue:emails`, kind: 'queue', name: 'emails', ok: 3, error: 1 },
      { sk: `${at(0)}#cron:digest`, kind: 'cron', name: 'digest', ok: 1 },
      { sk: `${at(1)}#queue:emails`, kind: 'queue', name: 'emails', error: 2 },
      { sk: `${at(1)}#service:ais`, kind: 'service', name: 'ais', starts: 1 },
    ];
    expect(lines(answer(rows, { metric: 'jobs', stat: 'percent', filter: { outcome: 'error' } }))).toEqual({
      all: [20, 100, null],
    });
    expect(lines(answer(rows, { metric: 'jobs', stat: 'count', groupBy: 'job' }))).toEqual({
      'queue:emails': [4, 2, 0],
      'cron:digest': [1, 0, 0],
    });
    expect(lines(answer(rows, { metric: 'jobs', stat: 'count', groupBy: 'outcome' }))).toEqual({
      ok: [4, 0, 0],
      error: [1, 2, 0],
    });
    expect(
      lines(
        answer(rows, { metric: 'jobs', stat: 'count', filter: { jobs: ['cron:digest'], outcome: 'ok' } }),
      ),
    ).toEqual({ all: [1, 0, 0] });
  });

  it('answers custom metrics in their own unit: sums, averages, maxima and counts', () => {
    const rows = [
      { sk: `${at(0)}#cart`, name: 'cart', unit: 'usd', count: 2, sum: 50, max: 40 },
      { sk: `${at(1)}#cart`, name: 'cart', unit: 'usd', count: 1, sum: 90, max: 90 },
      // Recorded before rollups kept a maximum.
      { sk: `${at(0)}#signups`, name: 'signups', unit: 'count', count: 3, sum: 3 },
    ];
    const cart = (stat: SeriesQuery['stat']) =>
      answer(rows, { metric: 'custom', stat, filter: { names: ['cart'] } });
    expect([cart('sum').unit, lines(cart('sum'))]).toEqual(['usd', { all: [50, 90, 0] }]);
    expect(lines(cart('avg'))).toEqual({ all: [25, 90, null] });
    expect(lines(cart('max'))).toEqual({ all: [40, 90, null] });
    expect([cart('count').unit, lines(cart('count'))]).toEqual(['count', { all: [2, 1, 0] }]);
    expect(lines(answer(rows, { metric: 'custom', stat: 'max', filter: { names: ['signups'] } }))).toEqual({
      all: [null, null, null],
    });
    // Lines in different units are in none of them.
    const byName = answer(rows, { metric: 'custom', stat: 'sum', groupBy: 'name' });
    expect([byName.unit, byName.series.map((s) => s.key)]).toEqual(['count', ['cart', 'signups']]);
  });

  it('answers rate limit checks, as the denied share unless the filter says otherwise', () => {
    const rows = [
      { sk: `${at(0)}#signups`, name: 'signups', allowed: 3, denied: 1 },
      { sk: `${at(0)}#writes`, name: 'writes', allowed: 4 },
    ];
    expect(lines(answer(rows, { metric: 'rate_limit', stat: 'percent' }))).toEqual({
      all: [12.5, null, null],
    });
    expect(lines(answer(rows, { metric: 'rate_limit', stat: 'count' }))).toEqual({ all: [8, 0, 0] });
    expect(
      lines(answer(rows, { metric: 'rate_limit', stat: 'percent', filter: { outcome: 'allowed' } })),
    ).toEqual({ all: [87.5, null, null] });
    // A limit nothing was denied by still has a share: 0%.
    expect(lines(answer(rows, { metric: 'rate_limit', stat: 'percent', groupBy: 'name' }))).toEqual({
      signups: [25, null, null],
      writes: [0, null, null],
    });
  });

  it('keeps the 10 busiest groups and says how many there were', () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ sk: `${at(0)}#GET /r${i}`, req: i + 1 }));
    const r = answer(rows, { metric: 'requests', stat: 'count', groupBy: 'route' });
    expect(r.series.map((s) => s.key)).toEqual(Array.from({ length: 10 }, (_, i) => `GET /r${11 - i}`));
    expect(r.note).toBe('showing the top 10 of 12 routes');
    // Routes without a matching request aren't lines of a count.
    const errors = answer([...rows, { sk: `${at(0)}#GET /x`, req: 2, s5xx: 2 }], {
      metric: 'requests',
      stat: 'count',
      groupBy: 'route',
      filter: { status: ['5xx'] },
    });
    expect([errors.series.map((s) => s.key), errors.note]).toEqual([['GET /x'], undefined]);
  });

  it('answers in hours or days where minute or hour rows have expired, and says so', () => {
    const now = T0;
    expect(seriesPlan({ from: now - DAY, to: now, res: '10m' }, now)).toEqual({
      range: { from: now - DAY, to: now, res: '10m' },
      stored: '1m',
    });
    expect(seriesPlan({ from: now - 4 * DAY, to: now - 3.9 * DAY, res: '5m' }, now)).toEqual({
      range: { from: now - 4 * DAY, to: now - 3.9 * DAY, res: '1h' },
      stored: '1h',
      note: 'minute data is kept for 3 days, so this range is in 1h buckets',
    });
    expect(seriesPlan({ from: now - 40 * DAY, to: now, res: '1h' }, now)).toMatchObject({
      range: { res: '1d' },
      stored: '1d',
      note: 'hourly data is kept for 35 days, so this range is in 1d buckets',
    });
  });
});

describe('window values', () => {
  const from = T0;
  const to = T0 + 5 * MIN;

  it('summarizes the whole window, not an average of its minutes', () => {
    const rows = [
      { sk: at(0), req: 10, s5xx: 1, l2: 10 },
      { sk: at(4), req: 30, s5xx: 9, l6: 30 },
      // The minute the window ends at isn't in it.
      { sk: at(5), req: 100, s5xx: 100 },
    ];
    const q = (over: Partial<SeriesQuery>): SeriesQuery => ({ metric: 'requests', stat: 'count', ...over });
    expect(windowValue(rows, q({ stat: 'percent', filter: { status: ['5xx'] } }), 'stage', from, to)).toBe(
      25,
    );
    expect(windowValue(rows, q({}), 'stage', from, to)).toBe(40);
    expect(windowValue(rows, q({ stat: 'rate' }), 'stage', from, to)).toBe(0.133333);
    expect(windowValue(rows, { metric: 'latency', stat: 'p95' }, 'stage', from, to)).toBe(500);
  });

  it('is 0 for counts with nothing in the window, and null for shares and percentiles', () => {
    expect(windowValue([], { metric: 'requests', stat: 'count' }, 'stage', from, to)).toBe(0);
    expect(
      windowValue([], { metric: 'jobs', stat: 'percent', filter: { outcome: 'error' } }, 'job', from, to),
    ).toBeNull();
    expect(windowValue([], { metric: 'latency', stat: 'p99' }, 'stage', from, to)).toBeNull();
    expect(
      windowValue([], { metric: 'custom', stat: 'sum', filter: { names: ['x'] } }, 'metric', from, to),
    ).toBe(0);
    expect(
      windowValue([], { metric: 'custom', stat: 'avg', filter: { names: ['x'] } }, 'metric', from, to),
    ).toBeNull();
  });
});

describe('series from CloudWatch', () => {
  const range: SeriesRange = { from: T0, to: T0 + 10 * MIN, res: '5m' };
  const result = (id: string, points: ReadonlyArray<readonly [number, number]>): MetricDataResult => ({
    Id: id,
    Timestamps: points.map(([m]) => new Date(T0 + m * MIN)),
    Values: points.map(([, v]) => v),
  });

  it('keeps to the resolutions CloudWatch still has', () => {
    const now = T0;
    expect(cloudWatchSeriesRes('1m', now - DAY, now)).toEqual({ res: '1m' });
    expect(cloudWatchSeriesRes('1m', now - 20 * DAY, now)).toEqual({
      res: '5m',
      note: 'CloudWatch keeps 1-minute data for 15 days, so this range is in 5m buckets',
    });
    expect(cloudWatchSeriesRes('30m', now - 70 * DAY, now).res).toBe('1h');
    expect(cloudWatchSeriesRes('1d', now - 70 * DAY, now)).toEqual({ res: '1d' });
  });

  it('adds up every AppSync metric behind a realtime measure, zero where there is none', () => {
    const r = toRealtimeSeriesResponse(
      [
        result('m0', [[0, 2]]),
        result('m1', [
          [0, 1],
          [5, 4],
        ]),
      ],
      range,
    );
    expect(r).toEqual({
      res: '5m',
      timestamps: [at(0), at(5), at(10)],
      unit: 'count',
      series: [{ key: 'all', values: [3, 4, 0] }],
    });
  });

  it('answers services’ usage per service or for all of them, null where ECS reported nothing', () => {
    const results = [
      result('s0', [
        [0, 40],
        [5, 60],
      ]),
      result('s1', [[0, 20]]),
    ];
    const q = { measure: 'cpu', stat: 'avg', grouped: true } as const;
    const grouped = toServiceSeriesResponse(results, ['worker', 'api'], q, range);
    expect(grouped.unit).toBe('percent');
    expect(lines(grouped)).toEqual({ api: [20, null, null], worker: [40, 60, null] });
    expect(
      lines(toServiceSeriesResponse(results, ['worker', 'api'], { ...q, grouped: false }, range)),
    ).toEqual({
      all: [30, 60, null],
    });
    expect(
      lines(
        toServiceSeriesResponse(results, ['worker', 'api'], { ...q, stat: 'max', grouped: false }, range),
      ),
    ).toEqual({ all: [40, 60, null] });
  });
});

// ------------------------------------------------------------------ the endpoints

let telemetry: ReturnType<typeof captureTelemetry>;
beforeEach(() => {
  useTestBindings({ app: 'platform', stage: 'prod' });
  telemetry = captureTelemetry();
});
afterEach(() => {
  telemetry.stop();
  resetPlatform();
});

const shop: AppRecord = {
  name: 'shop',
  repo: 'bob/shop',
  owners: ['bob'],
  createdBy: 'bob',
  createdAt: '2026-11-01T00:00:00.000Z',
};

const stage = (name: string, over: Partial<StageItem> = {}): StageItem => ({
  app: 'shop',
  stage: name,
  host: 'shop.example.com',
  url: 'https://shop.example.com',
  status: 'active',
  preview: false,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
  ...over,
});

const json = (res: Response) => Effect.promise(() => res.json());

const setup = (options: TestServices = {}) =>
  Effect.gen(function* () {
    const request = yield* api(
      testServices({ store: memoryStore({ apps: [shop], stages: [stage('prod')] }), ...options }),
    );
    const res = yield* request('/v1/auth/cli', { method: 'POST', json: { githubToken: 'bob' } });
    const { token } = (yield* json(res)) as { token: string };
    return { request, bob: { authorization: `Bearer ${token}` } };
  });

const seriesPath = (q: unknown, params: Record<string, string> = {}) =>
  `/v1/apps/shop/series?${new URLSearchParams({ q: JSON.stringify(q), ...params }).toString()}`;

describe('series endpoint', () => {
  effect.effect('reads the query over the range, by default in about 150 buckets', () =>
    Effect.gen(function* () {
      const asked: Array<{ app: string; stage: string; query: SeriesQuery; range: SeriesRange }> = [];
      const { request, bob } = yield* setup({
        telemetry: {
          series: (app, stageName, query, range) =>
            Effect.sync(() => {
              asked.push({ app, stage: stageName, query, range });
              return { res: range.res, timestamps: [], unit: 'count', series: [] };
            }),
        },
      });
      const q = { metric: 'requests', stat: 'count', groupBy: 'status' };
      const from = String(T0 - 6 * 3_600_000);
      const res = yield* request(seriesPath(q, { stage: 'dev', from, to: String(T0) }), { headers: bob });
      assert.strictEqual(res.status, 200);
      const fine = yield* request(seriesPath({ ...q, stage: 'dev' }, { from, to: String(T0), res: '30m' }), {
        headers: bob,
      });
      assert.strictEqual(fine.status, 200);
      assert.deepStrictEqual(
        asked.map((a) => [a.app, a.stage, a.query.groupBy, a.range.res]),
        [
          ['shop', 'dev', 'status', '5m'],
          // A query's own stage is the one read when the request names none.
          ['shop', 'dev', 'status', '30m'],
        ],
      );
    }),
  );

  effect.effect(
    'refuses another app or stage than the request’s, a query it can’t answer, and an unknown res',
    () =>
      Effect.gen(function* () {
        const { request, bob } = yield* setup({ telemetry: {} });
        const refused = (q: unknown, params: Record<string, string> = {}) =>
          Effect.gen(function* () {
            const res = yield* request(seriesPath(q, params), { headers: bob });
            assert.strictEqual(res.status, 400);
            return ((yield* json(res)) as { error: { message: string } }).error.message;
          });
        const ok = { metric: 'requests', stat: 'count' };
        assert.strictEqual(yield* refused({ ...ok, app: 'blog' }), 'the query reads app blog, not shop');
        assert.strictEqual(
          yield* refused({ ...ok, stage: 'dev' }, { stage: 'prod' }),
          'the query reads stage dev, not prod',
        );
        assert.match(yield* refused({ metric: 'latency', stat: 'count' }), /latency answers/);
        assert.match(yield* refused(ok, { res: '2m' }), /res is one of 1m, 5m/);
      }),
  );

  effect.effect('reads realtime and services from CloudWatch', () =>
    Effect.gen(function* () {
      const measures: string[] = [];
      const { request, bob } = yield* setup({
        realtime: {
          series: (_app, _stage, measure, range) =>
            Effect.sync(() => {
              measures.push(measure);
              return { res: range.res, timestamps: [], unit: 'count', series: [{ key: 'all', values: [] }] };
            }),
        },
      });
      const realtime = yield* request(
        seriesPath({ metric: 'realtime', stat: 'sum', filter: { measure: 'errors' } }),
        {
          headers: bob,
        },
      );
      assert.strictEqual(realtime.status, 200);
      assert.deepStrictEqual(measures, ['errors']);
      // Without container compute there is no usage to read: one line of nulls.
      const range = { from: String(T0), to: String(T0 + 10 * MIN), res: '5m' };
      const services = yield* request(
        seriesPath({ metric: 'service', stat: 'max', filter: { measure: 'cpu', names: ['ais'] } }, range),
        { headers: bob },
      );
      assert.deepStrictEqual(((yield* json(services)) as { series: unknown }).series, [
        { key: 'all', values: [null, null, null] },
      ]);
    }),
  );
});
