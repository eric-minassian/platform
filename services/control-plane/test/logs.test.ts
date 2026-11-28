import type { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import { assert, describe, it } from '@effect/vitest';
import type { TelemetryEvent } from '@ericminassian/platform-core';
import { type Duration, Effect, Fiber, Layer, Stream } from 'effect';
import { TestClock } from 'effect/testing';
import { decodeInsightsCursor } from '../src/insights.ts';
import { CONTEXT_READ_CAP, lastEventsBefore, Logs, type TimedEvent, type WindowReader } from '../src/logs.ts';
import { awsLayer, settingsLayer } from './support.ts';

type Command = { readonly constructor: { readonly name: string }; readonly input: Record<string, unknown> };

const PREFIX = '/platform/apps/shop/prod/';
const T0 = Date.parse('2026-11-16T10:00:00Z');
const base = { _p: 1 as const, app: 'shop', stage: 'prod', rev: 'd1', trace: 'abcdef0123456789' };

/** `Logs` over a CloudWatch Logs client whose stage has `groups`, answering everything else with `answer`. */
const logsWith = (answer: (command: Command) => unknown, groups = ['web', 'web.local', 'worker']) => {
  const sent: Command[] = [];
  const client = {
    send: async (command: Command) => {
      sent.push(command);
      if (command.constructor.name === 'DescribeLogGroupsCommand')
        return { logGroups: groups.map((g) => ({ logGroupName: `${PREFIX}${g}` })) };
      return answer(command);
    },
  } as unknown as CloudWatchLogsClient;
  const layer = Logs.layer.pipe(Layer.provide([awsLayer({ logs: () => client }), settingsLayer()]));
  return {
    sent,
    started: () => sent.filter((c) => c.constructor.name === 'StartQueryCommand').map((c) => c.input),
    use: <A, E>(f: (l: Logs['Service']) => Effect.Effect<A, E>) => Effect.provide(Logs.use(f), layer),
  };
};

/** Logs Insights answering every query with the rows `rows` gives for its query string. */
const insights = (rows: (query: string) => ReadonlyArray<Record<string, string>>) => {
  const queries = new Map<string, string>();
  return (command: Command) => {
    if (command.constructor.name === 'StartQueryCommand') {
      const queryId = `q${queries.size}`;
      queries.set(queryId, String(command.input.queryString));
      return { queryId };
    }
    if (command.constructor.name === 'GetQueryResultsCommand') {
      const query = queries.get(String(command.input.queryId)) ?? '';
      return {
        status: 'Complete',
        results: rows(query).map((r) => Object.entries(r).map(([field, value]) => ({ field, value }))),
        statistics: { recordsMatched: 2, recordsScanned: 10, bytesScanned: 1_000 },
      };
    }
    throw new Error(`unexpected ${command.constructor.name}`);
  };
};

/** Runs `effect` to its end, moving the test clock on while it polls Logs Insights. */
const settle = <A, E>(effect: Effect.Effect<A, E>, step: Duration.Input = '1 second') =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(effect);
    for (let i = 0; i < 100 && !fiber.pollUnsafe(); i++) {
      yield* Effect.promise(() => new Promise((resolve) => setImmediate(resolve)));
      yield* TestClock.adjust(step);
    }
    return yield* Fiber.join(fiber);
  });

const insightsTime = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '');
const awsError = (name: string, message: string) => Object.assign(new Error(message), { name });

