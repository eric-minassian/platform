import type { CloudWatchClient, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import type { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import type { InvokeCommandInput, LambdaClient } from '@aws-sdk/client-lambda';
import type { SchedulerClient } from '@aws-sdk/client-scheduler';
import type { PublishCommandInput, SNSClient } from '@aws-sdk/client-sns';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { type DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { assert, it as effect } from '@effect/vitest';
import {
  type EmailSending,
  type ManifestInput,
  parseManifest,
  type ResolvedManifest,
  telemetryKeys,
} from '@ericminassian/platform-core';
import { type Duration, Effect, Layer, Option, Ref } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { TestClock } from 'effect/testing';
import { describe, expect, it } from 'vitest';
import { AwsError } from '../src/aws.ts';
import { cloudWatchRange } from '../src/cloudwatch.ts';
import { DeployFailed, StageEngine } from '../src/deploy.ts';
import { Dns, type Resolver } from '../src/dns.ts';
import { waitForEdge } from '../src/edge.ts';
import { AppEmail } from '../src/email.ts';
import { PLATFORM_COST_KEY, parseCostResults, TOTAL_COST_KEY } from '../src/jobs/cost.ts';
import {
  describeResult,
  emailAlert,
  needsCheck,
  nextEmailState,
  nextUptimeState,
  Pinger,
  QUIET_CHECK_EVERY_MS,
  trafficResult,
} from '../src/jobs/pinger.ts';
import { AppQueues } from '../src/jobs/queues.ts';
import {
  AppRealtime,
  REALTIME_METRICS,
  RealtimeKey,
  realtimeQueries,
  toRealtimeSeries,
} from '../src/jobs/realtime.ts';
import { stalePreviews } from '../src/jobs/reaper.ts';
import { liveStages, StorageExpiry } from '../src/jobs/storage.ts';
import { STUCK_AFTER_MS, stuckDeployments, suspectStages } from '../src/jobs/watchdog.ts';
import {
  describe as describeEvent,
  Logs,
  logGroupOf,
  runtimeRecord,
  streamOfLogGroup,
  toFilterPattern,
  toLogLine,
} from '../src/logs.ts';
import { type DeploymentItem, type StageItem, Store } from '../src/store.ts';
import { TelemetryQuery, toUptimePoint } from '../src/telemetry/query.ts';
import { awsLayer, memoryStore, runtime, settingsLayer } from './support.ts';

/** Effect's HTTP client over a fake `fetch`. */
const fetchLayer = (fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>) =>
  FetchHttpClient.layer.pipe(Layer.provideMerge(Layer.succeed(FetchHttpClient.Fetch, fetch)));

describe('run cron now', () => {
  effect.live('invokes the function the scheduler would: the cron’s own, or the worker', () =>
    Effect.gen(function* () {
      const invoked: InvokeCommandInput[] = [];
      const lambda = {
        send: async (command: { input: InvokeCommandInput }) => {
          invoked.push(command.input);
          return {};
        },
      } as unknown as LambdaClient;
      const manifest = parseManifest({
        name: 'atlas',
        crons: { tick: 'rate(1 minute)', listen: { schedule: 'rate(1 minute)', memoryMb: 256 } },
      });
      yield* AppQueues.use((q) =>
        Effect.all([
          q.runCron('atlas', 'prod', manifest, 'listen'),
          q.runCron('atlas', 'prod', manifest, 'tick'),
        ]),
      ).pipe(
        Effect.provide(
          AppQueues.layer.pipe(Layer.provide([awsLayer({ lambda: () => lambda }), settingsLayer()])),
        ),
      );
      assert.deepStrictEqual(
        invoked.map((i) => [
          i.FunctionName,
          i.InvocationType,
          new TextDecoder().decode(i.Payload as Uint8Array),
        ]),
        [
          ['atlas--prod--worker--cron-listen', 'Event', '{"__platform":"cron","name":"listen"}'],
          ['atlas--prod--worker', 'Event', '{"__platform":"cron","name":"tick"}'],
        ],
      );
    }),
  );
});

/**
 * An SQS queue for AppQueues: receives hide messages for their visibility
 * timeout (0 leaves them visible), deletes and visibility changes act on
 * receipt handles.
 */
function fakeQueue(bodies: ReadonlyArray<string>) {
  const messages = bodies.map((body, i) => ({ id: `m${i}`, body, hiddenUntil: 0 }));
  let receipts = 0;
  const handles = new Map<string, string>();
  const client = {
    send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      const now = Date.now();
      const input = command.input;
      switch (command.constructor.name) {
        case 'GetQueueAttributesCommand':
          return { Attributes: { ApproximateNumberOfMessages: String(messages.length) } };
        case 'ReceiveMessageCommand': {
          const visible = messages.filter((m) => m.hiddenUntil <= now).slice(0, 10);
          for (const m of visible) m.hiddenUntil = now + Number(input.VisibilityTimeout ?? 30) * 1000;
          return {
            Messages: visible.map((m) => {
              const handle = `r${receipts++}`;
              handles.set(handle, m.id);
              return { MessageId: m.id, ReceiptHandle: handle, Body: m.body };
            }),
          };
        }
        case 'DeleteMessageCommand': {
          const id = handles.get(String(input.ReceiptHandle));
          const i = messages.findIndex((m) => m.id === id);
          if (i >= 0) messages.splice(i, 1);
          return {};
        }
        case 'ChangeMessageVisibilityCommand': {
          const m = messages.find((x) => x.id === handles.get(String(input.ReceiptHandle)));
          if (m) m.hiddenUntil = now + Number(input.VisibilityTimeout) * 1000;
          return {};
        }
        default:
          throw new Error(`unexpected ${command.constructor.name}`);
      }
    },
  };
  return { client: client as unknown as SQSClient, left: () => messages.map((m) => m.id) };
}

describe('dead letters', () => {
  const job = (kind: 'queue' | 'event' | 'cron', name: string, extra: object = {}) =>
    JSON.stringify({
      v: 1,
      job: { __platform: 'job', kind, name, id: `${kind}-${name}`, attempt: 5, sentAt: 1, ...extra },
      failedAt: Date.parse('2026-11-16T10:00:00Z'),
      error: { name: 'Bounced', message: 'no such mailbox' },
    });
  const manifest = parseManifest({
    name: 'atlas',
    queues: { emails: {}, slow: { memoryMb: 2048 } },
    crons: { tick: 'rate(1 minute)' },
  });

  const run = <A, E>(
    use: (q: AppQueues['Service']) => Effect.Effect<A, E>,
    clients: { sqs: SQSClient; lambda?: LambdaClient; scheduler?: SchedulerClient },
  ) =>
    AppQueues.use(use).pipe(
      Effect.provide(
        AppQueues.layer.pipe(
          Layer.provide([
            awsLayer({
              sqs: () => clients.sqs,
              ...(clients.lambda ? { lambda: () => clients.lambda! } : {}),
              ...(clients.scheduler ? { scheduler: () => clients.scheduler! } : {}),
            }),
            settingsLayer(),
          ]),
        ),
      ),
    );

  effect.effect('lists what each writer left, and counts them by queue with what’s scheduled', () =>
    Effect.gen(function* () {
      const queue = fakeQueue([
        job('queue', 'emails', { body: { to: 'a@b.c' } }),
        job('queue', 'emails'),
        job('cron', 'tick'),
        'not ours',
      ]);
      const scheduler = {
        send: async (command: { input: { NamePrefix?: string } }) => ({
          Schedules: command.input.NamePrefix === '_q-emails-' ? [{ Name: '_q-emails-1' }] : [],
        }),
      } as unknown as SchedulerClient;
      const listed = yield* run((q) => q.deadLetters('atlas', 'prod'), { sqs: queue.client });
      assert.strictEqual(listed.total, 4);
      assert.deepStrictEqual(listed.items[0], {
        id: 'm0',
        kind: 'queue',
        name: 'emails',
        attempts: 5,
        error: { name: 'Bounced', message: 'no such mailbox' },
        failedAt: '2026-11-16T10:00:00.000Z',
        source: 'sdk',
        preview: '{"to":"a@b.c"}',
      });
      assert.deepStrictEqual(
        listed.items.map((i) => i.kind),
        ['queue', 'queue', 'cron', 'unknown'],
      );
      const stats = yield* run((q) => q.stats('atlas', 'prod', ['emails', 'slow']), {
        sqs: queue.client,
        scheduler,
      });
      assert.deepStrictEqual(stats, [
        { name: 'emails', scheduled: 1, deadLetter: 2 },
        { name: 'slow', scheduled: 0, deadLetter: 0 },
      ]);
      // Looking hides nothing.
      assert.deepStrictEqual(queue.left(), ['m0', 'm1', 'm2', 'm3']);
    }),
  );

  effect.effect('redrives from the first attempt to the function the handler runs in now', () =>
    Effect.gen(function* () {
      const queue = fakeQueue([
        job('queue', 'slow', { body: 1 }),
        job('queue', 'emails', { body: 2 }),
        job('queue', 'gone'),
        'not ours',
      ]);
      const invoked: InvokeCommandInput[] = [];
      const lambda = {
        send: async (command: { input: InvokeCommandInput }) => {
          invoked.push(command.input);
          return {};
        },
      } as unknown as LambdaClient;
      const one = yield* run((q) => q.redrive('atlas', 'prod', manifest, ['m1']), {
        sqs: queue.client,
        lambda,
      });
      assert.strictEqual(one, 1);
      const all = yield* run((q) => q.redrive('atlas', 'prod', manifest, undefined), {
        sqs: queue.client,
        lambda,
      });
      // The letter for a queue that's gone and the one the platform didn't write stay.
      assert.strictEqual(all, 1);
      assert.deepStrictEqual(queue.left(), ['m2', 'm3']);
      assert.deepStrictEqual(
        invoked.map((i) => {
          const p = JSON.parse(new TextDecoder().decode(i.Payload as Uint8Array)) as Record<string, unknown>;
          return [i.FunctionName, i.InvocationType, p.name, p.attempt, p.body];
        }),
        [
          ['atlas--prod--worker', 'Event', 'emails', 1, 2],
          ['atlas--prod--worker--queue-slow', 'Event', 'slow', 1, 1],
        ],
      );
    }),
  );

  effect.effect('discards the given letters, or all of them', () =>
    Effect.gen(function* () {
      const queue = fakeQueue([job('queue', 'emails'), job('cron', 'tick'), 'not ours']);
      assert.strictEqual(yield* run((q) => q.discard('atlas', 'prod', ['m1']), { sqs: queue.client }), 1);
      assert.deepStrictEqual(queue.left(), ['m0', 'm2']);
      assert.strictEqual(yield* run((q) => q.discard('atlas', 'prod', undefined), { sqs: queue.client }), 2);
      assert.deepStrictEqual(queue.left(), []);
    }),
  );
});

describe('uptime state', () => {
  it('needs two failures before going down and alerts once', () => {
    let s = nextUptimeState({}, false);
    expect(s).toEqual({ up: true, failures: 1, transition: null });
    s = nextUptimeState(s, false);
    expect(s).toEqual({ up: false, failures: 2, transition: 'down' });
    s = nextUptimeState(s, false);
    expect(s).toEqual({ up: false, failures: 3, transition: null });
    expect(nextUptimeState(s, true)).toEqual({ up: true, failures: 0, transition: 'up' });
    expect(nextUptimeState({ up: true }, true).transition).toBeNull();
  });

  it('reads a stage’s own requests as up unless half of at least 3 were 5xx', () => {
    expect(trafficResult(0, 0)).toBeUndefined();
    expect(trafficResult(2, 2)).toEqual({ source: 'traffic', ok: true, req: 2, s5xx: 2 });
    expect(trafficResult(3, 2)?.ok).toBe(false);
    expect(trafficResult(4, 2)?.ok).toBe(false);
    expect(trafficResult(5, 2)?.ok).toBe(true);
  });

  it('checks a quiet server once it went quiet, every 6 hours, and every run while it fails', () => {
    const now = Date.parse('2026-11-16T12:00:00.000Z');
    const ago = (ms: number) => new Date(now - ms).toISOString();
    const quiet = { app: 'shop', server: true, stage: { up: true }, now };
    const checked = (ms: number) => ({ ts: ago(ms), source: 'check' as const });
    expect(needsCheck({ ...quiet, last: undefined })).toBe(true);
    // It served requests the last time anything was recorded, and nothing since.
    expect(needsCheck({ ...quiet, last: { ts: ago(5 * 60_000), source: 'traffic' } })).toBe(true);
    expect(needsCheck({ ...quiet, last: checked(3 * 3_600_000) })).toBe(false);
    expect(needsCheck({ ...quiet, last: checked(QUIET_CHECK_EVERY_MS) })).toBe(true);
    expect(needsCheck({ ...quiet, stage: { up: true, failures: 1 }, last: checked(5 * 60_000) })).toBe(true);
    expect(needsCheck({ ...quiet, stage: { up: false, failures: 0 }, last: checked(5 * 60_000) })).toBe(true);
    // The router answers a stage without a server, so no function wakes.
    expect(needsCheck({ ...quiet, server: false, last: checked(5 * 60_000) })).toBe(true);
    // The control plane's worker is what runs this.
    expect(
      needsCheck({ ...quiet, app: 'platform', stage: { up: false, failures: 3 }, last: undefined }),
    ).toBe(false);
  });

  it('says what a result saw, for the alert', () => {
    const url = 'https://shop.example.com';
    expect(describeResult(url, { source: 'check', ok: false, status: 0, ms: 10_000 })).toBe(
      'https://shop.example.com/__platform/health → no response in 10000ms',
    );
    expect(describeResult(url, { source: 'traffic', ok: false, req: 40, s5xx: 31 })).toBe(
      '31 of 40 requests in the last 10 minutes were 5xx',
    );
  });
});

describe('cost parsing', () => {
  it('splits by app tag and totals', () => {
    const parsed = parseCostResults([
      {
        TimePeriod: { Start: '2026-11-01', End: '2026-11-02' },
        Groups: [
          { Keys: ['platform:app$todo'], Metrics: { UnblendedCost: { Amount: '0.12', Unit: 'USD' } } },
          { Keys: ['platform:app$'], Metrics: { UnblendedCost: { Amount: '0.50', Unit: 'USD' } } },
        ],
      },
    ]);
    expect(parsed.get('todo')?.get('2026-11-01')).toBeCloseTo(0.12);
    expect(parsed.get(PLATFORM_COST_KEY)?.get('2026-11-01')).toBeCloseTo(0.5);
    expect(parsed.get(TOTAL_COST_KEY)?.get('2026-11-01')).toBeCloseTo(0.62);
  });
});

describe('reaper', () => {
  const stage = (s: string, updatedAt: string, status: StageItem['status'] = 'active'): StageItem => ({
    app: 'todo',
    stage: s,
    host: 'h',
    url: 'u',
    status,
    preview: s.startsWith('pr-'),
    createdAt: updatedAt,
    updatedAt,
  });
  it('only reaps old, live preview stages', () => {
    const now = Date.parse('2026-11-14T00:00:00Z');
    const out = stalePreviews(
      [
        stage('prod', '2026-01-01T00:00:00Z'),
        stage('pr-1', '2026-11-01T00:00:00Z'),
        stage('pr-2', '2026-11-13T00:00:00Z'),
        stage('pr-3', '2026-11-01T00:00:00Z', 'destroyed'),
      ],
      7,
      now,
    );
    expect(out.map((s) => s.stage)).toEqual(['pr-1']);
  });
});

describe('dns conflicts', () => {
  const none = Object.assign(new Error('no data'), { code: 'ENODATA' });
  const conflict = (host: string, edge: string, over: Partial<Resolver>) =>
    Dns.use((dns) => dns.hostConflict(host, edge)).pipe(
      Effect.provide(
        Dns.layerWith({
          resolveNs: async () => Promise.reject(none),
          resolveCname: async () => Promise.reject(none),
          resolve4: async () => Promise.reject(none),
          ...over,
        }),
      ),
      Effect.map(Option.getOrElse(() => '')),
    );

  effect.effect('accepts free names and the platform wildcard', () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* conflict('a.example.com', 'edge.example.com', {}), '');
      assert.strictEqual(
        yield* conflict('a.example.com', 'edge.example.com', {
          resolveCname: async () => ['edge.example.com.'],
        }),
        '',
      );
      // A DNS outage never blocks app creation.
      assert.strictEqual(
        yield* conflict('a.example.com', 'e', {
          resolveNs: async () => Promise.reject(new Error('SERVFAIL')),
        }),
        '',
      );
    }),
  );

  effect.effect('rejects delegations, foreign CNAMEs and A records', () =>
    Effect.gen(function* () {
      assert.match(yield* conflict('a.example.com', 'e', { resolveNs: async () => ['ns1'] }), /delegated/);
      assert.match(
        yield* conflict('a.example.com', 'e', { resolveCname: async () => ['x.github.io'] }),
        /points at x.github.io/,
      );
      assert.match(yield* conflict('a.example.com', 'e', { resolve4: async () => ['1.2.3.4'] }), /A record/);
    }),
  );
});

