import { stripVTControlCharacters } from 'node:util';
import type { AlertRule, SeriesResponse } from '@ericminassian/platform-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../src/api.ts';
import { alertRuleInputOf, formatAlertHistory, formatAlertRules } from '../src/commands/alerts.ts';
import { formatSeries, parseSeriesFilter, seriesQueryOf } from '../src/commands/observe.ts';
import { saveCredentials } from '../src/credentials.ts';
import { createProgram } from '../src/main.ts';
import { setJsonMode } from '../src/util/output.ts';
import { tempDir } from './helpers.ts';

/** Output without its colors. */
const plain = stripVTControlCharacters;

const rule: AlertRule = {
  id: 'a01',
  app: 'shop',
  name: 'Errors',
  stage: 'prod',
  query: { metric: 'requests', stat: 'percent', filter: { status: ['5xx'] } },
  condition: { op: 'above', threshold: 2, minutes: 5 },
  missing: 'ok',
  notify: true,
  enabled: true,
  state: 'alarm',
  stateSince: '2026-11-16T14:03:00.000Z',
  value: 3.417,
  createdBy: 'bob',
  createdAt: '2026-11-16T10:00:00.000Z',
  updatedAt: '2026-11-16T10:00:00.000Z',
};

describe('explorer queries from flags', () => {
  it('reads --filter pairs, repeating routes, statuses, jobs and names', () => {
    expect(
      parseSeriesFilter(['route=GET /api/x', 'route=POST /api/y', 'status=5xx', 'outcome=error', 'name=a=b']),
    ).toEqual({
      routes: ['GET /api/x', 'POST /api/y'],
      status: ['5xx'],
      names: ['a=b'],
      outcome: 'error',
    });
    expect(parseSeriesFilter([])).toBeUndefined();
    expect(() => parseSeriesFilter(['status=6xx'])).toThrow('status is one of 2xx, 3xx, 4xx, 5xx, not "6xx"');
    expect(() => parseSeriesFilter(['route'])).toThrow('--filter expects key=value, got "route"');
    expect(() => parseSeriesFilter(['outcome=ok', 'outcome=error'])).toThrow(
      '--filter outcome can be given once',
    );
    expect(() => parseSeriesFilter(['path=/x'])).toThrow(/not "path"/);
  });

  it('defaults the statistic to the metric’s own and checks the query as the API does', () => {
    expect(seriesQueryOf({ metric: 'latency', by: 'route' })).toEqual({
      metric: 'latency',
      stat: 'p95',
      groupBy: 'route',
    });
    expect(() => seriesQueryOf({ metric: 'latency', stat: 'count' })).toThrow(/latency answers/);
    expect(() => seriesQueryOf({ metric: 'traffic' })).toThrow(/--metric is one of requests/);
    expect(() => seriesQueryOf({ metric: 'requests', by: 'route' }, { alert: true })).toThrow(/one series/);
  });

  it('shows each line’s total or average, its highest bucket and a sparkline', () => {
    const r: SeriesResponse = {
      res: '5m',
      timestamps: ['a', 'b', 'c'],
      unit: 'percent',
      series: [
        { key: 'GET /a', values: [1, null, 4] },
        { key: 'GET /b', values: [null, null, null] },
      ],
      note: 'showing the top 10 of 12 routes',
    };
    const q = { metric: 'requests', stat: 'percent', groupBy: 'route' } as const;
    expect(plain(formatSeries(r, q, 'shop prod')).split('\n')).toEqual([
      'shop prod',
      'all % of requests by route · 5m buckets',
      '',
      'series  avg   max  over time',
      'GET /a  2.5%  4%   ▁ █      ',
      'GET /b  -     -             ',
      'note: showing the top 10 of 12 routes',
    ]);
    const counts = formatSeries(
      { ...r, unit: 'count', series: [{ key: 'all', values: [2, 3, 0] }], note: undefined },
      { metric: 'requests', stat: 'count' },
      'h',
    );
    expect(plain(counts)).toContain('all     5      3    ▆█▁');
  });
});