describe('filtered log search', () => {
  const line = (ms: number, stream: string, event: Record<string, unknown>) => ({
    '@timestamp': insightsTime(ms),
    '@log': `000000000000:${PREFIX}${stream}`,
    '@logStream': 'ls',
    '@message': JSON.stringify({ ...base, ts: ms, ...event }),
    '@ptr': 'p',
  });
  const rows = [
    line(T0 + 3_000, 'web', { t: 'err', source: 'http', name: 'E', message: 'one', fingerprint: '0a1b2c3d' }),
    line(T0 + 2_000, 'worker', { t: 'log', level: 'error', msg: 'two' }),
    line(T0 + 2_000, 'web', { t: 'log', level: 'error', msg: 'three' }),
  ];
  /** The rows at or before the query's upper time bound, newest first. */
  const upTo = (query: string) => {
    const upper = Number(/toMillis\(@timestamp\) <= (\d+)/.exec(query)?.[1]);
    return rows.filter((r) => Date.parse(`${r['@timestamp'].replace(' ', 'T')}Z`) <= upper);
  };

  it.effect('runs on Logs Insights over the chosen streams, paging back in time', () =>
    Effect.gen(function* () {
      const logs = logsWith(insights(upTo));
      const search = (nextToken?: string) =>
        settle(
          logs.use((l) =>
            l.search({
              app: 'shop',
              stage: 'prod',
              from: T0,
              to: T0 + 60_000,
              q: 'o',
              filters: { levels: ['error'], streams: ['web', 'worker'] },
              limit: 2,
              nextToken,
            }),
          ),
        );
      const first = yield* search();
      assert.deepStrictEqual(
        first.lines.map((l) => [l.stream, l.level, l.message]),
        [
          ['web', 'error', 'E: one'],
          ['worker', 'error', 'two'],
        ],
      );
      const [start] = logs.started();
      assert.strictEqual(start?.queryLanguage, 'CWLI');
      assert.deepStrictEqual(start?.logGroupNames, [`${PREFIX}web`, `${PREFIX}worker`]);
      assert.deepStrictEqual([start?.startTime, start?.endTime], [T0 / 1000, T0 / 1000 + 60]);
      assert.match(
        String(start?.queryString),
        /and @message like \/o\/\n\| fields .*\n\| sort @timestamp desc\n\| limit 3$/,
      );
      const cursor = yield* decodeInsightsCursor(first.nextToken ?? '');
      assert.strictEqual(cursor.b, T0 + 2_000);
      assert.strictEqual(cursor.s.length, 1);

      const second = yield* search(first.nextToken);
      assert.deepStrictEqual(
        second.lines.map((l) => l.message),
        ['three'],
      );
      assert.strictEqual(second.nextToken, undefined);
      assert.match(
        String(logs.started()[1]?.queryString),
        new RegExp(`<= ${T0 + 2_000} and .*\\| limit 4$`, 's'),
      );
    }),
  );

  it.effect('refuses what it can’t query before asking AWS', () =>
    Effect.gen(function* () {
      const logs = logsWith(insights(() => []));
      const search = (options: Partial<Parameters<Logs['Service']['search']>[0]>) =>
        Effect.flip(
          logs.use((l) =>
            l.search({
              app: 'shop',
              stage: 'prod',
              from: 0,
              to: 1,
              filters: { levels: ['warn'] },
              ...options,
            }),
          ),
        );
      assert.strictEqual((yield* search({ nextToken: 'nope' })).message, 'invalid next token');
      assert.match((yield* search({ q: '{ $.status = 500 }' })).message, /filter pattern/);
      assert.strictEqual(
        (yield* search({ filters: { levels: ['warn'], streams: ['../other'] } })).message,
        'stream must be web or worker',
      );
      assert.match((yield* search({ filters: { routes: ['/a" or "'] } })).message, /path pattern/);
      assert.deepStrictEqual(logs.started(), []);
    }),
  );

  it.effect('stops a query that runs past 25 s, freeing it for others', () =>
    Effect.gen(function* () {
      const logs = logsWith((command) => {
        if (command.constructor.name === 'StartQueryCommand') return { queryId: 'slow' };
        if (command.constructor.name === 'GetQueryResultsCommand') return { status: 'Running' };
        return {};
      });
      const error = yield* settle(
        Effect.flip(
          logs.use((l) =>
            l.search({ app: 'shop', stage: 'prod', from: 0, to: 1, filters: { status: ['5xx'] } }),
          ),
        ),
        '5 seconds',
      );
      assert.match(error.message, /took longer than 25 s/);
      const stop = logs.sent.find((c) => c.constructor.name === 'StopQueryCommand');
      assert.deepStrictEqual(stop?.input, { queryId: 'slow' });
    }),
  );
});