describe('logs', () => {
  it('turns telemetry lines into readable log lines', () => {
    const line = toLogLine(
      'web',
      0,
      JSON.stringify({
        _p: 1,
        t: 'req',
        ts: 1000,
        app: 'a',
        stage: 'prod',
        rev: 'd',
        method: 'GET',
        route: '/',
        path: '/',
        status: 503,
        dur: 12,
        trace: 'abc',
      }),
    );
    expect(line).toMatchObject({ level: 'error', message: 'GET / 503 12ms', trace: 'abc', stream: 'web' });
    expect(toLogLine('worker', 5, 'plain text\n')).toEqual({
      ts: new Date(5).toISOString(),
      stream: 'worker',
      message: 'plain text',
    });
    const metric = (unit?: string) =>
      describeEvent({
        _p: 1,
        t: 'metric',
        ts: 0,
        app: 'a',
        stage: 's',
        rev: 'r',
        name: 'n',
        value: 3,
        ...(unit ? { unit } : {}),
      });
    expect(metric('count')).toBe('metric n=3 count');
    expect(metric()).toBe('metric n=3');
  });
  it('builds filter patterns', () => {
    expect(toFilterPattern(undefined)).toBeUndefined();
    expect(toFilterPattern('timeout')).toBe('"timeout"');
    expect(toFilterPattern('{ $.status = 500 }')).toBe('{ $.status = 500 }');
  });

  it('names streams after their log groups', () => {
    expect(logGroupOf('shop', 'prod', 'web')).toBe('/platform/apps/shop/prod/web');
    expect(logGroupOf('shop', 'prod', 'worker')).toBe('/platform/apps/shop/prod/worker');
    expect(logGroupOf('shop', 'prod', 'web.local')).toBeUndefined();
    expect(logGroupOf('shop', 'prod', 'service:ais')).toBeUndefined();
    const arn = 'arn:aws:logs:us-east-1:000000000000:log-group:/platform/apps/shop/prod';
    expect(streamOfLogGroup('/platform/apps/shop/prod/worker')).toBe('worker');
    expect(streamOfLogGroup(`${arn}/worker:*`)).toBe('worker');
    expect(streamOfLogGroup(`${arn}/web`)).toBe('web');
    const start = {
      _p: 1 as const,
      t: 'env' as const,
      ts: 0,
      app: 'shop',
      stage: 'prod',
      rev: 'd1',
      runtime: 'worker' as const,
    };
    expect(toLogLine('worker', 0, JSON.stringify({ ...start, event: 'start', initMs: 180 }))).toMatchObject({
      stream: 'worker',
      level: 'info',
      message: 'worker environment start (init 180ms)',
    });
    expect(describeEvent({ ...start, event: 'stop' })).toBe('worker environment stop');
  });

  effect.effect('searches the stage’s web and worker log groups, and filters by stream', () =>
    Effect.gen(function* () {
      const filtered: string[] = [];
      const logs = {
        send: (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
          if (command.constructor.name === 'DescribeLogGroupsCommand') {
            assert.strictEqual(command.input.logGroupNamePrefix, '/platform/apps/shop/prod/');
            return Promise.resolve({
              // `services/ais`: a long-running service's, left from before services were removed.
              logGroups: ['web', 'web.local', 'worker', 'services/ais'].map((g) => ({
                logGroupName: `/platform/apps/shop/prod/${g}`,
              })),
            });
          }
          const group = String(command.input.logGroupName);
          filtered.push(group);
          const ts = group.endsWith('/worker') ? 2000 : 1000;
          return Promise.resolve({
            events: [{ timestamp: ts, message: `from ${group.split('/').at(-1)}` }],
            ...(group.endsWith('/worker') ? { nextToken: 'more' } : {}),
          });
        },
      } as unknown as CloudWatchLogsClient;
      const search = (options: { stream?: string; nextToken?: string }) =>
        Logs.use((l) => l.search({ app: 'shop', stage: 'prod', from: 0, to: 10_000, ...options })).pipe(
          Effect.provide(Logs.layer.pipe(Layer.provide([awsLayer({ logs: () => logs }), settingsLayer()]))),
        );

      const all = yield* search({});
      assert.deepStrictEqual(
        all.lines.map((l) => [l.stream, l.message]),
        [
          ['worker', 'from worker'],
          ['web', 'from web'],
        ],
      );
      // The next page only reads the streams that had more.
      filtered.length = 0;
      yield* search({ nextToken: all.nextToken ?? '' });
      assert.deepStrictEqual(filtered, ['/platform/apps/shop/prod/worker']);

      filtered.length = 0;
      const one = yield* search({ stream: 'web' });
      assert.deepStrictEqual(filtered, ['/platform/apps/shop/prod/web']);
      assert.strictEqual(one.lines.length, 1);

      const bad = yield* Effect.flip(search({ stream: 'service:ais' }));
      assert.strictEqual(bad.message, 'stream must be web or worker');
      const forged = Buffer.from(JSON.stringify({ '../../other': 'x' })).toString('base64url');
      assert.strictEqual((yield* Effect.flip(search({ nextToken: forged }))).message, 'invalid next token');
    }),
  );
});