describe('alert rules from flags', () => {
  it('builds a new rule, defaulting to prod, ok without data, notifying and enabled', () => {
    expect(
      alertRuleInputOf({
        name: 'Errors',
        metric: 'requests',
        stat: 'percent',
        filter: ['status=5xx'],
        op: 'above',
        threshold: '2',
        minutes: '5',
      }),
    ).toEqual({
      name: 'Errors',
      stage: 'prod',
      query: { metric: 'requests', stat: 'percent', filter: { status: ['5xx'] } },
      condition: { op: 'above', threshold: 2, minutes: 5 },
      missing: 'ok',
      notify: true,
      enabled: true,
    });
    expect(() => alertRuleInputOf({ metric: 'requests' })).toThrow(
      'a rule needs --name, --op, --threshold, --minutes',
    );
    const ok = { name: 'x', metric: 'requests', op: 'above', threshold: '1', minutes: '5' };
    expect(() => alertRuleInputOf({ ...ok, minutes: '7' })).toThrow(
      '--minutes is one of 1, 5, 10, 15, 30, 60',
    );
    expect(() => alertRuleInputOf({ ...ok, op: 'over' })).toThrow('--op is above or below, not "over"');
    expect(() => alertRuleInputOf({ ...ok, threshold: 'lots' })).toThrow(/--threshold is a number/);
    expect(() => alertRuleInputOf({ ...ok, metric: 'realtime', filter: ['measure=events'] })).toThrow(
      /can't watch realtime/,
    );
  });

  it('changes only what the flags give, and drops a filter that belonged to another metric', () => {
    expect(alertRuleInputOf({ threshold: '5', notify: false, disable: true }, rule)).toMatchObject({
      name: 'Errors',
      query: rule.query,
      condition: { op: 'above', threshold: 5, minutes: 5 },
      notify: false,
      enabled: false,
    });
    expect(alertRuleInputOf({ stat: 'count' }, rule).query).toEqual({
      metric: 'requests',
      stat: 'count',
      filter: { status: ['5xx'] },
    });
    expect(alertRuleInputOf({ metric: 'latency' }, rule).query).toEqual({ metric: 'latency', stat: 'p95' });
    expect(() => alertRuleInputOf({ enable: true, disable: true }, rule)).toThrow(/contradict/);
  });

  it('lists rules with their state and value, and history newest first', () => {
    const out = plain(formatAlertRules([rule, { ...rule, id: 'a02', enabled: false, value: null }]));
    expect(out.split('\n')).toEqual([
      'id   name    stage  state  watches                                value  since                 notify',
      'a01  Errors  prod   alarm  5xx % of requests above 2% over 5 min  3.42%  2026-11-16 14:03:00Z  yes   ',
      'a02  Errors  prod   off    5xx % of requests above 2% over 5 min  -      2026-11-16 14:03:00Z  yes   ',
    ]);
    expect(plain(formatAlertRules([]))).toBe('(no alert rules; add one with `plat alerts create`)');
    expect(
      plain(
        formatAlertHistory([
          {
            ts: '2026-11-16T14:03:00.000Z',
            rule: 'a01',
            name: 'Errors',
            stage: 'prod',
            from: 'ok',
            to: 'alarm',
            value: 3.417,
            threshold: 2,
          },
        ]),
      ).split('\n')[1],
    ).toBe('2026-11-16 14:03:00Z  prod   Errors  ok → alarm  3.42   2        ');
  });
});

