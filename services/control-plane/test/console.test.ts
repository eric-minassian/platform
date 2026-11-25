import type { MetricsView, SeriesResponse, TelemetryEvent } from '@ericminassian/platform-core';
import { describe, expect, it } from 'vitest';
import { evalExpr, exprRefs, parseExpr } from '../web/src/lib/expr.ts';
import { chartOf } from '../web/src/lib/insights.ts';
import {
  apiTime,
  describeTime,
  resolveWindow,
  validateTimeSearch,
  zoomOut,
  zoomTo,
} from '../web/src/lib/time.ts';
import { layoutTrace, type TraceSpan } from '../web/src/lib/trace.ts';
import { resolveView, viewResolution } from '../web/src/lib/view.ts';

describe('expressions', () => {
  const run = (src: string, vars: Record<string, number | null>) =>
    evalExpr(parseExpr(src), new Map(Object.entries(vars)));

  it('follows arithmetic precedence', () => {
    expect(run('100 * b / a', { a: 200, b: 3 })).toBe(1.5);
    expect(run('a + b * 2', { a: 1, b: 3 })).toBe(7);
    expect(run('(a + b) * 2', { a: 1, b: 3 })).toBe(8);
    expect(run('-a + 1.5e1', { a: 5 })).toBe(10);
  });

  it('is empty where an input is missing or a division has nothing under it', () => {
    expect(run('a / b', { a: 1, b: 0 })).toBeNull();
    expect(run('a + b', { a: 1, b: null })).toBeNull();
    expect(run('a + c', { a: 1 })).toBeNull();
  });

  it('names the queries it reads and refuses what it cannot parse', () => {
    expect([...exprRefs(parseExpr('100 * A / b'))]).toEqual(['a', 'b']);
    expect(() => parseExpr('a +')).toThrow(/ends early/);
    expect(() => parseExpr('(a + b')).toThrow(/never closed/);
    expect(() => parseExpr('a; b')).toThrow(/unexpected ";"/);
    expect(() => parseExpr('')).toThrow(/empty/);
  });
});

describe('the time model', () => {
  const now = Date.UTC(2026, 10, 16, 14, 0);

  it('reads a URL leniently', () => {
    expect(validateTimeSearch({ range: '6h' })).toEqual({ range: '6h' });
    expect(validateTimeSearch({ range: 'forever' })).toEqual({});
    expect(validateTimeSearch({ from: 1000, to: 2000, range: '6h' })).toEqual({ from: 1000, to: 2000 });
    expect(validateTimeSearch({ from: '1000', to: '2000' })).toEqual({ from: 1000, to: 2000 });
    // An inverted window isn't a window.
    expect(validateTimeSearch({ from: 2000, to: 1000 })).toEqual({});
  });

  it('sends a moving window as a range and a fixed one as from/to', () => {
    expect(apiTime({})).toEqual({ range: '24h' });
    expect(apiTime({ range: '7d' })).toEqual({ range: '7d' });
    expect(apiTime({ from: 1, to: 2 })).toEqual({ from: '1', to: '2' });
    expect(resolveWindow({ range: '1h' }, now)).toEqual({ from: now - 3_600_000, to: now, relative: '1h' });
  });

  it('zooms in to at least a minute and out around the same center', () => {
    expect(zoomTo(5000, 1000)).toEqual({ from: 1000, to: 61_000, range: undefined });
    const out = zoomOut({ from: 1_000_000, to: 2_000_000 });
    expect(out).toEqual({ from: 500_000, to: 2_500_000, range: undefined });
    expect(describeTime({ range: '24h' }, false)).toBe('Last 24 hours');
  });
});

describe('trace layout', () => {
  const base = { _p: 1 as const, app: 'a', stage: 'prod', rev: 'r', trace: 't' };
  const events: TelemetryEvent[] = [
    {
      ...base,
      t: 'span',
      ts: 1090,
      op: 'fetch',
      name: 'x',
      dur: 60,
      status: 'ok',
      start: 30,
      span: 's2',
      parent: 's1',
    },
    { ...base, t: 'req', ts: 1100, method: 'GET', route: '/x', status: 500, dur: 100, span: 's1' },
    {
      ...base,
      t: 'span',
      ts: 1020,
      op: 'db.get',
      name: 'k',
      dur: 10,
      status: 'ok',
      start: 10,
      span: 's3',
      parent: 's1',
    },
    {
      ...base,
      t: 'span',
      ts: 1080,
      op: 'db.query',
      dur: 5,
      status: 'error',
      start: 70,
      span: 's4',
      parent: 's2',
    },
    { ...base, t: 'err', ts: 1099, source: 'http', name: 'TypeError', message: 'boom', fingerprint: 'f' },
  ];

  const flat = (spans: readonly TraceSpan[]): TraceSpan[] =>
    spans.flatMap((s) => [s, ...flat(s.children ?? [])]);

  it('nests each span under its caller, in start order', () => {
    const { spans, root, total } = layoutTrace(events);
    expect(flat(spans).map((s) => [s.op, s.depth, s.start])).toEqual([
      ['GET', 0, 0],
      ['db.get', 1, 10],
      ['fetch', 1, 30],
      ['db.query', 2, 70],
    ]);
    expect(root).toMatchObject({ value: 's1', failed: true, label: 'GET /x', status: '500' });
    expect(total).toBe(100);
  });

  it('lists errors and logs with the span they happened in', () => {
    const { lines } = layoutTrace([
      ...events,
      { ...base, t: 'log', ts: 1050, level: 'warn', msg: 'slow', parent: 's2' },
    ]);
    expect(lines.map((l) => [l.level, l.at, l.span, l.text])).toEqual([
      ['warn', 50, 's2', 'slow'],
      ['error', 99, 's1', 'TypeError: boom'],
    ]);
  });

  it('places spans from their own request or job', () => {
    const { spans } = layoutTrace([
      { ...base, t: 'req', ts: 1100, method: 'POST', route: '/x', status: 202, dur: 100, span: 'r' },
      { ...base, t: 'job', ts: 1500, kind: 'queue', name: 'q', status: 'ok', dur: 200, span: 'j' },
      {
        ...base,
        t: 'span',
        ts: 1450,
        op: 'db.put',
        dur: 50,
        status: 'ok',
        start: 100,
        span: 'k',
        parent: 'j',
      },
    ]);
    expect(flat(spans).map((s) => [s.value, s.start])).toEqual([
      ['r', 0],
      ['j', 300],
      ['k', 400],
    ]);
  });

  it('shows the calls a request made without keeping them', () => {
    const { root } = layoutTrace([
      { ...base, t: 'req', ts: 50, method: 'GET', route: '/', status: 200, dur: 20, calls: 4, callMs: 12 },
    ]);
    expect(root?.unrecorded).toEqual({ calls: 4, ms: 12 });
  });
});