describe('watchdog', () => {
  const now = Date.parse('2026-11-15T12:00:00Z');
  const ago = (ms: number) => new Date(now - ms).toISOString();
  const dep = (
    id: string,
    status: DeploymentItem['status'],
    startedMsAgo: number,
    stage = 'prod',
  ): DeploymentItem => ({
    id,
    app: 'shop',
    stage,
    status,
    actor: 'eric-minassian',
    events: [],
    createdAt: ago(startedMsAgo + 1000),
    startedAt: ago(startedMsAgo),
  });

  it('fails only in-flight deployments of that stage older than the worker can run', () => {
    const deps = [
      dep('old-running', 'running', STUCK_AFTER_MS + 1),
      dep('old-queued', 'queued', STUCK_AFTER_MS + 60_000),
      dep('fresh', 'running', 60_000),
      dep('done', 'succeeded', STUCK_AFTER_MS * 3),
      dep('other-stage', 'running', STUCK_AFTER_MS * 2, 'pr-3'),
    ];
    expect(stuckDeployments(deps, 'prod', now).map((d) => d.id)).toEqual(['old-running', 'old-queued']);
  });

  it('only suspects stages left deploying past the cutoff', () => {
    const stage = (name: string, status: StageItem['status'], msAgo: number): StageItem => ({
      app: 'shop',
      stage: name,
      host: `shop--${name}.example.com`,
      url: `https://shop--${name}.example.com`,
      status,
      preview: name !== 'prod',
      createdAt: ago(msAgo),
      updatedAt: ago(msAgo),
    });
    const stages = [
      stage('prod', 'deploying', STUCK_AFTER_MS + 1),
      stage('pr-1', 'deploying', 60_000),
      stage('pr-2', 'active', STUCK_AFTER_MS * 5),
    ];
    expect(suspectStages(stages, now).map((s) => s.stage)).toEqual(['prod']);
  });
});

