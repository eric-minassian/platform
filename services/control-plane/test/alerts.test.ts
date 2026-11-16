import type { PublishCommandInput, SNSClient } from '@aws-sdk/client-sns';
import { assert, it as effect } from '@effect/vitest';
import type {
  AlertEvent,
  AlertRule,
  AlertRuleInput,
  AppRecord,
  SeriesQuery,
} from '@ericminassian/platform-core';
import { captureTelemetry, resetPlatform, useTestBindings } from '@ericminassian/platform/testing';
import { Effect, Layer } from 'effect';
import { TestClock } from 'effect/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AlertEvaluator,
  alertNotification,
  alertWindow,
  decideAlert,
  RECORD_EVERY_MS,
} from '../src/alerts/evaluator.ts';
import { AlertRules, toAlertEvent } from '../src/alerts/rules.ts';
import { resetsState } from '../src/api/alerts.ts';
import { type StageItem, Store } from '../src/store.ts';
import { TelemetryQuery } from '../src/telemetry/query.ts';
import {
  api,
  awsLayer,
  memoryStore,
  runtime,
  settingsLayer,
  type TestServices,
  testServices,
} from './support.ts';

const NOW = Date.parse('2026-11-16T14:05:30.000Z');
const CONSOLE = 'https://platform.example.com';

const errorsQuery: SeriesQuery = { metric: 'requests', stat: 'percent', filter: { status: ['5xx'] } };

const rule = (over: Partial<AlertRule> = {}): AlertRule => ({
  id: 'a1',
  app: 'atlas',
  name: 'Errors',
  stage: 'prod',
  query: errorsQuery,
  condition: { op: 'above', threshold: 2, minutes: 5 },
  missing: 'keep',
  notify: true,
  enabled: true,
  state: 'ok',
  value: 0.5,
  evaluatedAt: new Date(NOW - 60_000).toISOString(),
  createdBy: 'bob',
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
  ...over,
});