describe('explorer views', () => {
  const ts = ['2026-11-16T10:00:00.000Z', '2026-11-16T10:10:00.000Z'];
  const answer = (series: SeriesResponse['series'], unit = 'count'): SeriesResponse => ({
    res: '10m',
    timestamps: ts,
    unit,
    series,
  });

  it('keeps status classes in their order with their colors', () => {
    const view: MetricsView = {
      kind: 'metrics',
      queries: [{ id: 'a', metric: 'requests', stat: 'count', groupBy: 'status' }],
      chart: 'bar',
    };
    const { lines, stepMs } = resolveView(view, [
      answer([
        { key: '5xx', values: [1, 2] },
        { key: '2xx', values: [10, 20] },
      ]),
    ]);
    expect(lines.map((l) => [l.label, l.color])).toEqual([
      ['2xx', 'var(--s2xx)'],
      ['5xx', 'var(--s5xx)'],
    ]);
    expect(stepMs).toBe(600_000);
  });

  it('evaluates expressions per bucket, a grouped query as the sum of its groups', () => {
    const view: MetricsView = {
      kind: 'metrics',
      queries: [
        { id: 'a', metric: 'requests', stat: 'count', hidden: true },
        { id: 'b', metric: 'requests', stat: 'count', groupBy: 'route', hidden: true },
      ],
      expressions: [{ id: 'e1', expr: '100 * b / a', label: 'share' }],
      chart: 'line',
    };
    const { lines, errors } = resolveView(view, [
      answer([{ key: 'all', values: [10, 0] }]),
      answer([
        { key: 'GET /x', values: [2, 0] },
        { key: 'GET /y', values: [3, null] },
      ]),
    ]);
    expect(errors).toEqual([]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ id: 'e1', label: 'share', values: [50, null] });
  });

  it('reports an expression that names an unknown query', () => {
    const view: MetricsView = {
      kind: 'metrics',
      queries: [{ id: 'a', metric: 'requests', stat: 'count' }],
      expressions: [{ id: 'e1', expr: 'a / z' }],
      chart: 'line',
    };
    expect(resolveView(view, [answer([{ key: 'all', values: [1, 2] }])]).errors).toEqual([
      "e1: z isn't a query",
    ]);
  });

  it('picks one bucket size for every query of a window', () => {
    const now = Date.UTC(2026, 10, 16, 14, 0);
    expect(viewResolution({ range: '1h' }, now)).toBe('1m');
    expect(viewResolution({ range: '24h' }, now)).toBe('10m');
    expect(viewResolution({ range: '30d' }, now)).toBe('1d');
  });
});

describe('Logs Insights charts', () => {
  it('charts a stats-by-bin result, split by its other column', () => {
    const chart = chartOf({
      columns: ['bin(5m)', 'status', 'count()'],
      rows: [
        ['2026-11-16 10:00:00.000', '2xx', '10'],
        ['2026-11-16 10:00:00.000', '5xx', '1'],
        ['2026-11-16 10:05:00.000', '2xx', '12'],
      ],
      recordsMatched: 23,
      recordsScanned: 100,
      bytesScanned: 1000,
    });
    expect(chart?.stepMs).toBe(300_000);
    expect(chart?.series.map((s) => [s.key, s.values])).toEqual([
      ['2xx', [10, 12]],
      ['5xx', [1, null]],
    ]);
  });

  it('leaves a plain table as a table', () => {
    expect(
      chartOf({
        columns: ['@timestamp', '@message'],
        rows: [['x', 'y']],
        recordsMatched: 1,
        recordsScanned: 1,
        bytesScanned: 1,
      }),
    ).toBeUndefined();
  });
});