describe('edge wait', () => {
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  const wait = (
    fetch: () => Promise<Response>,
    options: { timeout?: Duration.Input; interval?: Duration.Input } = {},
  ) =>
    waitForEdge('https://x.example.com', 'd-new', { interval: '1 millis', ...options }).pipe(
      Effect.provide(fetchLayer(fetch)),
    );

  effect.live('resolves once the edge serves the new deployment', () =>
    Effect.gen(function* () {
      const answers = [reply(404, {}), reply(200, { revision: 'd-old' }), reply(200, { revision: 'd-new' })];
      assert.isTrue(yield* wait(async () => answers.shift() ?? reply(200, { revision: 'd-new' })));
      assert.lengthOf(answers, 0);
    }),
  );

  effect.live('gives up at the deadline without failing', () =>
    Effect.gen(function* () {
      const served = yield* wait(() => Promise.reject(new Error('ENOTFOUND')), {
        timeout: '20 millis',
        interval: '5 millis',
      });
      assert.isFalse(served);
    }),
  );
});

describe('email state', () => {
  const paused: EmailSending = { status: 'paused', pausedBy: 'policy', cause: 'Bounce finding' };
  it('alerts once on a pause and once on the resume', () => {
    expect(nextEmailState(undefined, { status: 'enabled' })).toEqual({ paused: false, transition: null });
    // A stage first seen paused alerts too.
    expect(nextEmailState(undefined, paused)).toEqual({ paused: true, transition: 'paused' });
    expect(nextEmailState(false, paused)).toEqual({ paused: true, transition: 'paused' });
    expect(nextEmailState(true, paused)).toEqual({ paused: true, transition: null });
    expect(nextEmailState(true, { status: 'enabled' })).toEqual({ paused: false, transition: 'resumed' });
  });

  it('says who paused it and what to do next', () => {
    const stage = { app: 'shop', stage: 'prod' };
    const policy = emailAlert(
      stage,
      { ...paused, since: '2026-11-15T10:00:00.000Z' },
      'https://p.example.com',
    );
    expect(policy.subject).toBe('[platform] shop email is PAUSED');
    expect(policy.message).toBe(
      [
        "The reputation policy paused shop's email (prod) at 2026-11-15T10:00:00.000Z.",
        'Cause: Bounce finding',
        'Once the cause is fixed, resume with `plat email resume --app shop` or in the console.',
        '',
        'https://p.example.com/apps/shop/email',
      ].join('\n'),
    );
    expect(emailAlert(stage, { status: 'paused', pausedBy: 'aws' }, 'https://p').message).toMatch(
      /^AWS paused shop's email \(prod\)\.\nOnly AWS Support can lift this pause/,
    );
    expect(emailAlert(stage, { status: 'enabled' }, 'https://p').subject).toBe(
      '[platform] shop email is sending again',
    );
  });
});

