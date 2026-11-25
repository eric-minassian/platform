import { stripVTControlCharacters } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../src/api.ts';
import {
  collectList,
  formatContext,
  formatInsights,
  formatOccurrences,
  formatTraceList,
  lineTime,
  logFilters,
} from '../src/commands/observe.ts';
import { saveCredentials } from '../src/credentials.ts';
import { createProgram } from '../src/main.ts';
import { setJsonMode } from '../src/util/output.ts';
import { tempDir } from './helpers.ts';

const plain = stripVTControlCharacters;

const at = '2026-11-16T10:00:00.000Z';
describe('log filter options', () => {
  it('builds the structured filters, checking levels and status classes', () => {
    expect(
      logFilters({ level: ['error', 'warn'], route: ['/a'], status: ['5xx'], rev: [], trace: 'abcdef01' }),
    ).toEqual({ levels: ['error', 'warn'], routes: ['/a'], status: ['5xx'], trace: 'abcdef01' });
    expect(logFilters({ level: [], route: [], status: [], rev: [] })).toEqual({});
    expect(() => logFilters({ level: ['fatal'], route: [], status: [], rev: [] })).toThrow(/--level takes/);
    expect(() => logFilters({ level: [], route: [], status: ['500'], rev: [] })).toThrow(/--status takes/);
    expect(collectList('error, warn', ['info'])).toEqual(['info', 'error', 'warn']);
    expect(lineTime('1794823200000')).toBe(1794823200000);
    expect(lineTime('2026-11-16T10:00:00Z')).toBe(Date.parse('2026-11-16T10:00:00Z'));
    expect(() => lineTime('noon')).toThrow(/--around takes/);
  });
});

describe('output', () => {
  it('lists traces with how they ended and whether their calls were recorded', () => {
    const out = plain(
      formatTraceList({
        traces: [
          {
            trace: 't1',
            ts: at,
            kind: 'req',
            name: 'GET /a',
            status: 503,
            failed: true,
            dur: 1_500,
            recorded: true,
            rev: 'd1',
          },
          {
            trace: 't2',
            ts: at,
            kind: 'job',
            name: 'queue refresh',
            failed: false,
            dur: 20,
            recorded: false,
            calls: 3,
          },
        ],
        truncated: true,
      }),
    ).split('\n');
    expect(out[1]?.trimEnd()).toMatch(/^2026-11-16 10:00:00Z\s+GET \/a\s+503\s+1\.5s\s+recorded\s+t1$/);
    expect(out[2]?.trimEnd()).toMatch(/queue refresh\s+ok\s+20ms\s+3 not recorded\s+t2$/);
    expect(out[3]).toBe('more traces matched; narrow --since or the filters to see them');
  });

  it('prints a Logs Insights result as a table', () => {
    const out = plain(
      formatInsights({
        columns: ['route', 'n'],
        rows: [
          ['/a', '2'],
          ['/b', null],
        ],
        recordsMatched: 2,
        recordsScanned: 40,
        bytesScanned: 12_345,
      }),
    );
    expect(out.split('\n')).toEqual(['route  n', '/a     2', '/b      ', '2 matched, 40 scanned (12.3 kB)']);
  });

  it('marks the line context is around, and hides runtime records unless asked', () => {
    const line = (message: string, level?: string) => ({
      ts: at,
      stream: 'web',
      message,
      ...(level ? { level } : {}),
    });
    const r = { lines: [line('a'), line('runtime: init', 'system'), line('b'), line('c')], anchor: 2 };
    expect(plain(formatContext(r, { runtime: false })).split('\n')).toEqual([
      '  2026-11-16 10:00:00Z web    a',
      '> 2026-11-16 10:00:00Z web    b',
      '  2026-11-16 10:00:00Z web    c',
    ]);
    expect(plain(formatContext(r, { runtime: true })).split('\n')).toHaveLength(4);
  });

  it('shows an error group’s occurrences over time and by deployment', () => {
    const out = plain(
      formatOccurrences(
        { res: '1h', timestamps: [at, at], counts: [1, 3], revs: [{ value: 'd2', count: 4 }] },
        '7d',
      ),
    );
    expect(out.split('\n')).toEqual([
      '4 in the last 7d (1h buckets)  ▁█',
      '',
      'deployment  count',
      'd2          4    ',
    ]);
  });
});