describe('log stats', () => {
  it.effect('runs its queries side by side and counts what they found', () =>
    Effect.gen(function* () {
      const logs = logsWith(
        insights((query) => {
          if (query.includes('as bucket'))
            return [
              {
                bucket: insightsTime(T0),
                tele: '1',
                tkind: 'log',
                tlevel: 'warn',
                sclass: '0',
                rtype: '',
                n: '2',
              },
              {
                bucket: insightsTime(T0 + 60_000),
                tele: '1',
                tkind: 'req',
                tlevel: '',
                sclass: '5',
                rtype: '',
                n: '1',
              },
            ];
          if (query.includes('by @log')) return [{ '@log': `000000000000:${PREFIX}web`, n: '3' }];
          if (query.includes('by route')) return [{ route: '/api/x', n: '1' }];
          if (query.includes('by sclass')) return [{ sclass: '5', n: '1' }];
          if (query.includes('by rev')) return [{ rev: 'd1', n: '3' }];
          return [];
        }),
      );
      const stats = yield* settle(
        logs.use((l) =>
          l.stats({ app: 'shop', stage: 'prod', from: T0, to: T0 + 2 * 60_000, filters: { revs: ['d1'] } }),
        ),
      );
      assert.strictEqual(logs.started().length, 5);
      assert.strictEqual(stats.res, '1m');
      assert.deepStrictEqual(stats.levels.warn, [2, 0, 0]);
      assert.deepStrictEqual(stats.levels.error, [0, 1, 0]);
      assert.strictEqual(stats.total, 3);
      assert.deepStrictEqual(stats.facets.stream, [{ value: 'web', count: 3 }]);
      assert.deepStrictEqual(stats.facets.status, [{ value: '5xx', count: 1 }]);
      assert.deepStrictEqual(stats.facets.rev, [{ value: 'd1', count: 3 }]);
    }),
  );

  it.effect('answers empty for a stage that never logged', () =>
    Effect.gen(function* () {
      const logs = logsWith(
        insights(() => []),
        [],
      );
      const stats = yield* logs.use((l) =>
        l.stats({ app: 'shop', stage: 'prod', from: T0, to: T0 + 60_000 }),
      );
      assert.strictEqual(stats.total, 0);
      assert.deepStrictEqual(logs.started(), []);
    }),
  );
});

describe('Logs Insights', () => {
  it.effect('runs a member’s query on the stage’s own log groups only', () =>
    Effect.gen(function* () {
      const logs = logsWith(
        insights(() => [
          { route: '/a', n: '2', '@ptr': 'p' },
          { route: '/b', n: '1', '@ptr': 'p' },
        ]),
        // `services/ais`: a long-running service's, left from before services were removed.
        ['web', 'web.local', 'worker', 'services/ais'],
      );
      const res = yield* settle(
        logs.use((l) =>
          l.insights({
            app: 'shop',
            stage: 'prod',
            query: 'stats count(*) as n by route',
            from: 0,
            to: 3_600_000,
          }),
        ),
      );
      assert.deepStrictEqual(res, {
        columns: ['route', 'n'],
        rows: [
          ['/a', '2'],
          ['/b', '1'],
        ],
        recordsMatched: 2,
        recordsScanned: 10,
        bytesScanned: 1_000,
      });
      const [start] = logs.started();
      assert.strictEqual(start?.queryLanguage, 'CWLI');
      assert.deepStrictEqual(start?.logGroupNames, [`${PREFIX}web`, `${PREFIX}worker`]);
    }),
  );

  it.effect('refuses a query that picks its own log groups, without running it', () =>
    Effect.gen(function* () {
      const logs = logsWith(insights(() => []));
      const error = yield* Effect.flip(
        logs.use((l) =>
          l.insights({
            app: 'shop',
            stage: 'prod',
            query: 'fields @message\n| SOURCE logGroups(namePrefix: ["/platform/apps/other"])',
            from: 0,
            to: 1,
          }),
        ),
      );
      assert.strictEqual(error._tag, 'BadRequest');
      assert.match(error.message, /SOURCE isn’t allowed/);
      assert.deepStrictEqual(logs.sent, []);
    }),
  );

  it.effect('passes on why AWS refused a query', () =>
    Effect.gen(function* () {
      const logs = logsWith(() => {
        throw awsError('MalformedQueryException', 'unexpected symbol found ) at line 1');
      });
      const error = yield* Effect.flip(
        logs.use((l) => l.insights({ app: 'shop', stage: 'prod', query: 'fields )', from: 0, to: 1 })),
      );
      assert.strictEqual(error._tag, 'BadRequest');
      assert.strictEqual(error.message, 'unexpected symbol found ) at line 1');
    }),
  );
});