describe('alert decisions', () => {
  it('reads the whole minutes that end two minutes before the current one', () => {
    expect(alertWindow(NOW, 5)).toEqual({
      from: Date.parse('2026-11-16T13:58:00.000Z'),
      to: Date.parse('2026-11-16T14:03:00.000Z'),
    });
  });

  it('fires past the threshold: records the change, keeps a history row and emails', () => {
    const d = decideAlert(rule(), 3.4166, NOW, CONSOLE);
    const at = new Date(NOW).toISOString();
    expect(d.state).toBe('alarm');
    expect(d.patch).toEqual({ state: 'alarm', value: 3.4166, evaluatedAt: at, stateSince: at });
    expect(d.event).toEqual({
      ts: at,
      rule: 'a1',
      name: 'Errors',
      stage: 'prod',
      from: 'ok',
      to: 'alarm',
      value: 3.4166,
      threshold: 2,
    });
    expect(d.notification).toEqual({
      subject: '[ALARM] atlas/prod: 5xx % of requests above 2 over 5 min',
      message: [
        'Errors is firing.',
        '',
        '5xx % of requests, 5 min to 14:03 UTC: 3.42%',
        'Fires when above 2%.',
        '',
        'https://platform.example.com/apps/atlas/alerts?stage=prod',
      ].join('\n'),
    });
  });

  it('emails a recovery and going without data out of alarm, but not ok and no data trading places', () => {
    const recovered = decideAlert(rule({ state: 'alarm' }), 1, NOW, CONSOLE);
    expect([recovered.state, recovered.notification?.subject]).toEqual([
      'ok',
      '[OK] atlas/prod: 5xx % of requests above 2 over 5 min',
    ]);
    const silent = rule({ state: 'alarm', missing: 'ok' });
    expect(decideAlert(silent, null, NOW, CONSOLE).notification?.message).toMatch(
      /^Errors is back to normal\.\n\n5xx % of requests, 5 min to 14:03 UTC: no data/,
    );
    // A new rule's first value: a change worth a history row, not an email.
    const first = decideAlert(
      rule({ state: 'no_data', value: undefined, evaluatedAt: undefined }),
      0,
      NOW,
      CONSOLE,
    );
    expect([first.state, first.event?.from, first.notification]).toEqual(['ok', 'no_data', undefined]);
    // Nobody asked to be told.
    expect(decideAlert(rule({ notify: false }), 9, NOW, CONSOLE).notification).toBeUndefined();
  });

  it('records an unchanged rule only when its value moved or its last record is old', () => {
    expect(decideAlert(rule(), 0.5, NOW, CONSOLE).patch).toBeUndefined();
    expect(decideAlert(rule(), 0.7, NOW, CONSOLE).patch).toEqual({
      state: 'ok',
      value: 0.7,
      evaluatedAt: new Date(NOW).toISOString(),
    });
    const stale = rule({ evaluatedAt: new Date(NOW - RECORD_EVERY_MS).toISOString() });
    expect(decideAlert(stale, 0.5, NOW, CONSOLE).patch).toMatchObject({
      evaluatedAt: new Date(NOW).toISOString(),
    });
    // A window without data keeps its state (`keep`), and null is a value like any other.
    const quiet = rule({ value: null });
    expect(decideAlert(quiet, null, NOW, CONSOLE)).toMatchObject({
      state: 'ok',
      patch: undefined,
      event: undefined,
    });
  });

  it('describes queries and units in the email, and keeps the subject within what SNS takes', () => {
    const slow = rule({
      query: { metric: 'latency', stat: 'p95', filter: { routes: [`GET /api/${'x'.repeat(120)}`] } },
      condition: { op: 'above', threshold: 800, minutes: 15 },
    });
    const n = alertNotification(slow, 'ok', 'alarm', 1000, alertWindow(NOW, 15), CONSOLE);
    expect(n.subject).toHaveLength(100);
    expect(n.subject.startsWith('[ALARM] atlas/prod: p95 latency of GET /api/xxx')).toBe(true);
    expect(n.message).toContain(', 15 min to 14:03 UTC: 1000 ms\nFires when above 800 ms.');
    const denials = rule({
      query: { metric: 'rate_limit', stat: 'count' },
      condition: { op: 'below', threshold: 1, minutes: 60 },
    });
    expect(alertNotification(denials, 'alarm', 'no_data', null, alertWindow(NOW, 60), CONSOLE)).toMatchObject(
      {
        subject: '[NO DATA] atlas/prod: rate limit checks below 1 over 60 min',
        message: expect.stringMatching(/^Errors has no data, so it is no longer firing\./) as unknown,
      },
    );
  });

  it('starts a rule over when its stage, query or condition changes, not its name or notifications', () => {
    const input: AlertRuleInput = rule();
    expect(
      resetsState(input, { ...input, name: 'Renamed', notify: false, missing: 'ok', enabled: false }),
    ).toBe(false);
    expect(resetsState(input, { ...input, stage: 'dev' })).toBe(true);
    expect(resetsState(input, { ...input, condition: { ...input.condition, threshold: 3 } })).toBe(true);
    expect(resetsState(input, { ...input, query: { ...errorsQuery, filter: { status: ['4xx'] } } })).toBe(
      true,
    );
    // The same query with its keys in another order is the same query.
    expect(
      resetsState(input, {
        ...input,
        query: { filter: { status: ['5xx'] }, stat: 'percent', metric: 'requests' },
      }),
    ).toBe(false);
  });

  it('reads history rows with their time from the sort key', () => {
    expect(
      toAlertEvent({
        pk: 'a#atlas#prod',
        sk: '2026-11-16T14:05:30.000Z#a1',
        rule: 'a1',
        name: 'Errors',
        stage: 'prod',
        from: 'ok',
        to: 'alarm',
        value: null,
        threshold: 2,
        ttl: 1,
      }),
    ).toEqual({
      ts: '2026-11-16T14:05:30.000Z',
      rule: 'a1',
      name: 'Errors',
      stage: 'prod',
      from: 'ok',
      to: 'alarm',
      value: null,
      threshold: 2,
    });
  });
});

