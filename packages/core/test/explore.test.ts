import { Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import {
  AlertRuleInput,
  autoQueryResolution,
  checkSeriesQuery,
  describeQuery,
  MetricsView,
  nextAlertState,
  type SeriesQuery,
} from '../src/index.ts';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 16, 14, 0);

describe('autoQueryResolution', () => {
  const minuteHorizon = 3 * DAY;
  const res = (spanMs: number, from = NOW - spanMs) => autoQueryResolution(from, NOW, NOW, minuteHorizon);

  it('keeps a chart near 150 buckets', () => {
    expect(res(60 * 60_000)).toBe('1m');
    expect(res(6 * 3_600_000)).toBe('5m');
    expect(res(DAY)).toBe('10m');
    expect(res(2 * DAY)).toBe('15m');
    expect(res(7 * DAY)).toBe('1h');
    expect(res(30 * DAY)).toBe('1d');
  });

  it('uses hours for a range that starts before minute rollups expire', () => {
    expect(res(60 * 60_000, NOW - 5 * DAY)).toBe('1h');
  });
});

describe('checkSeriesQuery', () => {
  const ok: SeriesQuery = { metric: 'requests', stat: 'percent', filter: { status: ['5xx'] } };

  it('accepts a query each metric can answer', () => {
    expect(checkSeriesQuery(ok)).toBeUndefined();
    expect(checkSeriesQuery({ metric: 'latency', stat: 'p95', groupBy: 'route' })).toBeUndefined();
    expect(
      checkSeriesQuery({ metric: 'custom', stat: 'sum', filter: { names: ['signups'] } }),
    ).toBeUndefined();
    expect(
      checkSeriesQuery({ metric: 'realtime', stat: 'sum', filter: { measure: 'events' } }),
    ).toBeUndefined();
  });

  it('names what is wrong', () => {
    expect(checkSeriesQuery({ metric: 'latency', stat: 'count' })).toMatch(/latency answers/);
    expect(checkSeriesQuery({ metric: 'latency', stat: 'p95', groupBy: 'status' })).toMatch(
      /grouped by route/,
    );
    expect(checkSeriesQuery({ metric: 'jobs', stat: 'count', filter: { status: ['5xx'] } })).toMatch(
      /status/,
    );
    expect(checkSeriesQuery({ metric: 'jobs', stat: 'count', filter: { outcome: 'denied' } })).toMatch(
      /ok or error/,
    );
    expect(checkSeriesQuery({ metric: 'custom', stat: 'sum' })).toMatch(/names its metric/);
    expect(checkSeriesQuery({ metric: 'service', stat: 'avg' })).toMatch(/cpu or memory/);
  });

  it('refuses what an alert rule cannot watch', () => {
    expect(checkSeriesQuery(ok, { alert: true })).toBeUndefined();
    expect(
      checkSeriesQuery({ metric: 'realtime', stat: 'sum', filter: { measure: 'events' } }, { alert: true }),
    ).toMatch(/can't watch realtime/);
    expect(checkSeriesQuery({ metric: 'latency', stat: 'histogram' }, { alert: true })).toMatch(/histogram/);
    expect(
      checkSeriesQuery({ metric: 'requests', stat: 'count', groupBy: 'route' }, { alert: true }),
    ).toMatch(/one series/);
    expect(checkSeriesQuery({ ...ok, app: 'other' }, { alert: true })).toMatch(/own app/);
  });
});

describe('describeQuery', () => {
  it('reads like a chart title', () => {
    expect(describeQuery(ok())).toBe('5xx % of requests');
    expect(describeQuery({ metric: 'latency', stat: 'p95', filter: { routes: ['GET /api/x'] } })).toBe(
      'p95 latency of GET /api/x',
    );
    expect(describeQuery({ metric: 'jobs', stat: 'percent', filter: { outcome: 'error' } })).toBe(
      'failed % of job runs',
    );
    expect(describeQuery({ metric: 'requests', stat: 'count', groupBy: 'status' })).toBe(
      'requests by status',
    );
    expect(
      describeQuery({ metric: 'custom', stat: 'sum', filter: { names: ['signups'] }, app: 'atlas' }),
    ).toBe('sum of signups (atlas)');
  });
  function ok(): SeriesQuery {
    return { metric: 'requests', stat: 'percent', filter: { status: ['5xx'] } };
  }
});

describe('nextAlertState', () => {
  const rule = (missing: 'ok' | 'alarm' | 'keep') => ({
    condition: { op: 'above' as const, threshold: 2, minutes: 5 as const },
    missing,
  });

  it('alarms past the threshold and recovers below it', () => {
    expect(nextAlertState('ok', 2.5, rule('keep'))).toBe('alarm');
    expect(nextAlertState('alarm', 2, rule('keep'))).toBe('ok');
    expect(nextAlertState('no_data', 0, rule('keep'))).toBe('ok');
  });

  it('treats a window without data as the rule says', () => {
    expect(nextAlertState('alarm', null, rule('ok'))).toBe('ok');
    expect(nextAlertState('ok', null, rule('alarm'))).toBe('alarm');
    expect(nextAlertState('alarm', null, rule('keep'))).toBe('alarm');
    expect(nextAlertState('no_data', null, rule('keep'))).toBe('no_data');
  });
});

describe('schemas', () => {
  it('accepts an alert rule and a metrics view', () => {
    const decodeRule = Schema.decodeUnknownSync(AlertRuleInput);
    expect(() =>
      decodeRule({
        name: 'Errors',
        stage: 'prod',
        query: { metric: 'requests', stat: 'percent', filter: { status: ['5xx'] } },
        condition: { op: 'above', threshold: 2, minutes: 5 },
        missing: 'ok',
        notify: true,
        enabled: true,
      }),
    ).not.toThrow();
    expect(() =>
      decodeRule({
        name: 'Errors',
        stage: 'prod',
        query: { metric: 'requests', stat: 'percent' },
        condition: { op: 'above', threshold: 2, minutes: 7 },
        missing: 'ok',
        notify: true,
        enabled: true,
      }),
    ).toThrow(/minutes/);
    expect(() =>
      Schema.decodeUnknownSync(MetricsView)({
        kind: 'metrics',
        queries: [{ id: 'a', metric: 'requests', stat: 'count' }],
        expressions: [{ id: 'e1', expr: '100 * a / b' }],
        chart: 'line',
      }),
    ).not.toThrow();
  });
});