describe('requests', () => {
  it('sends filters as JSON and calls the new endpoints', async () => {
    const calls: string[] = [];
    const api = new ApiClient({
      baseUrl: 'https://api.test',
      token: 't',
      fetch: (async (url: string, init?: RequestInit) => {
        calls.push(
          `${init?.method ?? 'GET'} ${decodeURIComponent(url)}${typeof init?.body === 'string' ? ` ${init.body}` : ''}`,
        );
        return new Response(init?.method === 'DELETE' ? null : '[]', {
          status: init?.method === 'DELETE' ? 204 : 200,
        });
      }) as unknown as typeof fetch,
    });
    await api.logs('shop', { stage: 'prod', from: 1, to: 2, filters: { levels: ['error'] } });
    await api.logs('shop', { stage: 'prod', from: 1, filters: {} });
    await api.traces('shop', { stage: 'prod', from: 1, to: 2, filters: { outcome: 'error' }, limit: 5 });
    await api.logStats('shop', { stage: 'prod', from: 1, to: 2, filter: 'x' });
    await api.logContext('shop', { stage: 'prod', stream: 'web', ts: 5, before: 1, after: 2 });
    await api.insights('shop', { stage: 'prod', query: 'fields @message' });
    await api.errorOccurrences('shop', '0a1b2c3d', { stage: 'prod', from: 1, to: 2 });
    expect(calls).toEqual([
      'GET https://api.test/v1/apps/shop/logs?stage=prod&from=1&to=2&f={"levels":["error"]}',
      'GET https://api.test/v1/apps/shop/logs?stage=prod&from=1',
      'GET https://api.test/v1/apps/shop/traces?stage=prod&from=1&to=2&limit=5&f={"outcome":"error"}',
      'GET https://api.test/v1/apps/shop/logs/stats?stage=prod&from=1&to=2&q=x',
      'GET https://api.test/v1/apps/shop/logs/context?stage=prod&stream=web&ts=5&before=1&after=2',
      'POST https://api.test/v1/apps/shop/insights {"stage":"prod","query":"fields @message"}',
      'GET https://api.test/v1/apps/shop/errors/0a1b2c3d/occurrences?stage=prod&from=1&to=2',
    ]);
  });
});

describe('commands', () => {
  const calls: Array<{ method: string; url: URL; body?: unknown }> = [];
  let out = '';
  let dir = '';
  beforeEach(() => {
    calls.length = 0;
    out = '';
    dir = tempDir();
    vi.stubEnv('PLAT_CONFIG_DIR', dir);
    vi.stubEnv('GITHUB_ACTIONS', '');
    saveCredentials({
      apiUrl: 'https://api.test',
      token: 't',
      github: 'bob',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      calls.push({
        method: init?.method ?? 'GET',
        url: u,
        ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) } : {}),
      });
      const path = u.pathname;
      const body = path.endsWith('/logs')
        ? { lines: [] }
        : path.endsWith('/traces')
          ? { traces: [], truncated: false }
          : path.endsWith('/insights')
            ? { columns: [], rows: [], recordsMatched: 0, recordsScanned: 0, bytesScanned: 0 }
            : path.endsWith('/occurrences')
              ? { res: '1h', timestamps: [], counts: [], revs: [] }
              : path.endsWith('/context')
                ? { lines: [], anchor: 0 }
                : {};
      return new Response(JSON.stringify(body));
    });
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      out += String(chunk);
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    setJsonMode(false);
    process.exitCode = undefined;
  });
  const run = (...args: string[]) =>
    createProgram().parseAsync(['node', 'plat', ...args, '--api-url', 'https://api.test']);
  const filtersOf = (call: { url: URL } | undefined) =>
    JSON.parse(call?.url.searchParams.get('f') ?? 'null') as unknown;

  it('searches logs with structured filters, runs Logs Insights and reads context', async () => {
    await run(
      'logs',
      '--app',
      'shop',
      '--level',
      'error,warn',
      '--status',
      '5xx',
      '--route',
      '/api/x',
      '--rev',
      'd1',
      '--since',
      '30m',
    );
    expect(calls[0]?.url.pathname).toBe('/v1/apps/shop/logs');
    expect(filtersOf(calls[0])).toEqual({
      levels: ['error', 'warn'],
      routes: ['/api/x'],
      status: ['5xx'],
      revs: ['d1'],
    });

    await run('logs', '--app', 'shop', '--insights', 'stats count(*) by route', '--stage', 'pr-1');
    expect(calls[1]?.method).toBe('POST');
    expect(calls[1]?.body).toMatchObject({ stage: 'pr-1', query: 'stats count(*) by route' });

    await run(
      'logs',
      '--app',
      'shop',
      '--around',
      '2026-11-16T10:00:00Z',
      '--stream',
      'worker',
      '--context',
      '10',
    );
    expect(calls[2]?.url.pathname).toBe('/v1/apps/shop/logs/context');
    expect(calls[2]?.url.search).toBe(
      `?stage=prod&stream=worker&ts=${Date.parse('2026-11-16T10:00:00Z')}&before=10&after=10`,
    );

    await run('logs', '--app', 'shop', '--around', '1794823200000');
    expect(process.exitCode).toBe(2);
    expect(calls).toHaveLength(3);
  });

  it('lists traces with filters, or shows one', async () => {
    await run(
      'traces',
      '--app',
      'shop',
      '--failed',
      '--route',
      'GET /api/x',
      '--job',
      'queue:refresh',
      '--min-ms',
      '500',
      '--recorded',
      '--limit',
      '20',
    );
    expect(calls[0]?.url.pathname).toBe('/v1/apps/shop/traces');
    expect(calls[0]?.url.searchParams.get('limit')).toBe('20');
    expect(filtersOf(calls[0])).toEqual({
      routes: ['GET /api/x'],
      jobs: ['queue:refresh'],
      outcome: 'error',
      minMs: 500,
      recorded: true,
    });
    await run('traces', 'abcdef0123', '--app', 'shop');
    expect(calls[1]?.url.pathname).toBe('/v1/apps/shop/traces/abcdef0123');
  });

  it('reads an error group’s occurrences', async () => {
    await run('errors', '0a1b2c3d', '--occurrences', '--since', '1d', '--app', 'shop', '--json');
    expect(calls[0]?.url.pathname).toBe('/v1/apps/shop/errors/0a1b2c3d/occurrences');
    expect(JSON.parse(out)).toEqual({ res: '1h', timestamps: [], counts: [], revs: [] });
  });
});