describe('alert evaluator', () => {
  const stage = (app: string, name: string, over: Partial<StageItem> = {}): StageItem => ({
    app,
    stage: name,
    host: `${app}.example.com`,
    url: `https://${app}.example.com`,
    status: 'active',
    preview: false,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    ...over,
  });

  const evaluator = (options: {
    readonly alerts: Layer.Layer<AlertRules>;
    readonly stages?: ReadonlyArray<StageItem>;
    readonly values: (rule: {
      app: string;
      stage: string;
      query: SeriesQuery;
      from: number;
      to: number;
    }) => number | null;
    readonly published: PublishCommandInput[];
  }) =>
    AlertEvaluator.layer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          options.alerts,
          awsLayer({
            sns: () =>
              ({
                send: async (command: { input: PublishCommandInput }) => {
                  options.published.push(command.input);
                  return {};
                },
              }) as unknown as SNSClient,
          }),
          settingsLayer({ runtime: Effect.succeed({ ...runtime, alertsTopicArn: 'arn:alerts' }) }),
          memoryStore({ stages: options.stages ?? [] }),
          Layer.mock(TelemetryQuery, {
            seriesWindow: (app, stageName, query, from, to) =>
              Effect.sync(() => options.values({ app, stage: stageName, query, from, to })),
          }),
        ),
      ),
    );

  effect.effect('does nothing but list rules when no rule is enabled', () =>
    Effect.gen(function* () {
      const layer = AlertEvaluator.layer.pipe(
        Layer.provide([
          AlertRules.memory({ rules: [rule({ enabled: false })] }),
          awsLayer({}),
          settingsLayer(),
          // Neither stages nor telemetry are read: these die when called.
          Layer.mock(TelemetryQuery, {}),
          Layer.mock(Store, {}),
        ]),
      );
      const result = yield* AlertEvaluator.use((e) => e.run).pipe(Effect.provide(layer));
      assert.deepStrictEqual(result, { rules: 0, changed: 0 });
    }),
  );

  effect.effect('moves rules on live stages, keeps history, and emails only a change it made', () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const published: PublishCommandInput[] = [];
      const alerts = AlertRules.memory({
        rules: [
          rule({ id: 'a1' }),
          rule({ id: 'a2', app: 'atlas', stage: 'pr-3' }),
          rule({ id: 'a3', app: 'blog', stage: 'prod' }),
          rule({
            id: 'a4',
            app: 'atlas',
            stage: 'prod',
            query: { metric: 'requests', stat: 'count' },
            condition: { op: 'below', threshold: 1, minutes: 60 },
            notify: false,
          }),
        ],
      });
      const windows: Array<[string, number]> = [];
      const layer = evaluator({
        alerts,
        published,
        // pr-3 was destroyed; blog has no stages at all.
        stages: [stage('atlas', 'prod'), stage('atlas', 'pr-3', { status: 'destroyed' })],
        values: ({ query, from, to }) => {
          windows.push([new Date(from).toISOString(), (to - from) / 60_000]);
          return query.stat === 'percent' ? 4 : 0;
        },
      });
      const result = yield* AlertEvaluator.use((e) => e.run).pipe(Effect.provide(layer));
      assert.deepStrictEqual(result, { rules: 2, changed: 2 });
      assert.deepStrictEqual(
        windows.toSorted(([a], [b]) => a.localeCompare(b)),
        [
          ['2026-11-16T13:03:00.000Z', 60],
          ['2026-11-16T13:58:00.000Z', 5],
        ],
      );
      assert.deepStrictEqual(
        published.map((p) => [p.TopicArn, p.Subject]),
        [['arn:alerts', '[ALARM] atlas/prod: 5xx % of requests above 2 over 5 min']],
      );
      const after = yield* AlertRules.use((r) => r.listAll).pipe(Effect.provide(alerts));
      assert.deepStrictEqual(
        after.map((r) => [r.id, r.state, r.value]),
        [
          ['a1', 'alarm', 4],
          ['a2', 'ok', 0.5],
          ['a3', 'ok', 0.5],
          ['a4', 'alarm', 0],
        ],
      );
      const history = yield* AlertRules.use((r) => r.history('atlas', 'prod', 0, NOW)).pipe(
        Effect.provide(alerts),
      );
      assert.sameMembers(
        history.map((e: AlertEvent) => `${e.rule} ${e.from}→${e.to}`),
        ['a1 ok→alarm', 'a4 ok→alarm'],
      );

      // The next minute nothing changed: no email, no history, no writes.
      yield* TestClock.adjust('1 minute');
      const again = yield* AlertEvaluator.use((e) => e.run).pipe(Effect.provide(layer));
      assert.deepStrictEqual([again, published.length], [{ rules: 2, changed: 0 }, 1]);
    }),
  );

  effect.effect('leaves a rule another run or an edit moved first, without emailing', () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const published: PublishCommandInput[] = [];
      const read = rule();
      const alerts = AlertRules.memory({ rules: [read] });
      // What a run that read the rule before an overlapping one moved it would do.
      yield* AlertRules.use((r) => r.record(read, { state: 'alarm', value: 9 })).pipe(Effect.provide(alerts));
      const layer = evaluator({ alerts, published, stages: [stage('atlas', 'prod')], values: () => 9 });
      const stale = yield* AlertRules.use((r) => r.record(read, { state: 'alarm', value: 9 })).pipe(
        Effect.provide(alerts),
      );
      assert.isFalse(stale);
      const result = yield* AlertEvaluator.use((e) => e.run).pipe(Effect.provide(layer));
      // It reads the current state (alarm): nothing to change, so nothing sent.
      assert.deepStrictEqual([result.changed, published.length], [0, 0]);
    }),
  );
});