describe('plat metrics --metric and plat alerts', () => {
  const calls: string[] = [];
  let out = '';
  const series: SeriesResponse = {
    res: '5m',
    timestamps: ['2026-11-16T14:00:00.000Z'],
    unit: 'percent',
    series: [{ key: 'all', values: [3] }],
  };
  beforeEach(() => {
    calls.length = 0;
    out = '';
    const dir = tempDir();
    vi.stubEnv('PLAT_CONFIG_DIR', dir);
    // In CI the client would otherwise sign in with the workflow's OIDC token.
    vi.stubEnv('GITHUB_ACTIONS', '');
    saveCredentials({
      apiUrl: 'https://api.test',
      token: 't',
      github: 'bob',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${url}${typeof init?.body === 'string' ? ` ${init.body}` : ''}`);
      const path = new URL(url).pathname;
      if (method === 'DELETE') return new Response(null, { status: 204 });
      if (path.endsWith('/series')) return new Response(JSON.stringify(series));
      if (path.endsWith('/history')) return new Response(JSON.stringify({ events: [] }));
      if (method === 'GET') return new Response(JSON.stringify([rule]));
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as object) : {};
      return new Response(JSON.stringify({ ...rule, ...body }), {
        status: method === 'POST' ? 201 : 200,
      });
    });
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      out += String(chunk);
      return true;
    });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    setJsonMode(false);
  });
  const run = (...args: string[]) =>
    createProgram().parseAsync(['node', 'plat', ...args, '--app', 'shop', '--api-url', 'https://api.test']);

  it('sends the query and prints the raw answer with --json', async () => {
    await run(
      'metrics',
      '--metric',
      'requests',
      '--stat',
      'percent',
      '--filter',
      'status=5xx',
      '--filter',
      'route=GET /a',
      '--res',
      '5m',
      '--since',
      '1h',
      '--stage',
      'dev',
      '--json',
    );
    const url = new URL(calls[0]!.slice('GET '.length));
    expect(url.pathname).toBe('/v1/apps/shop/series');
    expect(url.searchParams.get('stage')).toBe('dev');
    expect(url.searchParams.get('res')).toBe('5m');
    expect(Number(url.searchParams.get('to')) - Number(url.searchParams.get('from'))).toBe(3_600_000);
    expect(JSON.parse(url.searchParams.get('q')!)).toEqual({
      metric: 'requests',
      stat: 'percent',
      filter: { routes: ['GET /a'], status: ['5xx'] },
    });
    expect(JSON.parse(out)).toEqual(series);
  });

  it('refuses query flags without --metric', async () => {
    const before = process.exitCode;
    await run('metrics', '--by', 'route');
    expect(process.exitCode).toBe(2);
    expect(calls).toEqual([]);
    process.exitCode = before;
  });

  it('lists, creates, updates, deletes and reads history', async () => {
    await run('alerts', '--stage', 'prod');
    await run(
      'alerts',
      'create',
      '--name',
      'Slow',
      '--metric',
      'latency',
      '--stat',
      'p99',
      '--op',
      'above',
      '--threshold',
      '800',
      '--minutes',
      '15',
      '--no-notify',
    );
    await run('alerts', 'update', 'a01', '--threshold', '5', '--enable');
    await run('alerts', 'delete', 'a01');
    await run('alerts', 'history', '--stage', 'prod', '--since', '1d');
    expect(calls.map((c) => c.replace(/from=\d+&to=\d+/, 'from=…&to=…'))).toEqual([
      'GET https://api.test/v1/apps/shop/alerts?stage=prod',
      `POST https://api.test/v1/apps/shop/alerts ${JSON.stringify({
        name: 'Slow',
        stage: 'prod',
        query: { metric: 'latency', stat: 'p99' },
        condition: { op: 'above', threshold: 800, minutes: 15 },
        missing: 'ok',
        notify: false,
        enabled: true,
      })}`,
      // An update starts from the rule as it is.
      'GET https://api.test/v1/apps/shop/alerts',
      `PUT https://api.test/v1/apps/shop/alerts/a01 ${JSON.stringify({
        name: 'Errors',
        stage: 'prod',
        query: rule.query,
        condition: { op: 'above', threshold: 5, minutes: 5 },
        missing: 'ok',
        notify: true,
        enabled: true,
      })}`,
      'DELETE https://api.test/v1/apps/shop/alerts/a01',
      'GET https://api.test/v1/apps/shop/alerts/history?stage=prod&from=…&to=…',
    ]);
    expect(plain(out)).toContain('✓ created a01 on prod: Slow (p99 latency above 800 ms over 15 min)');
    expect(plain(out)).toContain('(no state changes in this range)');
  });

  it('calls the series and alert endpoints', async () => {
    const api = new ApiClient({ baseUrl: 'https://api.test', token: 't' });
    await api.series('shop', { stage: 'prod', query: { metric: 'jobs', stat: 'count' }, from: 1, to: 2 });
    await api.alertRules('shop');
    expect(calls).toEqual([
      `GET https://api.test/v1/apps/shop/series?stage=prod&from=1&to=2&q=${encodeURIComponent(
        JSON.stringify({ metric: 'jobs', stat: 'count' }),
      )}`,
      'GET https://api.test/v1/apps/shop/alerts',
    ]);
  });
});
