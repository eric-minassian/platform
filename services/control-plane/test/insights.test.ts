import { assert, describe, it } from '@effect/vitest';
import type { LogLine, TelemetryEvent } from '@ericminassian/platform-core';
import { Effect } from 'effect';
import {
  checkLogFilters,
  checkTraceFilters,
  checkUserQuery,
  contextLines,
  decodeInsightsCursor,
  encodeInsightsCursor,
  filterConditions,
  hasStructuredFilters,
  insightsTime,
  LEVEL_CONDITIONS,
  levelOfRow,
  literalRegex,
  logStatsOf,
  matchesLogFilters,
  occurrencesOf,
  occurrencesQueries,
  pageRows,
  resultTable,
  searchQuery,
  searchTerms,
  statsQueries,
  str,
  traceSummary,
  tracesQuery,
} from '../src/insights.ts';
import { streamOfLogGroup, toLogLine } from '../src/logs.ts';

const base = { _p: 1 as const, ts: 1_000, app: 'shop', stage: 'prod', rev: 'd1', trace: 'abcdef0123456789' };

describe('query values', () => {
  it('quotes only values that need no escaping', () => {
    assert.strictEqual(str('/api/items/:id'), '"/api/items/:id"');
    for (const bad of ['a"b', 'a\\b', 'a\nb', 'a b', 'a\u0000b']) assert.throws(() => str(bad), /unquotable/);
  });

  it('escapes search text into a regex that matches it literally', () => {
    assert.strictEqual(literalRegex('timeout'), '/timeout/');
    assert.strictEqual(literalRegex('user_id 42'), '/user_id 42/');
    assert.strictEqual(literalRegex('GET /api/x?y=1'), '/GET \\/api\\/x\\?y\\=1/');
    assert.strictEqual(literalRegex('a.*b'), '/a\\.\\*b/');
    assert.strictEqual(literalRegex('"q" \\ `x`'), '/\\"q\\" \\\\ \\`x\\`/');
    assert.strictEqual(literalRegex('line\nbreak\ttab'), '/line\\x{a}break\\x{9}tab/');
    assert.strictEqual(literalRegex('café ✓'), '/café ✓/');
  });

  it('keeps an injection attempt inside the regex literal', () => {
    const regex = literalRegex('x/ | fields @message | filter 1 = 1 | /');
    // Every `/` but the delimiters is escaped, so the literal can't end early.
    assert.strictEqual(regex.slice(1, -1).replace(/\\./g, '').includes('/'), false);
    assert.strictEqual(regex.slice(1, -1).replace(/\\./g, '').includes('|'), false);
  });
});