describe('pinger', () => {
  const pinger = (
    fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
    options: {
      readonly aws?: Parameters<typeof awsLayer>[0];
      readonly store?: Layer.Layer<Store>;
      readonly email?: Partial<AppEmail['Service']>;
      readonly telemetry?: Partial<TelemetryQuery['Service']>;
    } = {},
  ) =>
    Pinger.layer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          awsLayer(options.aws ?? {}),
          settingsLayer({ runtime: Effect.succeed({ ...runtime, alertsTopicArn: 'arn:alerts' }) }),
          options.store ?? memoryStore(),
          Layer.mock(AppEmail, options.email ?? {}),
          // No traffic, and no earlier uptime rows, unless a test says otherwise.
          Layer.mock(TelemetryQuery, {
            metrics: (app, stage, range) => Effect.succeed({ app, stage, res: range.res, points: [] }),
            lastUptime: () => Effect.succeedNone,
            ...options.telemetry,
          }),
        ),
      ),
      Layer.provideMerge(fetchLayer(fetch)),
    );

  effect.live('counts 2xx as up, and a redirect or no answer as down', () =>
    Effect.gen(function* () {
      const seen: Array<RequestInit['redirect']> = [];
      const statuses = [200, 301];
      const check = Pinger.use((p) => p.check('https://shop.example.com'));
      const layer = pinger(async (_input, init) => {
        seen.push(init?.redirect);
        const status = statuses.shift();
        return status ? new Response(null, { status }) : Promise.reject(new Error('timeout'));
      });
      const results = yield* Effect.all([check, check, check]).pipe(Effect.provide(layer));
      assert.deepStrictEqual(
        results.map((r) => [r.ok, r.status]),
        [
          [true, 200],
          [false, 301],
          [false, 0],
        ],
      );
      assert.deepStrictEqual(seen, ['manual', 'manual', 'manual']);
    }),
  );

  const manifest = (email?: ResolvedManifest['email']): ResolvedManifest => ({
    name: 'shop',
    listed: true,
    auth: { enabled: false, required: false },
    db: false,
    queues: {},
    events: [],
    eventOptions: {},
    crons: {},
    storage: [],
    storageOptions: {},
    secrets: [],
    env: {},
    ...(email ? { email } : {}),
  });
  const deployment = (app: string, id: string, m: ResolvedManifest): DeploymentItem => ({
    id,
    app,
    stage: 'prod',
    status: 'succeeded',
    actor: 'bob',
    events: [],
    createdAt: '2026-11-01T00:00:00.000Z',
    manifest: m,
  });
  const prod = (app: string, over: Partial<StageItem> = {}): StageItem => ({
    app,
    stage: 'prod',
    host: `${app}.example.com`,
    url: `https://${app}.example.com`,
    status: 'active',
    preview: false,
    currentDeployment: `${app}-d1`,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    up: true,
    route: { v: 1, app, stage: 'prod', d: `${app}-d1`, s: `${app}/prod/${app}-d1` },
    ...over,
  });
  const store = () =>
    memoryStore({
      stages: [prod('shop'), prod('blog', { emailPaused: true })],
      deployments: [
        deployment('shop', 'shop-d1', manifest({ dailyLimit: 200 })),
        // blog stopped sending email since its last pause.
        deployment('blog', 'blog-d1', manifest()),
      ],
    });
  const fakeAws = (published: PublishCommandInput[]) => ({
    ddb: () => ({ send: async () => ({}) }) as unknown as DynamoDBDocumentClient,
    sns: () =>
      ({
        send: async (command: { input: PublishCommandInput }) => {
          published.push(command.input);
          return {};
        },
      }) as unknown as SNSClient,
  });

  effect.live('alerts when SES pauses or resumes a prod stage’s email', () =>
    Effect.gen(function* () {
      const published: PublishCommandInput[] = [];
      const statuses: EmailSending[] = [
        { status: 'enabled' },
        { status: 'paused', pausedBy: 'policy', cause: 'Bounce finding', since: '2026-11-15T10:00:00.000Z' },
        { status: 'paused', pausedBy: 'policy', cause: 'Bounce finding', since: '2026-11-15T10:00:00.000Z' },
        { status: 'enabled' },
      ];
      const asked = yield* Ref.make<ReadonlyArray<string>>([]);
      const layer = pinger(async () => new Response('ok'), {
        aws: fakeAws(published),
        store: store(),
        email: {
          sending: (app) =>
            Effect.gen(function* () {
              yield* Ref.update(asked, (a) => [...a, app]);
              return Option.fromNullishOr(statuses.shift());
            }),
        },
      });
      const states = yield* Effect.gen(function* () {
        const out: Array<{ paused: boolean | undefined; alerts: ReadonlyArray<string | undefined> }> = [];
        for (let i = 0; i < 4; i++) {
          const before = published.length;
          const result = yield* Pinger.use((p) => p.run);
          assert.deepStrictEqual(result, { checked: 2, down: [] });
          const shop = yield* Store.use((s) => s.getStage('shop', 'prod'));
          out.push({
            paused: Option.getOrUndefined(shop)?.emailPaused,
            alerts: published.slice(before).map((p) => p.Subject),
          });
        }
        const blog = Option.getOrUndefined(yield* Store.use((s) => s.getStage('blog', 'prod')));
        // A stage without email has no pause to remember, and nothing to alert about.
        assert.strictEqual(blog?.emailPaused, undefined);
        const shop = Option.getOrUndefined(yield* Store.use((s) => s.getStage('shop', 'prod')));
        assert.isString(shop?.emailChangedAt);
        return out;
      }).pipe(Effect.provide(layer));

      assert.deepStrictEqual(states, [
        { paused: false, alerts: [] },
        { paused: true, alerts: ['[platform] shop email is PAUSED'] },
        { paused: true, alerts: [] },
        { paused: false, alerts: ['[platform] shop email is sending again'] },
      ]);
      // Only stages whose live deployment declares email are asked about.
      assert.deepStrictEqual(yield* Ref.get(asked), ['shop', 'shop', 'shop', 'shop']);
      assert.strictEqual(published[0]?.TopicArn, 'arn:alerts');
      assert.match(published[0]?.Message ?? '', /^The reputation policy paused shop's email \(prod\)/);
    }),
  );

  effect.live('keeps checking uptime when SES can’t be read', () =>
    Effect.gen(function* () {
      const published: PublishCommandInput[] = [];
      const failures = [
        Effect.fail(new AwsError({ code: 'AccessDeniedException', message: 'denied', cause: null })),
        Effect.die(new Error('SES answered something unexpected')),
      ];
      const layer = pinger(async () => new Response(null, { status: 503 }), {
        aws: fakeAws(published),
        store: memoryStore({
          stages: [prod('shop', { failures: 1 })],
          deployments: [deployment('shop', 'shop-d1', manifest({ dailyLimit: 200 }))],
        }),
        email: { sending: () => failures.shift() ?? Effect.succeedNone },
      });
      const { first, second, shop } = yield* Effect.gen(function* () {
        return {
          first: yield* Pinger.use((p) => p.run),
          second: yield* Pinger.use((p) => p.run),
          shop: Option.getOrUndefined(yield* Store.use((s) => s.getStage('shop', 'prod'))),
        };
      }).pipe(Effect.provide(layer));
      // The second failed check takes it down and alerts, whatever SES said.
      assert.deepStrictEqual(first, { checked: 1, down: ['shop'] });
      assert.deepStrictEqual(second, { checked: 1, down: ['shop'] });
      assert.deepStrictEqual(
        published.map((p) => p.Subject),
        ['[platform] shop is DOWN'],
      );
      assert.strictEqual(shop?.up, false);
      assert.strictEqual(shop?.failures, 3);
      assert.strictEqual(shop?.emailPaused, undefined);
    }),
  );

  /**
   * The uptime rows the pinger writes, kept the way the telemetry table
   * would, so `lastUptime` answers the newest; and the requests it sent.
   */
  const uptimeWorld = (seed: ReadonlyArray<Record<string, unknown>> = []) => {
    const rows: Array<Record<string, unknown>> = [...seed];
    const published: PublishCommandInput[] = [];
    const fetched: string[] = [];
    const ddb = {
      send: async (command: unknown) => {
        if (command instanceof PutCommand) rows.push(command.input.Item as Record<string, unknown>);
        return {};
      },
    } as unknown as DynamoDBDocumentClient;
    const telemetry = (traffic: (app: string) => { req: number; s5xx: number } | undefined) =>
      ({
        metrics: (app, stage, range) =>
          Effect.succeed({
            app,
            stage,
            res: range.res,
            points: [traffic(app)]
              .filter((t) => t !== undefined)
              .map((t) => ({ ts: telemetryKeys.time(range.from), ...t, s2xx: 0, s3xx: 0, s4xx: 0, cold: 0 }))
              .map((p) => ({ ...p, p50: null, p95: null, p99: null })),
          }),
        lastUptime: (app) =>
          Effect.sync(() =>
            Option.map(Option.fromNullishOr(rows.findLast((r) => r.pk === `u#${app}#prod`)), toUptimePoint),
          ),
      }) satisfies Partial<TelemetryQuery['Service']>;
    const fetch = (status: number) => async (input: string | URL | Request) => {
      fetched.push(input instanceof Request ? input.url : input.toString());
      return new Response(null, { status });
    };
    const aws = {
      ddb: () => ddb,
      sns: () =>
        ({
          send: async (command: { input: PublishCommandInput }) => {
            published.push(command.input);
            return {};
          },
        }) as unknown as SNSClient,
    };
    return { rows, published, fetched, telemetry, fetch, aws };
  };
  const server = (app: string) =>
    deployment(app, `${app}-d1`, parseManifest({ name: app, web: { server: 'src/server.ts' } }));
  const now = Date.parse('2026-11-16T12:00:20.000Z');
  const rowAt = (app: string, ms: number, row: Record<string, unknown>) => ({
    pk: `u#${app}#prod`,
    sk: new Date(ms).toISOString(),
    ...row,
  });

  effect.effect('takes uptime from traffic, and sends a check only where nothing else tells', () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now);
      const w = uptimeWorld([
        rowAt('blog', now - 3_600_000, { source: 'check', ok: true, status: 200, ms: 40 }),
        rowAt('wiki', now - 7 * 3_600_000, { ok: true, status: 200, ms: 40 }),
      ]);
      const windows: Array<{ from: string; to: string }> = [];
      const traffic = w.telemetry((app) => (app === 'shop' ? { req: 40, s5xx: 1 } : undefined));
      const layer = pinger(w.fetch(200), {
        aws: w.aws,
        telemetry: {
          ...traffic,
          metrics: (app, stage, range) => {
            if (app === 'shop')
              windows.push({
                from: new Date(range.from).toISOString(),
                to: new Date(range.to).toISOString(),
              });
            return traffic.metrics(app, stage, range);
          },
        },
        store: memoryStore({
          stages: [
            prod('shop'),
            prod('blog'),
            prod('wiki'),
            prod('docs'),
            prod('platform'),
            prod('ticker', { route: undefined }),
          ],
          deployments: [
            server('shop'),
            server('blog'),
            server('wiki'),
            // Static files only: the router answers its health.
            deployment('docs', 'docs-d1', parseManifest({ name: 'docs', web: { static: 'dist' } })),
            server('platform'),
            deployment(
              'ticker',
              'ticker-d1',
              parseManifest({ name: 'ticker', crons: { tick: 'rate(1 minute)' } }),
            ),
          ],
        }),
      });
      const result = yield* Pinger.use((p) => p.run).pipe(Effect.provide(layer));
      assert.deepStrictEqual(result, { checked: 6, down: [] });
      // The 10 complete minutes before the run.
      assert.deepStrictEqual(windows, [{ from: '2026-11-16T11:50:00.000Z', to: '2026-11-16T11:59:59.999Z' }]);
      // wiki's last check (an old row, before rows had a source) is 7 hours old; docs has no server.
      assert.deepStrictEqual(w.fetched.toSorted(), [
        'https://docs.example.com/__platform/health',
        'https://wiki.example.com/__platform/health',
      ]);
      const written: Array<Record<string, unknown>> = w.rows
        .slice(2)
        .map(({ pk, sk: _, ttl: __, ms: ___, ...r }) => ({ pk, ...r }));
      assert.deepStrictEqual(
        written.toSorted((a, b) => String(a.pk).localeCompare(String(b.pk))),
        [
          { pk: 'u#docs#prod', source: 'check', ok: true, status: 200 },
          { pk: 'u#shop#prod', source: 'traffic', ok: true, req: 40, s5xx: 1 },
          { pk: 'u#wiki#prod', source: 'check', ok: true, status: 200 },
        ],
      );
    }),
  );

  effect.effect('goes down after two failing windows of traffic, and says what it saw', () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now);
      const w = uptimeWorld();
      const layer = pinger(w.fetch(200), {
        aws: w.aws,
        telemetry: w.telemetry(() => ({ req: 40, s5xx: 31 })),
        store: memoryStore({ stages: [prod('shop')], deployments: [server('shop')] }),
      });
      const { first, second, shop } = yield* Effect.gen(function* () {
        const before = yield* Pinger.use((p) => p.run);
        yield* TestClock.adjust('5 minutes');
        return {
          first: before,
          second: yield* Pinger.use((p) => p.run),
          shop: Option.getOrUndefined(yield* Store.use((s) => s.getStage('shop', 'prod'))),
        };
      }).pipe(Effect.provide(layer));
      assert.deepStrictEqual([first.down, second.down], [[], ['shop']]);
      assert.deepStrictEqual([shop?.up, shop?.failures], [false, 2]);
      assert.deepStrictEqual(w.fetched, []);
      assert.deepStrictEqual(
        w.published.map((p) => [p.Subject, p.Message]),
        [
          [
            '[platform] shop is DOWN',
            '31 of 40 requests in the last 10 minutes were 5xx\n\nhttps://platform.example.com/apps/shop',
          ],
        ],
      );
    }),
  );

  effect.effect('checks a server once it goes quiet, then leaves it for 6 hours', () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now);
      const w = uptimeWorld([
        rowAt('shop', now - 5 * 60_000, { source: 'traffic', ok: true, req: 3, s5xx: 0 }),
      ]);
      const layer = pinger(w.fetch(200), {
        aws: w.aws,
        telemetry: w.telemetry(() => undefined),
        store: memoryStore({ stages: [prod('shop')], deployments: [server('shop')] }),
      });
      const fetchedAfter = yield* Effect.gen(function* () {
        const counts: number[] = [];
        for (const step of ['5 minutes', '5 hours', '55 minutes'] as const) {
          yield* Pinger.use((p) => p.run);
          counts.push(w.fetched.length);
          yield* TestClock.adjust(step);
        }
        yield* Pinger.use((p) => p.run);
        counts.push(w.fetched.length);
        return counts;
      }).pipe(Effect.provide(layer));
      // Just quiet: checked. 5 minutes and 5 hours later: nothing. 6 hours after the check: checked.
      assert.deepStrictEqual(fetchedAfter, [1, 1, 1, 2]);
      assert.strictEqual(w.rows.length, 3);
    }),
  );

  effect.effect(
    'checks a quiet server that failed again on the next run, so two failures still take it down',
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(now);
        const w = uptimeWorld([
          rowAt('shop', now - 7 * 3_600_000, { source: 'check', ok: true, status: 200, ms: 9 }),
        ]);
        const layer = pinger(w.fetch(503), {
          aws: w.aws,
          telemetry: w.telemetry(() => undefined),
          store: memoryStore({ stages: [prod('shop')], deployments: [server('shop')] }),
        });
        const downs = yield* Effect.gen(function* () {
          const first = yield* Pinger.use((p) => p.run);
          yield* TestClock.adjust('5 minutes');
          const second = yield* Pinger.use((p) => p.run);
          return [first.down, second.down];
        }).pipe(Effect.provide(layer));
        assert.deepStrictEqual(downs, [[], ['shop']]);
        assert.strictEqual(w.fetched.length, 2);
        assert.deepStrictEqual(
          w.published.map((p) => p.Subject),
          ['[platform] shop is DOWN'],
        );
        assert.match(
          w.published[0]?.Message ?? '',
          /^https:\/\/shop\.example\.com\/__platform\/health → 503 in \d+ms/,
        );
      }),
  );
});