describe('trace list', () => {
  it.effect('lists root lines newest first and says when more matched', () =>
    Effect.gen(function* () {
      const req = (ts: number, status: number): TelemetryEvent => ({
        ...base,
        ts,
        t: 'req',
        method: 'GET',
        route: '/api/x',
        status,
        dur: 100,
      });
      const logs = logsWith(
        insights(() =>
          [req(T0 + 3_000, 500), req(T0 + 2_000, 200), req(T0 + 1_000, 200)].map((e) => ({
            '@timestamp': insightsTime(e.ts),
            '@message': JSON.stringify(e),
          })),
        ),
      );
      const res = yield* settle(
        logs.use((l) =>
          l.traces({
            app: 'shop',
            stage: 'prod',
            from: T0,
            to: T0 + 60_000,
            limit: 2,
            filters: { kind: 'req' },
          }),
        ),
      );
      assert.strictEqual(res.truncated, true);
      assert.deepStrictEqual(
        res.traces.map((t) => [t.ts, t.name, t.failed]),
        [
          [new Date(T0 + 2_900).toISOString(), 'GET /api/x', true],
          [new Date(T0 + 1_900).toISOString(), 'GET /api/x', false],
        ],
      );
      assert.match(String(logs.started()[0]?.queryString), /\| limit 3$/);
      const bad = yield* Effect.flip(
        logs.use((l) => l.traces({ app: 'shop', stage: 'prod', from: 0, to: 1, filters: { jobs: ['x'] } })),
      );
      assert.match(bad.message, /kind:name/);
    }),
  );

  it.effect('checks an error group’s fingerprint before querying', () =>
    Effect.gen(function* () {
      const logs = logsWith(insights(() => []));
      const error = yield* Effect.flip(
        logs.use((l) =>
          l.errorOccurrences({
            app: 'shop',
            stage: 'prod',
            fingerprint: '") | fields @message',
            from: 0,
            to: 1,
          }),
        ),
      );
      assert.strictEqual(error.message, 'invalid fingerprint');
      assert.deepStrictEqual(logs.sent, []);
    }),
  );
});