// ------------------------------------------------------------------ the API

let telemetry: ReturnType<typeof captureTelemetry>;
beforeEach(() => {
  useTestBindings({ app: 'platform', stage: 'prod' });
  telemetry = captureTelemetry();
});
afterEach(() => {
  telemetry.stop();
  resetPlatform();
});

const atlas: AppRecord = {
  name: 'atlas',
  repo: 'bob/atlas',
  owners: ['bob'],
  createdBy: 'bob',
  createdAt: '2026-11-01T00:00:00.000Z',
};

const json = (res: Response) => Effect.promise(() => res.json());

const setup = (options: TestServices = {}) =>
  Effect.gen(function* () {
    const request = yield* api(testServices({ store: memoryStore({ apps: [atlas] }), ...options }));
    const signIn = Effect.fnUntraced(function* (github: string) {
      const res = yield* request('/v1/auth/cli', { method: 'POST', json: { githubToken: github } });
      return { authorization: `Bearer ${((yield* json(res)) as { token: string }).token}` };
    });
    return { request, bob: yield* signIn('bob'), signIn };
  });

const input = (over: Partial<AlertRuleInput> = {}): AlertRuleInput => ({
  name: 'Errors',
  stage: 'prod',
  query: errorsQuery,
  condition: { op: 'above', threshold: 2, minutes: 5 },
  missing: 'ok',
  notify: true,
  enabled: true,
  ...over,
});