describe('runtime records', () => {
  it('summarizes Lambda runtime JSON as system lines', () => {
    const summary = JSON.stringify({
      type: 'platform.invokeSummary',
      record: { metrics: { requests: 6, cpuTimeMs: 209, maxMemoryUsageMb: 218 } },
    });
    expect(toLogLine('web', 1, summary)).toEqual({
      ts: new Date(1).toISOString(),
      stream: 'web',
      level: 'system',
      message: 'runtime: 6 requests in the last minute, 209 ms CPU, 218 MB',
    });
    expect(
      runtimeRecord(
        JSON.stringify({
          type: 'platform.initReport',
          record: { status: 'success', metrics: { totalDurationMs: 416 } },
        }),
      ),
    ).toBe('runtime: init success in 416 ms');
    expect(runtimeRecord('{"t":"req","_p":1}')).toBeUndefined();
    expect(runtimeRecord('plain text')).toBeUndefined();
  });
});

describe('realtime', () => {
  const hour = 3_600_000;
  const t0 = Date.parse('2026-11-15T10:00:00Z');
  const withRealtime = { ...runtime, realtime: { apiId: 'api1', httpDomain: 'h', realtimeDomain: 'r' } };

  it('reads 1-minute data only while CloudWatch keeps it', () => {
    const now = t0;
    expect(cloudWatchRange({ from: now - hour, to: now, res: '1m' }, now).res).toBe('1m');
    expect(
      cloudWatchRange({ from: now - 16 * 24 * hour, to: now - 15.9 * 24 * hour, res: '1m' }, now).res,
    ).toBe('1h');
    expect(cloudWatchRange({ from: now - 30 * 24 * hour, to: now, res: '1d' }, now).res).toBe('1d');
  });

  it('queries every per-namespace metric as a sum', () => {
    const queries = realtimeQueries('api1', 'shop--prod', { from: t0, to: t0 + hour, res: '1h' });
    expect(queries.map((q) => q.MetricStat?.Metric?.MetricName)).toEqual(REALTIME_METRICS.map(([, m]) => m));
    expect(queries[0]).toMatchObject({
      Id: 'm0',
      MetricStat: {
        Metric: {
          Namespace: 'AWS/AppSync',
          Dimensions: [
            { Name: 'EventAPIId', Value: 'api1' },
            { Name: 'ChannelNamespaceName', Value: 'shop--prod' },
          ],
        },
        Period: 3600,
        Stat: 'Sum',
      },
    });
  });

  it('builds a dense series and totals, adding the error metrics together', () => {
    const at = (h: number) => new Date(t0 + h * hour);
    const { points, totals } = toRealtimeSeries(
      [
        { Id: 'm0', Timestamps: [at(1)], Values: [10] },
        { Id: 'm2', Timestamps: [at(0), at(2)], Values: [4, 1] },
        { Id: 'm3', Timestamps: [at(2)], Values: [2] },
        { Id: 'm6', Timestamps: [at(2)], Values: [1] },
        // Outside the range, and an id no query has.
        { Id: 'm1', Timestamps: [at(9)], Values: [99] },
        { Id: 'm99', Timestamps: [at(1)], Values: [5] },
      ],
      { from: t0, to: t0 + 2 * hour, res: '1h' },
    );
    expect(points).toEqual([
      { ts: at(0).toISOString(), events: 0, publishes: 0, subscribes: 4, errors: 0 },
      { ts: at(1).toISOString(), events: 10, publishes: 0, subscribes: 0, errors: 0 },
      { ts: at(2).toISOString(), events: 0, publishes: 0, subscribes: 1, errors: 3 },
    ]);
    expect(totals).toEqual({ events: 10, publishes: 0, subscribes: 5, errors: 3 });
  });

  effect.effect('reads the namespace’s metrics, or reports realtime off', () =>
    Effect.gen(function* () {
      const sent: GetMetricDataCommand[] = [];
      const cloudwatch = {
        send: (command: GetMetricDataCommand) => {
          sent.push(command);
          return Promise.resolve({
            MetricDataResults: [{ Id: 'm0', Timestamps: [new Date(t0)], Values: [7] }],
          });
        },
      } as unknown as CloudWatchClient;
      const range = { from: t0, to: t0 + hour, res: '1h' as const };
      const stats = (rt: typeof runtime) =>
        AppRealtime.use((r) =>
          r.stats('shop', 'prod', { subscribe: 'public', channels: ['board'] }, range),
        ).pipe(
          Effect.provide(
            AppRealtime.layer.pipe(
              Layer.provide([
                awsLayer({ cloudwatch: () => cloudwatch }),
                settingsLayer({ runtime: Effect.succeed(rt) }),
              ]),
            ),
          ),
        );

      const on = yield* stats(withRealtime);
      assert.strictEqual(on.enabled, true);
      assert.deepStrictEqual(on.channels, ['board']);
      assert.strictEqual(on.totals.events, 7);
      assert.strictEqual(sent.length, 1);
      assert.strictEqual(
        sent[0]!.input.MetricDataQueries?.[0]?.MetricStat?.Metric?.Dimensions?.[1]?.Value,
        'shop--prod',
      );

      // A platform without an Event API has no namespace to read.
      const off = yield* stats(runtime);
      assert.strictEqual(off.enabled, false);
      assert.strictEqual(off.points.length, 2);
      assert.strictEqual(sent.length, 1);
    }),
  );

  effect.effect('extends the public key daily, and skips platforms without an Event API', () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const run = (rt: typeof runtime, fail = false) =>
        RealtimeKey.use((k) => k.run).pipe(
          Effect.provide(
            RealtimeKey.layer.pipe(
              Layer.provide([
                settingsLayer({ runtime: Effect.succeed(rt) }),
                Layer.mock(StageEngine, {
                  ensureRealtime: (platform, log) =>
                    Effect.suspend(() => {
                      calls.push(platform.realtime?.apiId ?? 'none');
                      log({ level: 'info', msg: 'extended the public subscribe key' });
                      return fail
                        ? Effect.fail(new DeployFailed({ message: 'AccessDenied' }))
                        : Effect.succeedSome({ v: 1 as const, o: 'r', h: 'h', k: 'da2-x' });
                    }),
                }),
              ]),
            ),
          ),
        );

      assert.deepStrictEqual(yield* run(runtime), { realtime: false });
      assert.deepStrictEqual(calls, []);
      assert.deepStrictEqual(yield* run(withRealtime), { realtime: true });
      assert.deepStrictEqual(calls, ['api1']);
      // A failure fails the cron, so it shows as a failed job and retries.
      const failed = yield* Effect.flip(run(withRealtime, true));
      assert.strictEqual(failed.message, 'AccessDenied');
    }),
  );
});