describe('log context', () => {
  /** A log group's events in memory, read the way FilterLogEvents reads them: oldest first, `limit` at a time. */
  const filterLogEvents = (events: ReadonlyArray<TimedEvent>) => {
    const reads: Array<{ start: number; end: number }> = [];
    const answer = (command: Command) => {
      const { startTime, endTime, limit, nextToken } = command.input as {
        startTime: number;
        endTime: number;
        limit: number;
        nextToken?: string;
      };
      if (!nextToken) reads.push({ start: startTime, end: endTime });
      const inWindow = events.filter((e) => e.timestamp >= startTime && e.timestamp <= endTime);
      const from = Number(nextToken ?? 0);
      const page = inWindow.slice(from, from + limit);
      return {
        events: page,
        ...(from + limit < inWindow.length ? { nextToken: String(from + limit) } : {}),
      };
    };
    return { reads, answer };
  };

  const reader =
    (events: ReadonlyArray<TimedEvent>): WindowReader<never> =>
    (start, end, cap) =>
      Effect.sync(() => {
        const inWindow = events
          .filter((e) => e.timestamp >= start && e.timestamp < end)
          .toSorted((a, b) => a.timestamp - b.timestamp);
        return { events: inWindow.slice(0, cap), complete: inWindow.length <= cap };
      });

  it.effect('looks further back until it has enough lines', () =>
    Effect.gen(function* () {
      // One line a minute for a day: the first window (a minute) holds one, the next nine more…
      const events = Array.from({ length: 24 * 60 }, (_, i) => ({
        timestamp: T0 - i * 60_000 - 1,
        message: `m${i}`,
      }));
      const last = yield* lastEventsBefore(reader(events), T0, 30);
      assert.strictEqual(last.length, 30);
      assert.deepStrictEqual(last.at(-1), events[0]);
      assert.deepStrictEqual(last[0], events[29]);
    }),
  );

  it.effect('splits a window too busy to read at once, keeping the lines nearest the anchor', () =>
    Effect.gen(function* () {
      // A burst of 5,000 lines, 10 a millisecond, in the second before the anchor.
      const events = Array.from({ length: 5_000 }, (_, i) => ({
        timestamp: T0 - 1 - Math.floor(i / 10),
        message: `m${i}`,
      })).toSorted((a, b) => a.timestamp - b.timestamp);
      const last = yield* lastEventsBefore(reader(events), T0, 25);
      assert.deepStrictEqual(last, events.slice(-25));
      assert.ok(events.length > CONTEXT_READ_CAP);
    }),
  );

  it.effect('answers the lines around one line of a stream, oldest first', () =>
    Effect.gen(function* () {
      const log = (ts: number, msg: string) => ({
        timestamp: ts + 2,
        message: JSON.stringify({ ...base, ts, t: 'log', level: 'info', msg }),
      });
      const events = [
        log(T0 - 5_000, 'a'),
        log(T0 - 10, 'b'),
        log(T0, 'anchor'),
        log(T0 + 5, 'c'),
        log(T0 + 9_000, 'd'),
      ];
      const fake = filterLogEvents(events);
      const logs = logsWith(fake.answer);
      const res = yield* logs.use((l) =>
        l.context({ app: 'shop', stage: 'prod', stream: 'worker', ts: T0, before: 1, after: 2 }),
      );
      assert.deepStrictEqual(
        res.lines.map((l) => [l.stream, l.message]),
        [
          ['worker', 'b'],
          ['worker', 'anchor'],
          ['worker', 'c'],
          ['worker', 'd'],
        ],
      );
      assert.strictEqual(res.anchor, 1);
      const groups = logs.sent.map((c) => c.input.logGroupName);
      assert.ok(groups.every((g) => g === `${PREFIX}worker`));

      const none = yield* Effect.flip(
        logsWith(filterLogEvents([]).answer).use((l) =>
          l.context({ app: 'shop', stage: 'prod', stream: 'web', ts: T0, before: 5, after: 5 }),
        ),
      );
      assert.strictEqual(none._tag, 'NotFound');
    }),
  );
});

describe('live tail', () => {
  it.effect('keeps the live lines the filters select', () =>
    Effect.gen(function* () {
      const message = (event: Record<string, unknown>) => JSON.stringify({ ...base, ts: T0, ...event });
      let input: Record<string, unknown> = {};
      const logs = logsWith((command) => {
        input = command.input;
        return {
          responseStream: (async function* () {
            yield {
              sessionUpdate: {
                sessionResults: [
                  {
                    logGroupIdentifier: `${PREFIX}web`,
                    timestamp: T0,
                    message: message({ t: 'log', level: 'info', msg: 'fine' }),
                  },
                  {
                    logGroupIdentifier: `${PREFIX}web`,
                    timestamp: T0,
                    message: message({ t: 'log', level: 'error', msg: 'bad' }),
                  },
                ],
              },
            };
          })(),
        };
      });
      const lines = yield* logs.use((l) =>
        Stream.runCollect(
          l.tail({ app: 'shop', stage: 'prod', q: 'ba', filters: { levels: ['error'], streams: ['web'] } }),
        ),
      );
      assert.deepStrictEqual(
        [...lines].map((l) => l.message),
        ['bad'],
      );
      assert.strictEqual(input.logEventFilterPattern, '"ba"');
      assert.deepStrictEqual(input.logGroupIdentifiers, [
        `arn:aws:logs:us-east-1:000000000000:log-group:${PREFIX}web`,
      ]);
    }),
  );
});