describe('alerts API', () => {
  effect.effect('creates, lists, updates and removes rules', () =>
    Effect.gen(function* () {
      const alerts = AlertRules.memory();
      const { request, bob } = yield* setup({ alerts });
      const created = yield* request('/v1/apps/atlas/alerts', {
        method: 'POST',
        headers: bob,
        json: input(),
      });
      assert.strictEqual(created.status, 201);
      const made = (yield* json(created)) as AlertRule;
      assert.match(made.id, /^a[0-9a-z]{26}$/);
      assert.deepStrictEqual(
        [made.app, made.state, made.createdBy, made.stateSince === made.createdAt],
        ['atlas', 'no_data', 'bob', true],
      );
      yield* request('/v1/apps/atlas/alerts', {
        method: 'POST',
        headers: bob,
        json: input({ stage: 'dev', name: 'Dev' }),
      });

      const list = (s?: string) =>
        Effect.flatMap(
          request(`/v1/apps/atlas/alerts${s ? `?stage=${s}` : ''}`, { headers: bob }),
          (res) => json(res) as Effect.Effect<AlertRule[]>,
        );
      assert.deepStrictEqual(
        (yield* list()).map((r) => r.name),
        ['Errors', 'Dev'],
      );
      assert.deepStrictEqual(
        (yield* list('dev')).map((r) => r.name),
        ['Dev'],
      );

      // The evaluator moved it; a rename keeps that, a new threshold starts it over.
      yield* AlertRules.use((r) => r.record(made, { state: 'alarm', value: 5, evaluatedAt: 'x' })).pipe(
        Effect.provide(alerts),
      );
      const put = (body: AlertRuleInput) =>
        Effect.flatMap(
          request(`/v1/apps/atlas/alerts/${made.id}`, { method: 'PUT', headers: bob, json: body }),
          (res) => json(res) as Effect.Effect<AlertRule>,
        );
      const renamed = yield* put(input({ name: 'Server errors' }));
      assert.deepStrictEqual([renamed.name, renamed.state, renamed.value], ['Server errors', 'alarm', 5]);
      const retuned = yield* put(
        input({ name: 'Server errors', condition: { op: 'above', threshold: 5, minutes: 5 } }),
      );
      assert.deepStrictEqual(
        [retuned.state, retuned.value, retuned.evaluatedAt, retuned.condition.threshold],
        ['no_data', undefined, undefined, 5],
      );

      const removed = yield* request(`/v1/apps/atlas/alerts/${made.id}`, { method: 'DELETE', headers: bob });
      assert.strictEqual(removed.status, 204);
      const again = yield* request(`/v1/apps/atlas/alerts/${made.id}`, { method: 'DELETE', headers: bob });
      assert.strictEqual(again.status, 404);
      assert.deepStrictEqual(
        (yield* list()).map((r) => r.name),
        ['Dev'],
      );
    }),
  );

  effect.effect('refuses what a rule can’t watch, a bad stage, too many rules, and other members', () =>
    Effect.gen(function* () {
      const full = Array.from({ length: 25 }, (_, i) => ({
        ...rule({ id: `a${String(i).padStart(2, '0')}` }),
      }));
      const blog: AppRecord = { ...atlas, name: 'blog', repo: 'ada/blog', owners: ['ada'], createdBy: 'ada' };
      const { request, bob, signIn } = yield* setup({ store: memoryStore({ apps: [atlas, blog] }) });
      const post = (body: unknown, headers = bob, app = 'atlas') =>
        request(`/v1/apps/${app}/alerts`, { method: 'POST', headers, json: body });
      const message = (res: Response) =>
        Effect.map(json(res), (b) => (b as { error: { message: string } }).error.message);

      const histogram = yield* post(input({ query: { metric: 'latency', stat: 'histogram' } }));
      assert.strictEqual(histogram.status, 400);
      assert.match(yield* message(histogram), /histogram/);
      const realtime = yield* post(
        input({ query: { metric: 'realtime', stat: 'sum', filter: { measure: 'events' } } }),
      );
      assert.match(yield* message(realtime), /can't watch realtime/);
      const badStage = yield* post(input({ stage: 'Prod!' }));
      assert.strictEqual(badStage.status, 400);
      const window = yield* post({ ...input(), condition: { op: 'above', threshold: 1, minutes: 7 } });
      assert.strictEqual(window.status, 400);

      // Another member's app is one bob can't see; admins see every app.
      const other = yield* post(input(), bob, 'blog');
      assert.strictEqual(other.status, 404);
      const ada = yield* signIn('ada');
      assert.strictEqual((yield* request('/v1/apps/atlas/alerts', { headers: ada })).status, 200);

      const crowded = yield* setup({
        alerts: AlertRules.memory({ rules: full.map((r) => ({ ...r, app: 'atlas' })) }),
      });
      const limited = yield* crowded.request('/v1/apps/atlas/alerts', {
        method: 'POST',
        headers: crowded.bob,
        json: input(),
      });
      assert.strictEqual(limited.status, 429);
      assert.strictEqual(yield* message(limited), 'an app has at most 25 alert rules');
      const missing = yield* request('/v1/apps/atlas/alerts/nope', {
        method: 'PUT',
        headers: bob,
        json: input(),
      });
      assert.strictEqual(missing.status, 404);
    }),
  );

  effect.effect('lists state changes newest first, of one stage or all of them', () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const event = (ts: string, stage: string, id: string): AlertEvent & { app: string } => ({
        app: 'atlas',
        ts,
        rule: id,
        name: id,
        stage,
        from: 'ok',
        to: 'alarm',
        value: 3,
        threshold: 2,
      });
      const { request, bob } = yield* setup({
        alerts: AlertRules.memory({
          // A rule on dev, a stage the store doesn't have (yet).
          rules: [rule({ id: 'a2', app: 'atlas', stage: 'dev' })],
          events: [
            event('2026-11-16T12:00:00.000Z', 'prod', 'a1'),
            event('2026-11-16T13:00:00.000Z', 'dev', 'a2'),
            event('2026-11-01T00:00:00.000Z', 'prod', 'a1'),
          ],
        }),
        store: memoryStore({
          apps: [atlas],
          stages: [
            {
              app: 'atlas',
              stage: 'prod',
              host: 'atlas.example.com',
              url: 'https://atlas.example.com',
              status: 'active',
              preview: false,
              createdAt: '2026-11-01T00:00:00.000Z',
              updatedAt: '2026-11-01T00:00:00.000Z',
            },
          ],
        }),
      });
      const history = (query: string) =>
        Effect.flatMap(
          request(`/v1/apps/atlas/alerts/history${query}`, { headers: bob }),
          (res) => json(res) as Effect.Effect<{ events: AlertEvent[] }>,
        );
      assert.deepStrictEqual(
        (yield* history('')).events.map((e) => `${e.stage} ${e.ts}`),
        ['dev 2026-11-16T13:00:00.000Z', 'prod 2026-11-16T12:00:00.000Z'],
      );
      assert.deepStrictEqual(
        (yield* history('?stage=prod&range=30d')).events.map((e) => e.ts),
        ['2026-11-16T12:00:00.000Z', '2026-11-01T00:00:00.000Z'],
      );
    }),
  );
});