describe('storage expiry', () => {
  const stage = (s: string, status: StageItem['status'], currentDeployment?: string): StageItem => ({
    app: 'atlas',
    stage: s,
    host: 'h',
    url: 'u',
    status,
    preview: s.startsWith('pr-'),
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
    ...(currentDeployment ? { currentDeployment } : {}),
  });
  const deployment = (id: string, s: string, storage: ManifestInput['storage']): DeploymentItem => ({
    id,
    app: 'atlas',
    stage: s,
    status: 'succeeded',
    actor: 'bob',
    events: [],
    createdAt: '2026-11-01T00:00:00Z',
    manifest: parseManifest({ name: 'atlas', storage }),
  });

  it('picks stages that have a live deployment', () => {
    expect(
      liveStages([
        stage('prod', 'active', 'd1'),
        stage('pr-1', 'deploying', 'd2'),
        stage('pr-2', 'failed'),
        stage('pr-3', 'destroyed', 'd3'),
        stage('pr-4', 'destroying', 'd4'),
      ]).map((s) => s.stage),
    ).toEqual(['prod', 'pr-1']);
  });

  effect.effect('expires the stores of live deployments that ask for it, and reports failures', () =>
    Effect.gen(function* () {
      const calls: Array<{ stage: string; now: number }> = [];
      const run = (failOn?: string) =>
        StorageExpiry.use((s) => s.run).pipe(
          Effect.provide(
            StorageExpiry.layer.pipe(
              Layer.provide([
                settingsLayer(),
                memoryStore({
                  stages: [
                    stage('prod', 'active', 'd1'),
                    stage('pr-1', 'active', 'd2'),
                    stage('pr-2', 'active', 'd3'),
                  ],
                  deployments: [
                    deployment('d1', 'prod', {
                      snapshots: { public: true, expireAfterDays: 7 },
                      uploads: {},
                    }),
                    deployment('d2', 'pr-1', ['uploads']),
                    deployment('d3', 'pr-2', { logs: { expireAfterDays: 1 } }),
                  ],
                }),
                Layer.mock(StageEngine, {
                  expireStorage: (input) =>
                    Effect.suspend(() => {
                      calls.push({ stage: input.stage, now: input.now!.getTime() });
                      return input.stage === failOn
                        ? Effect.fail(new DeployFailed({ message: 'AccessDenied' }))
                        : Effect.succeed<Record<string, number>>(
                            input.stage === 'prod' ? { snapshots: 4 } : { logs: 0 },
                          );
                    }),
                }),
              ]),
            ),
          ),
        );

      assert.deepStrictEqual(yield* run(), { deleted: { 'atlas/prod/snapshots': 4, 'atlas/pr-2/logs': 0 } });
      // A stage without expiring stores isn't touched.
      assert.deepStrictEqual(
        calls.map((c) => c.stage),
        ['prod', 'pr-2'],
      );
      calls.length = 0;
      const failed = yield* Effect.flip(run('prod'));
      assert.strictEqual(failed.message, 'AccessDenied');
      // The other stages still ran.
      assert.deepStrictEqual(
        calls.map((c) => c.stage),
        ['prod', 'pr-2'],
      );
    }),
  );
});