describe('log filters', () => {
  it('validates every value that reaches a query', () => {
    assert.strictEqual(
      checkLogFilters({ routes: ['/api/items/:id'], revs: ['d01abc'], trace: 'abcdef01-23' }),
      undefined,
    );
    assert.match(checkLogFilters({ routes: ['/a") or 1=1'] }) ?? '', /must be a path pattern/);
    assert.match(checkLogFilters({ routes: ['api/no-slash'] }) ?? '', /must be a path pattern/);
    assert.match(checkLogFilters({ routes: ['/a\\b'] }) ?? '', /must be a path pattern/);
    assert.match(checkLogFilters({ revs: ['d1" or "'] }) ?? '', /isn't a deployment id/);
    assert.strictEqual(checkLogFilters({ trace: 'xyz' }), 'invalid trace id');
  });

  it('needs Logs Insights only for filters a log group choice can’t make', () => {
    assert.strictEqual(hasStructuredFilters(undefined), false);
    assert.strictEqual(hasStructuredFilters({ streams: ['web'], levels: [] }), false);
    assert.strictEqual(hasStructuredFilters({ status: ['5xx'] }), true);
  });

  it('turns each filter into one condition', () => {
    assert.deepStrictEqual(
      filterConditions({
        levels: ['warn', 'debug', 'warn'],
        routes: ['/a', '/b/:id'],
        status: ['4xx', '5xx'],
        revs: ['d1'],
        trace: 'abcdef01',
        streams: ['web'],
      }),
      [
        `(${LEVEL_CONDITIONS.warn} or ${LEVEL_CONDITIONS.debug})`,
        'route in ["/a", "/b/:id"]',
        '((status >= 400 and status < 500) or (status >= 500 and status < 600))',
        'rev in ["d1"]',
        'trace = "abcdef01"',
      ],
    );
  });

  it('reads the search text as terms', () => {
    assert.deepStrictEqual(searchTerms(undefined), { terms: [] });
    assert.deepStrictEqual(searchTerms('  connection reset  '), { terms: ['connection reset'] });
    assert.deepStrictEqual(searchTerms('"a b" "c \\"d\\""'), { terms: ['a b', 'c "d"'] });
    assert.ok('error' in searchTerms('{ $.status = 500 }'));
    assert.ok('error' in searchTerms('?ERROR ?WARN'));
    assert.ok('error' in searchTerms('"a" b'));
  });

  it('builds the search: newest first, within the page, filtered and with the text', () => {
    assert.strictEqual(
      searchQuery({
        filters: { status: ['5xx'], routes: ['/api/x'] },
        terms: ['tim"eout'],
        from: 1_000,
        to: 2_000.5,
        limit: 201,
      }),
      [
        'filter toMillis(@timestamp) >= 1000 and toMillis(@timestamp) <= 2001 and route in ["/api/x"] and ((status >= 500 and status < 600)) and @message like /tim\\"eout/',
        'fields @timestamp, @message, @log, @logStream',
        'sort @timestamp desc',
        'limit 201',
      ].join('\n| '),
    );
  });

  it('applies the same filters to live lines', () => {
    const line = (event: TelemetryEvent) => toLogLine('web', 0, JSON.stringify(event));
    const req = line({ ...base, t: 'req', method: 'GET', route: '/api/x', status: 503, dur: 5 });
    assert.ok(
      matchesLogFilters(req, { levels: ['error'], routes: ['/api/x'], status: ['5xx'], revs: ['d1'] }),
    );
    assert.ok(matchesLogFilters(req, { trace: base.trace, streams: ['web'] }));
    assert.notOk(matchesLogFilters(req, { levels: ['info'] }));
    assert.notOk(matchesLogFilters(req, { status: ['2xx'] }));
    assert.notOk(matchesLogFilters(req, { streams: ['worker'] }));
    const job = line({ ...base, t: 'job', kind: 'queue', name: 'q', status: 'error', dur: 5 });
    // A job's status is ok or error, not an HTTP status.
    assert.notOk(matchesLogFilters(job, { status: ['5xx'] }));
    const plain: LogLine = { ts: '2026-11-16T00:00:00.000Z', stream: 'web', message: 'hello' };
    assert.ok(matchesLogFilters(plain, {}));
    assert.notOk(matchesLogFilters(plain, { levels: ['info', 'error', 'warn', 'debug', 'system'] }));
  });
});

describe('levels', () => {
  /** A line's fields as the stats query groups them (`coalesce`d as `statsQueries` writes them). */
  const rowOf = (message: string) => {
    let j: Record<string, unknown> = {};
    try {
      j = JSON.parse(message) as Record<string, unknown>;
    } catch {}
    const status = typeof j.status === 'number' ? Math.floor(j.status / 100) : 0;
    return {
      tele: typeof j._p === 'number' ? String(j._p) : '0',
      tkind: typeof j.t === 'string' ? j.t : '',
      tlevel: typeof j.level === 'string' ? j.level : '',
      sclass: String(status),
      rtype: typeof j.type === 'string' ? j.type.slice(0, 9) : '',
    };
  };

  it('labels lines in stats exactly as the console does', () => {
    const lines: Array<[string, string | undefined]> = [
      [JSON.stringify({ ...base, t: 'log', level: 'warn', msg: 'w' }), 'warn'],
      [JSON.stringify({ ...base, t: 'log', level: 'debug', msg: 'd' }), 'debug'],
      [JSON.stringify({ ...base, t: 'log', level: 'error', msg: 'e' }), 'error'],
      [JSON.stringify({ ...base, t: 'log', level: 'info', msg: 'i', type: 'platform.mine' }), 'info'],
      [
        JSON.stringify({
          ...base,
          t: 'err',
          source: 'http',
          name: 'E',
          message: 'm',
          fingerprint: '0123abcd',
        }),
        'error',
      ],
      [JSON.stringify({ ...base, t: 'req', method: 'GET', route: '/', status: 500, dur: 1 }), 'error'],
      [JSON.stringify({ ...base, t: 'req', method: 'GET', route: '/', status: 404, dur: 1 }), 'info'],
      [JSON.stringify({ ...base, t: 'job', kind: 'cron', name: 'c', status: 'error', dur: 1 }), 'info'],
      [JSON.stringify({ ...base, t: 'span', op: 'db.get', status: 'ok', dur: 1, parent: 's' }), 'info'],
      [JSON.stringify({ ...base, t: 'metric', name: 'm', value: 1 }), 'info'],
      [JSON.stringify({ ...base, t: 'limit', name: 'l', ok: false }), 'info'],
      [JSON.stringify({ ...base, t: 'env', event: 'start', runtime: 'worker' }), 'info'],
      [
        JSON.stringify({ time: '2026-11-16T00:00:00Z', type: 'platform.report', record: { metrics: {} } }),
        'system',
      ],
      [JSON.stringify({ level: 'ERROR', message: 'Task timed out' }), undefined],
      ['plain text', undefined],
    ];
    for (const [message, level] of lines) {
      assert.strictEqual(toLogLine('web', 0, message).level, level, message);
      assert.strictEqual(levelOfRow(rowOf(message)), level, message);
    }
  });

  it('selects each level with one condition', () => {
    assert.strictEqual(LEVEL_CONDITIONS.system, '(type like /^platform\\./ and not ispresent(`_p`))');
    assert.strictEqual(
      LEVEL_CONDITIONS.error,
      '(`_p` = 1 and ((t = "log" and level = "error") or t = "err" or (t = "req" and status >= 500)))',
    );
    assert.strictEqual(
      LEVEL_CONDITIONS.info,
      '(`_p` = 1 and ((t = "log" and level = "info") or (t = "req" and status < 500) or t in ["job", "span", "metric", "limit", "env"]))',
    );
  });
});

describe('paging', () => {
  const row = (ts: number, key: string) => ({ ts, key });

  it('pages back in time without repeating or skipping lines that share a millisecond', () => {
    const all = [row(9, 'a'), row(8, 'b'), row(8, 'c'), row(8, 'd'), row(7, 'e'), row(7, 'f'), row(6, 'g')];
    // Each query reads lines at or before the cursor's time, as Logs Insights would.
    const query = (cursor: { b: number; s: readonly string[] } | undefined) =>
      all.filter((r) => !cursor || r.ts <= cursor.b);
    const seen: string[] = [];
    let cursor = undefined as { b: number; s: readonly string[] } | undefined;
    const pages: string[][] = [];
    do {
      const page = pageRows(query(cursor), cursor, 2);
      pages.push(page.rows.map((r) => r.key));
      seen.push(...page.rows.map((r) => r.key));
      cursor = page.next;
    } while (cursor);
    assert.deepStrictEqual(pages, [['a', 'b'], ['c', 'd'], ['e', 'f'], ['g']]);
    assert.deepStrictEqual(seen, ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  });

  it('keeps every key of a boundary that spans pages', () => {
    const rows = [row(5, 'a'), row(5, 'b'), row(5, 'c'), row(5, 'd'), row(4, 'e')];
    const first = pageRows(rows, undefined, 2);
    assert.deepStrictEqual(first.next, { b: 5, s: ['a', 'b'] });
    const second = pageRows(rows, first.next, 2);
    assert.deepStrictEqual(
      second.rows.map((r) => r.key),
      ['c', 'd'],
    );
    assert.deepStrictEqual(second.next, { b: 5, s: ['a', 'b', 'c', 'd'] });
    const third = pageRows(rows, second.next, 2);
    assert.deepStrictEqual(
      third.rows.map((r) => r.key),
      ['e'],
    );
    assert.strictEqual(third.next, undefined);
  });

  it('drops one line per remembered key, so identical lines both show', () => {
    const page = pageRows([row(5, 'x'), row(5, 'x'), row(4, 'y')], { b: 5, s: ['x'] }, 10);
    assert.deepStrictEqual(
      page.rows.map((r) => r.key),
      ['x', 'y'],
    );
  });

  it.effect('encodes the cursor as base64url JSON', () =>
    Effect.gen(function* () {
      const token = encodeInsightsCursor({ b: 1_700_000_000_123, s: ['0a1b2c3d'] });
      assert.deepStrictEqual(JSON.parse(Buffer.from(token, 'base64url').toString()), {
        b: 1_700_000_000_123,
        s: ['0a1b2c3d'],
      });
      assert.deepStrictEqual(yield* decodeInsightsCursor(token), { b: 1_700_000_000_123, s: ['0a1b2c3d'] });
      const filterPatternCursor = Buffer.from(JSON.stringify({ web: 'tok' })).toString('base64url');
      assert.ok((yield* Effect.flip(decodeInsightsCursor(filterPatternCursor))) !== undefined);
    }),
  );

  it('reads Logs Insights times as UTC', () => {
    assert.strictEqual(insightsTime('2026-11-16 16:30:00.123'), Date.parse('2026-11-16T16:30:00.123Z'));
    assert.ok(Number.isNaN(insightsTime(undefined)));
  });
});

describe('stats', () => {
  it('queries levels by what decides them, and each facet', () => {
    const q = statsQueries({ filters: { revs: ['d1'] }, terms: [], from: 0, to: 60_000, res: '5m' });
    assert.strictEqual(
      q.levels,
      [
        'filter toMillis(@timestamp) >= 0 and toMillis(@timestamp) <= 60000 and rev in ["d1"]',
        'fields coalesce(`_p`, 0) as tele, coalesce(t, "") as tkind, coalesce(level, "") as tlevel, coalesce(floor(status / 100), 0) as sclass, coalesce(substr(type, 0, 9), "") as rtype',
        'stats count(*) as n by bin(5m) as bucket, tele, tkind, tlevel, sclass, rtype',
      ].join('\n| '),
    );
    assert.match(q.routes, /stats count\(\*\) as n by route\n\| sort n desc\n\| limit 10$/);
    assert.match(q.streams, /stats count\(\*\) as n by @log$/);
  });

  it('counts lines per bucket by level and the commonest values', () => {
    const t0 = Date.parse('2026-11-16T10:00:00Z');
    const level = (bucket: string, n: number, over: Record<string, string>) => ({
      bucket,
      n: String(n),
      tele: '1',
      tkind: 'req',
      tlevel: '',
      sclass: '2',
      rtype: '',
      ...over,
    });
    const stats = logStatsOf({
      res: '5m',
      from: t0,
      to: t0 + 10 * 60_000,
      levels: [
        level('2026-11-16 10:00:00.000', 3, {}),
        level('2026-11-16 10:05:00.000', 2, { sclass: '5' }),
        level('2026-11-16 10:10:00.000', 1, { tele: '0', tkind: '', rtype: 'platform.' }),
        level('2026-11-16 10:10:00.000', 4, { tele: '0', tkind: '' }),
      ],
      streams: [
        { '@log': '000000000000:/platform/apps/shop/prod/web', n: '9' },
        { '@log': '000000000000:/platform/apps/shop/prod/services/ais', n: '1' },
      ],
      routes: [
        { route: '/b', n: '1' },
        { route: '/a', n: '5' },
      ],
      status: [
        { sclass: '2', n: '3' },
        { sclass: '5', n: '2' },
        { sclass: '1', n: '7' },
      ],
      revs: [{ rev: 'd1', n: '10' }],
      streamOf: streamOfLogGroup,
    });
    assert.deepStrictEqual(stats.timestamps, [
      '2026-11-16T10:00:00.000Z',
      '2026-11-16T10:05:00.000Z',
      '2026-11-16T10:10:00.000Z',
    ]);
    assert.deepStrictEqual(stats.levels.info, [3, 0, 0]);
    assert.deepStrictEqual(stats.levels.error, [0, 2, 0]);
    assert.deepStrictEqual(stats.levels.system, [0, 0, 1]);
    assert.strictEqual(stats.total, 10);
    assert.deepStrictEqual(stats.facets.level, [
      { value: 'info', count: 3 },
      { value: 'error', count: 2 },
      { value: 'system', count: 1 },
    ]);
    assert.deepStrictEqual(stats.facets.stream, [
      { value: 'web', count: 9 },
      { value: 'service:ais', count: 1 },
    ]);
    assert.deepStrictEqual(stats.facets.route, [
      { value: '/a', count: 5 },
      { value: '/b', count: 1 },
    ]);
    assert.deepStrictEqual(stats.facets.status, [
      { value: '2xx', count: 3 },
      { value: '5xx', count: 2 },
    ]);
  });
});

describe('traces', () => {
  it('validates routes and jobs', () => {
    assert.strictEqual(
      checkTraceFilters({ routes: ['GET /api/items/:id'], jobs: ['service:ais/flush'] }),
      undefined,
    );
    assert.match(checkTraceFilters({ routes: ['/api/x'] }) ?? '', /METHOD \/pattern/);
    assert.match(checkTraceFilters({ routes: ['GET /a"b'] }) ?? '', /path pattern/);
    assert.match(checkTraceFilters({ jobs: ['refresh'] }) ?? '', /kind:name/);
    assert.match(checkTraceFilters({ jobs: ['queue:a"b'] }) ?? '', /kind:name/);
    assert.match(checkTraceFilters({ jobs: ['nope:x'] }) ?? '', /kind:name/);
    assert.strictEqual(checkTraceFilters({ minMs: -1 }), 'minMs can’t be negative');
  });

  it('reads root lines, newest first, with the filters', () => {
    assert.strictEqual(
      tracesQuery({
        filters: {
          routes: ['GET /a'],
          jobs: ['queue:refresh'],
          outcome: 'error',
          minMs: 1e-7 + 250,
          recorded: true,
        },
        from: 0,
        to: 1_000,
        limit: 201,
      }),
      [
        'filter toMillis(@timestamp) >= 0 and toMillis(@timestamp) <= 1000 and `_p` = 1 and t in ["req", "job"] and ispresent(trace) and not ispresent(parent)' +
          ' and ((t = "req" and method = "GET" and route = "/a") or (t = "job" and kind = "queue" and name = "refresh"))' +
          ' and ((t = "req" and status >= 500) or (t = "job" and status = "error")) and dur >= 250 and ispresent(span)',
        'fields @timestamp, @message',
        'sort @timestamp desc',
        'limit 201',
      ].join('\n| '),
    );
    assert.match(
      tracesQuery({ filters: { kind: 'job', outcome: 'ok' }, from: 0, to: 1, limit: 1 }),
      /t = "job" and ispresent/,
    );
  });

  it('maps a root line to its row, starting when it started', () => {
    const req: TelemetryEvent = {
      ...base,
      ts: 10_000,
      t: 'req',
      method: 'POST',
      route: '/api/x',
      status: 502,
      dur: 1_500,
      span: 's1',
      calls: 3,
      callMs: 4,
    };
    assert.deepStrictEqual(traceSummary(req), {
      trace: base.trace,
      ts: new Date(8_500).toISOString(),
      kind: 'req',
      name: 'POST /api/x',
      status: 502,
      failed: true,
      dur: 1_500,
      recorded: true,
      calls: 3,
      rev: 'd1',
    });
    const job: TelemetryEvent = {
      ...base,
      ts: 10_000,
      t: 'job',
      kind: 'queue',
      name: 'refresh',
      status: 'ok',
      dur: 20,
      calls: 2,
      callMs: 9,
    };
    assert.deepStrictEqual(traceSummary(job), {
      trace: base.trace,
      ts: new Date(9_980).toISOString(),
      kind: 'job',
      name: 'queue refresh',
      failed: false,
      dur: 20,
      recorded: false,
      calls: 2,
      rev: 'd1',
    });
    assert.strictEqual(
      traceSummary({ ...base, t: 'span', op: 'db.get', status: 'ok', dur: 1, parent: 's1' }),
      undefined,
    );
    const { trace: _, ...untraced } = req;
    assert.strictEqual(traceSummary(untraced as TelemetryEvent), undefined);
  });
});

describe('error occurrences', () => {
  it('queries one well-formed fingerprint', () => {
    const q = occurrencesQueries({ fingerprint: '0a1b2c3d', from: 0, to: 1, res: '1h' });
    assert.match(
      q.buckets,
      /t = "err" and fingerprint = "0a1b2c3d"\n\| stats count\(\*\) as n by bin\(1h\) as bucket$/,
    );
    assert.throws(() => occurrencesQueries({ fingerprint: '0a1b2c3d" or "', from: 0, to: 1, res: '1h' }));
  });

  it('counts per bucket and per deployment', () => {
    const t0 = Date.parse('2026-11-16T00:00:00Z');
    const res = occurrencesOf({
      res: '1h',
      from: t0,
      to: t0 + 2 * 3_600_000,
      buckets: [{ bucket: '2026-11-16 01:00:00.000', n: '4' }],
      revs: [
        { rev: 'd2', n: '1' },
        { rev: 'd1', n: '3' },
      ],
    });
    assert.deepStrictEqual(res.counts, [0, 4, 0]);
    assert.deepStrictEqual(res.revs, [
      { value: 'd1', count: 3 },
      { value: 'd2', count: 1 },
    ]);
  });
});

describe('members’ own queries', () => {
  it('refuses any that picks its own log groups', () => {
    for (const query of [
      'SOURCE logGroups(namePrefix: ["/platform/apps/other"]) | fields @message',
      'source logGroups()',
      '  Source logGroups() | limit 1',
      'fields @message\n| SOURCE logGroups()',
      'fields @message |source x',
      '# a comment\nSOURCE logGroups()',
      'ſource logGroups()',
      'fields @message | filter x = 1 | logGroups (namePrefix: ["/"])',
      'fields @message | display LOGGROUPS(class: "STANDARD")',
    ])
      assert.ok(checkUserQuery(query), query);
  });

  it('allows the `source` field of error lines', () => {
    for (const query of [
      'filter t = "err" and source = "job" | stats count(*) by source',
      'fields @timestamp, source, @message | sort @timestamp desc',
      'filter @message like /resource/ | fields `source`',
    ])
      assert.strictEqual(checkUserQuery(query), undefined, query);
  });

  it('answers columns in the order fields first appear, without @ptr', () => {
    const table = resultTable([
      [
        { field: 'route', value: '/a' },
        { field: 'n', value: '3' },
        { field: '@ptr', value: 'p' },
      ],
      [
        { field: 'route', value: '/b' },
        { field: 'extra', value: 'x' },
      ],
    ]);
    assert.deepStrictEqual(table, {
      columns: ['route', 'n', 'extra'],
      rows: [
        ['/a', '3', null],
        ['/b', null, 'x'],
      ],
    });
  });
});

describe('context', () => {
  const line = (ts: number, message: string): LogLine => ({
    ts: new Date(ts).toISOString(),
    stream: 'web',
    message,
  });

  it('anchors on the line logged at the time, around which it counts', () => {
    const before = [line(1, 'a'), line(2, 'b'), line(3, 'c')];
    // CloudWatch stamps a line a little after its own time: `x` was logged at 10 but stamped 12.
    const after = [line(11, 'y'), line(10, 'x'), line(13, 'z'), line(14, 'w')];
    const found = contextLines(before, after, 10, { before: 2, after: 1 });
    assert.deepStrictEqual(
      found?.lines.map((l) => l.message),
      ['c', 'y', 'x', 'z'],
    );
    assert.strictEqual(found?.anchor, 2);
  });

  it('falls back to the first line after, then the last line before', () => {
    const after = contextLines([line(1, 'a')], [line(20, 'b'), line(21, 'c')], 10, { before: 5, after: 5 });
    assert.deepStrictEqual(after, { lines: [line(1, 'a'), line(20, 'b'), line(21, 'c')], anchor: 1 });
    const last = contextLines([line(1, 'a'), line(2, 'b')], [], 10, { before: 1, after: 5 });
    assert.deepStrictEqual(last, { lines: [line(1, 'a'), line(2, 'b')], anchor: 1 });
    assert.strictEqual(contextLines([], [], 10, { before: 5, after: 5 }), undefined);
  });
});
