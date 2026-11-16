import { runInNewContext } from 'node:vm';
import { Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import { buildRouterFunctionCode } from '../src/cloudfront-function.ts';
import {
  decide,
  definePlatformConfig,
  errorFingerprint,
  HEALTH_PATH,
  handlerFunctionName,
  handlerSettings,
  latencyBucket,
  names,
  newDeploymentId,
  normalizeErrorMessage,
  ownFunctionHandlers,
  parseManifest,
  parseStageHost,
  percentile,
  type PlatformConfig,
  publicStores,
  REALTIME_KVS_KEY,
  REALTIME_PATH,
  REALTIME_TOKEN_PATH,
  type RealtimeEdgeEntry,
  ResolvedManifest,
  type RouteRecord,
  STORAGE_CACHE_HOST,
  STORAGE_PATH,
  stageHost,
  toSchedulerExpression,
  validateAppName,
  validateStageName,
} from '../src/index.ts';

describe('naming', () => {
  it('validates app and stage names', () => {
    expect(validateAppName('todo')).toBeNull();
    expect(validateAppName('my-app2')).toBeNull();
    expect(validateAppName('ab')).toMatch(/3-30/);
    expect(validateAppName('a--b')).toMatch(/single hyphens/);
    expect(validateAppName('platform')).toMatch(/reserved/);
    expect(validateAppName('orbit', ['orbit'])).toMatch(/reserved/);
    expect(validateStageName('prod')).toBeNull();
    expect(validateStageName('pr-12')).toBeNull();
    expect(validateStageName('PR')).not.toBeNull();
  });

  it('round-trips hosts', () => {
    expect(stageHost('foo', 'prod', 'example.com')).toBe('foo.example.com');
    expect(stageHost('foo', 'pr-12', 'example.com')).toBe('foo--pr-12.example.com');
    expect(parseStageHost('foo--pr-12.example.com', 'example.com')).toEqual({ app: 'foo', stage: 'pr-12' });
    expect(parseStageHost('foo.example.com:443', 'example.com')).toEqual({ app: 'foo', stage: 'prod' });
    expect(parseStageHost('a.b.example.com', 'example.com')).toBeNull();
    expect(parseStageHost('foo.other.com', 'example.com')).toBeNull();
  });

  it('keeps resource names within AWS limits', () => {
    const app = 'a'.repeat(30);
    const stage = 'b'.repeat(20);
    expect(names.workerFunction(app, stage).length).toBeLessThanOrEqual(64);
    expect(names.deadLetters(app, stage).length).toBeLessThanOrEqual(80);
    expect(names.legacyDeadLetterQueue(app, stage, 'c'.repeat(20)).length).toBeLessThanOrEqual(80);
    expect(names.eventRule(app, stage, 'x'.repeat(60)).length).toBeLessThanOrEqual(64);
  });

  it('names handler functions within Lambda’s limits, one name per handler', () => {
    expect(names.handlerFunction('atlas', 'prod', 'queue', 'ais')).toBe('atlas--prod--worker--queue-ais');
    expect(names.handlerFunction('atlas', 'prod', 'cron', 'ais')).toBe('atlas--prod--worker--cron-ais');
    expect(names.handlerFunction('todo', 'prod', 'event', 'todo.created')).toBe(
      'todo--prod--worker--event-todo_created',
    );
    // `.` and `:` both become `_`, so a type with `:` carries a hash of itself.
    const colon = names.handlerFunction('todo', 'prod', 'event', 'todo:created');
    expect(colon).toMatch(/^todo--prod--worker--event-todo_created-[0-9a-f]{8}$/);
    expect(names.handlerFunction('todo', 'prod', 'event', 'todo:created')).toBe(colon);

    const app = 'a'.repeat(30);
    const stage = 'b'.repeat(20);
    const all = [
      names.handlerFunction(app, stage, 'queue', 'c'.repeat(20)),
      names.handlerFunction(app, stage, 'queue', `${'c'.repeat(19)}d`),
      names.handlerFunction(app, stage, 'event', `Order.${'x'.repeat(58)}`),
      names.handlerFunction(app, stage, 'event', `Order:${'x'.repeat(58)}`),
    ];
    expect(new Set(all).size).toBe(all.length);
    for (const name of all) {
      expect(name.length).toBeLessThanOrEqual(64);
      expect(name).toMatch(/^[A-Za-z0-9_-]+$/);
      // What the engine finds a stage's functions by, and what the role boundary allows to be invoked.
      expect(name.startsWith(`${app}--${stage}--`)).toBe(true);
    }
  });
});

describe('cron', () => {
  it('converts unix cron to EventBridge Scheduler syntax', () => {
    expect(toSchedulerExpression('0 8 * * *')).toBe('cron(0 8 * * ? *)');
    expect(toSchedulerExpression('*/5 * * * *')).toBe('cron(*/5 * * * ? *)');
    expect(toSchedulerExpression('0 9 * * 1-5')).toBe('cron(0 9 ? * 2-6 *)');
    expect(toSchedulerExpression('0 9 * * 0')).toBe('cron(0 9 ? * 1 *)');
    expect(toSchedulerExpression('rate(5 minutes)')).toBe('rate(5 minutes)');
    expect(() => toSchedulerExpression('bad')).toThrow(/must have 5 fields/);
  });
});

describe('manifest', () => {
  it('applies defaults and derives the worker', () => {
    const m = parseManifest({
      name: 'todo',
      db: true,
      queues: { emails: {} },
      web: { server: 'src/server.ts' },
    });
    expect(m.worker?.entry).toBe('src/worker.ts');
    expect(m.queues.emails).toEqual({ maxAttempts: 5 });
    expect(m.auth).toEqual({ enabled: false, required: false });
    expect(m.web?.serverRoutes).toEqual(['/api/']);
  });

  it('reports readable errors', () => {
    expect(() => parseManifest({ name: 'x', crons: { nightly: 'nope' } })).toThrow(/name.*crons\.nightly/s);
  });

  it('takes stores as a list or with options', () => {
    const listed = parseManifest({ name: 'todo', storage: ['uploads', 'uploads', 'avatars'] });
    expect(listed.storage).toEqual(['uploads', 'avatars']);
    expect(listed.storageOptions).toEqual({ uploads: { public: false }, avatars: { public: false } });
    expect(publicStores(listed)).toEqual([]);

    const m = parseManifest({
      name: 'atlas',
      storage: { uploads: {}, snapshots: { public: true, expireAfterDays: 7 } },
    });
    expect(m.storage).toEqual(['uploads', 'snapshots']);
    expect(m.storageOptions).toEqual({
      uploads: { public: false },
      snapshots: { public: true, expireAfterDays: 7 },
    });
    expect(publicStores(m)).toEqual(['snapshots']);

    expect(() => parseManifest({ name: 'atlas', storage: { Snap: {} } })).toThrow(/storage.*Snap/s);
    expect(() => parseManifest({ name: 'atlas', storage: { snapshots: { expireAfterDays: 0 } } })).toThrow(
      /storage.*snapshots.*expireAfterDays/s,
    );
  });

  it('takes a handler’s own memory, timeout and attempts', () => {
    const m = parseManifest({
      name: 'atlas',
      worker: { timeoutSeconds: 300, memoryMb: 1024 },
      queues: { refresh: { maxAttempts: 2 }, ais: { memoryMb: 256, timeoutSeconds: 90 } },
      events: { 'fire.detected': {}, 'ship.seen': { memoryMb: 256 } },
      crons: { tick: 'rate(1 minute)', listen: { schedule: 'rate(1 minute)', timeoutSeconds: 90 } },
    });
    expect(m.queues.refresh).toEqual({ maxAttempts: 2 });
    expect(m.queues.ais).toEqual({ maxAttempts: 5, memoryMb: 256, timeoutSeconds: 90 });
    expect(m.events).toEqual(['fire.detected', 'ship.seen']);
    expect(m.eventOptions).toEqual({ 'fire.detected': {}, 'ship.seen': { memoryMb: 256 } });
    expect(m.crons.listen).toEqual({ schedule: 'rate(1 minute)', timeoutSeconds: 90 });

    // A handler that sets one setting gets the worker's other one.
    expect(handlerSettings(m, 'event', 'ship.seen')).toEqual({
      kind: 'event',
      name: 'ship.seen',
      memoryMb: 256,
      timeoutSeconds: 300,
      maxAttempts: 3,
      own: true,
    });
    expect(handlerSettings(m, 'queue', 'refresh')).toMatchObject({
      memoryMb: 1024,
      timeoutSeconds: 300,
      maxAttempts: 2,
      own: false,
    });
    expect(ownFunctionHandlers(m).map((h) => `${h.kind}:${h.name}`)).toEqual([
      'queue:ais',
      'event:ship.seen',
      'cron:listen',
    ]);
    expect(handlerFunctionName('atlas', 'prod', m, 'cron', 'listen')).toBe(
      'atlas--prod--worker--cron-listen',
    );
    expect(handlerFunctionName('atlas', 'prod', m, 'cron', 'tick')).toBe('atlas--prod--worker');

    // Without a worker block, the defaults stand in for the worker's settings.
    const bare = parseManifest({
      name: 'atlas',
      crons: { ais: { schedule: 'rate(1 minute)', memoryMb: 256 } },
    });
    expect(handlerSettings(bare, 'cron', 'ais')).toMatchObject({ memoryMb: 256, timeoutSeconds: 60 });

    expect(() => parseManifest({ name: 'atlas', queues: { ais: { memoryMb: 64 } } })).toThrow(
      /queues\.ais\.memoryMb/,
    );
    expect(() => parseManifest({ name: 'atlas', events: { 'ship.seen': { timeoutSeconds: 901 } } })).toThrow(
      /events\.ship\.seen\.timeoutSeconds/,
    );
    expect(() =>
      parseManifest({ name: 'atlas', crons: { ais: { schedule: 'rate(1 minute)', memoryMb: 100.5 } } }),
    ).toThrow(/crons\.ais/);
  });

  it('runs a queue with a concurrency cap in a function of its own', () => {
    const m = parseManifest({ name: 'atlas', queues: { ais: { concurrency: 2 } } });
    expect(handlerSettings(m, 'queue', 'ais')).toMatchObject({ concurrency: 2, own: true, maxAttempts: 5 });
    expect(handlerFunctionName('atlas', 'prod', m, 'queue', 'ais')).toBe('atlas--prod--worker--queue-ais');
  });

  it('refuses the queue settings that went away with SQS', () => {
    expect(() => parseManifest({ name: 'atlas', queues: { refresh: { batchSize: 1 } } })).toThrow(
      /queues\.refresh\.batchSize: removed in 0\.4\.0/,
    );
    expect(() => parseManifest({ name: 'atlas', queues: { refresh: { maxReceiveCount: 2 } } })).toThrow(
      /queues\.refresh\.maxReceiveCount: renamed to maxAttempts/,
    );
    expect(() =>
      parseManifest({ name: 'atlas', queues: { refresh: { visibilityTimeoutSeconds: 60 } } }),
    ).toThrow(/visibilityTimeoutSeconds/);
  });

  it('decodes deployments recorded when queues were SQS queues', () => {
    const stored = {
      ...parseManifest({ name: 'atlas', queues: { refresh: {} } }),
      queues: { refresh: { batchSize: 1, maxReceiveCount: 2, visibilityTimeoutSeconds: 360 } },
    };
    const m = Schema.decodeUnknownSync(ResolvedManifest)(JSON.parse(JSON.stringify(stored)));
    expect(m.queues.refresh).toEqual({ maxAttempts: 5 });
  });

  it('decodes deployments recorded before handlers had settings', () => {
    const stored = {
      ...parseManifest({ name: 'todo', events: ['a.b'], crons: { nightly: '0 3 * * *' } }),
      eventOptions: undefined,
    };
    const m = Schema.decodeUnknownSync(ResolvedManifest)(JSON.parse(JSON.stringify(stored)));
    expect(m.events).toEqual(['a.b']);
    expect(m.eventOptions).toEqual({});
    expect(handlerFunctionName('todo', 'prod', m, 'event', 'a.b')).toBe('todo--prod--worker');
  });

  it('decodes deployments recorded before stores had options', () => {
    const stored = {
      ...parseManifest({ name: 'todo', storage: ['uploads'] }),
      storageOptions: undefined,
    };
    const m = Schema.decodeUnknownSync(ResolvedManifest)(JSON.parse(JSON.stringify(stored)));
    expect(m.storage).toEqual(['uploads']);
    expect(m.storageOptions).toEqual({});
    expect(publicStores(m)).toEqual([]);
  });
});

describe('router decide', () => {
  const both: RouteRecord = {
    v: 1,
    app: 'a',
    stage: 'prod',
    d: 'd1',
    o: 'fn.example',
    s: 'a/prod/d1',
    r: ['/api/'],
    spa: 1,
  };
  it('routes api, files and spa fallbacks', () => {
    expect(decide(both, '/api/todos')).toEqual({ t: 'server' });
    expect(decide(both, '/api')).toEqual({ t: 'server' });
    expect(decide(both, '/__platform/health')).toEqual({ t: 'server' });
    expect(decide(both, '/assets/app.js')).toEqual({ t: 'static', key: '/a/prod/d1/assets/app.js' });
    expect(decide(both, '/settings')).toEqual({ t: 'static', key: '/a/prod/d1/index.html' });
  });
  it('handles server-only, static-only and ssr', () => {
    expect(decide({ v: 1, app: 'a', stage: 'p', d: 'd', o: 'fn' }, '/x')).toEqual({ t: 'server' });
    // No server to answer health: the router reports the route's deployment itself.
    expect(decide({ v: 1, app: 'a', stage: 'p', d: 'd', s: 'p' }, HEALTH_PATH)).toEqual({ t: 'health' });
    expect(decide({ v: 1, app: 'a', stage: 'p', d: 'd', s: 'p' }, '/__platform/auth/me')).toEqual({
      t: 'notfound',
    });
    expect(decide({ v: 1, app: 'a', stage: 'p', d: 'd', s: 'p' }, '/docs/')).toEqual({
      t: 'static',
      key: '/p/docs/index.html',
    });
    expect(decide({ v: 1, app: 'a', stage: 'p', d: 'd', o: 'fn', s: 'p', r: [], spa: 0 }, '/page')).toEqual({
      t: 'server',
    });
    expect(decide(null, '/')).toEqual({ t: 'notfound' });
  });
  it('keeps the realtime path for the router when the stage has realtime', () => {
    const rt = { ...both, rt: { n: 'a--prod', m: 'p' as const } };
    expect(decide(rt, REALTIME_PATH)).toEqual({ t: 'realtime' });
    expect(decide({ v: 1, app: 'a', stage: 'p', d: 'd', s: 'p', rt: rt.rt }, REALTIME_PATH)).toEqual({
      t: 'realtime',
    });
    // The token is the server's; a stage without realtime treats the path like any platform path.
    expect(decide(rt, REALTIME_TOKEN_PATH)).toEqual({ t: 'server' });
    expect(decide(both, REALTIME_PATH)).toEqual({ t: 'server' });
    expect(decide({ v: 1, app: 'a', stage: 'p', d: 'd', s: 'p' }, REALTIME_PATH)).toEqual({ t: 'notfound' });
  });
  it('serves public stores and keeps the rest of the storage path from the server', () => {
    const pub: RouteRecord = { ...both, app: 'atlas', p: ['snapshots', 'tiles'] };
    expect(decide(pub, `${STORAGE_PATH}snapshots/fires/today.json`)).toEqual({
      t: 'storage',
      key: '/atlas/prod/snapshots/fires/today.json',
    });
    // Encoded as S3 decodes it.
    expect(decide(pub, `${STORAGE_PATH}tiles/a%20b/c.png`)).toEqual({
      t: 'storage',
      key: '/atlas/prod/tiles/a%20b/c.png',
    });
    for (const uri of [
      `${STORAGE_PATH}uploads/a.json`, // not public
      `${STORAGE_PATH}snapshots/`,
      `${STORAGE_PATH}snapshots`,
      `${STORAGE_PATH}/snapshots/a.json`,
      `${STORAGE_PATH}snapshots/../uploads/a.json`,
      `${STORAGE_PATH}snapshots/a/./b.json`,
      `${STORAGE_PATH}snapshots/%2e%2e/uploads/a.json`,
      `${STORAGE_PATH}snapshots/x%2F..%2F..%2Fother/a.json`,
      `${STORAGE_PATH}snapshots/.%2E/uploads/a.json`,
    ]) {
      expect(decide(pub, uri), uri).toEqual({ t: 'notfound' });
    }
    // A stage without public stores doesn't pass the path to its server either.
    expect(decide(both, `${STORAGE_PATH}snapshots/a.json`)).toEqual({ t: 'notfound' });
  });

  it('routes a stage that has only public stores', () => {
    const files: RouteRecord = { v: 1, app: 'feeds', stage: 'prod', d: 'd2', p: ['out'] };
    expect(decide(files, `${STORAGE_PATH}out/a.json`)).toEqual({
      t: 'storage',
      key: '/feeds/prod/out/a.json',
    });
    expect(decide(files, HEALTH_PATH)).toEqual({ t: 'health' });
    expect(decide(files, '/')).toEqual({ t: 'notfound' });
    expect(decide(files, '/api/x')).toEqual({ t: 'notfound' });
    expect(decide(files, '/__platform/auth/me')).toEqual({ t: 'notfound' });
  });

  it('builds a CloudFront Function with the decision inlined', () => {
    const code = buildRouterFunctionCode({ kvsId: 'kvs-123' });
    expect(code).toContain('cf.kvs("kvs-123")');
    expect(code).toContain('function decide(rec, uri)');
    expect(code).toContain("if (d.t === 'health') return health(rec);");
    expect(code).not.toContain('export ');
    expect(code.length).toBeLessThan(10 * 1024);
    // Runtime 2.0 rejects `await` inside call arguments ("await in arguments not supported").
    expect(code).not.toMatch(/\(\s*await\b/);
  });

  /** Runs the generated function with a stub `cloudfront` module serving `routes`. */
  function edge(routes: Record<string, RouteRecord | RealtimeEdgeEntry>) {
    const origins: string[] = [];
    const originConfigs: Array<Record<string, unknown>> = [];
    const cf = {
      kvs: () => ({
        get: async (host: string) => {
          if (!routes[host]) throw new Error('key not found');
          return JSON.stringify(routes[host]);
        },
      }),
      updateRequestOrigin: (o: { domainName: string }) => {
        origins.push(o.domainName);
        originConfigs.push(o);
      },
    };
    const code = buildRouterFunctionCode({ kvsId: 'kvs-123' }).replace("import cf from 'cloudfront';", '');
    // Its own global scope like the CloudFront runtime, with `cf` standing in for the import.
    const handler = runInNewContext(`${code}\nhandler`, { cf }) as (event: unknown) => Promise<{
      statusCode?: number;
      headers: Record<string, { value: string }>;
      body?: string;
      uri?: string;
    }>;
    const request = (
      host: string,
      uri: string,
      headers: Record<string, { value: string }> = {},
      extra: {
        querystring?: Record<string, { value: string }>;
        cookies?: Record<string, { value: string }>;
      } = {},
    ) =>
      handler({
        request: {
          uri,
          querystring: extra.querystring ?? {},
          headers: { host: { value: host }, ...headers },
          cookies: extra.cookies ?? {},
        },
      }) as Promise<{
        statusCode?: number;
        headers: Record<string, { value: string }>;
        body?: string;
        uri?: string;
        querystring?: Record<string, unknown>;
        cookies?: Record<string, unknown>;
      }>;
    return { request, origins, originConfigs };
  }

  it('answers the realtime config and passes WebSockets to AppSync', async () => {
    const entry: RealtimeEdgeEntry = {
      v: 1,
      o: 'rt.appsync.example',
      h: 'http.appsync.example',
      k: 'da2-key',
    };
    const pub: RouteRecord = { ...both, app: 'draw', rt: { n: 'draw--prod', m: 'p' } };
    const signed: RouteRecord = { ...both, app: 'notes', rt: { n: 'notes--prod', m: 's' } };
    const { request, origins, originConfigs } = edge({
      'draw.example.com': pub,
      'notes.example.com': signed,
      'shop.example.com': both,
      [REALTIME_KVS_KEY]: entry,
    });

    const config = await request('draw.example.com', REALTIME_PATH);
    expect(config.statusCode).toBe(200);
    expect(config.headers['cache-control']?.value).toBe('no-store');
    expect(JSON.parse(config.body!)).toEqual({
      v: 1,
      host: 'http.appsync.example',
      namespace: 'draw--prod',
      subscribe: 'public',
      apiKey: 'da2-key',
    });
    // Signed-in stages never hand out the key.
    expect(JSON.parse((await request('notes.example.com', REALTIME_PATH)).body!)).toEqual({
      v: 1,
      host: 'http.appsync.example',
      namespace: 'notes--prod',
      subscribe: 'signed-in',
    });

    // CloudFront strips `Upgrade` before functions run, so the handshake is recognized by its key.
    const ws = await request('draw.example.com', REALTIME_PATH, {
      'sec-websocket-key': { value: 'abc==' },
      authorization: { value: 'x' },
    });
    expect(ws.uri).toBe('/event/realtime');
    expect(ws.headers.authorization).toBeUndefined();
    expect(origins).toEqual(['rt.appsync.example']);
    expect(originConfigs[0]).toMatchObject({ originAccessControlConfig: { enabled: false } });

    // No realtime on the stage: the path is the server's like any other platform path.
    await request('shop.example.com', REALTIME_PATH);
    expect(origins).toEqual(['rt.appsync.example', 'fn.example']);
  });

  it('rewrites public store files into the storage origin without query, cookies or credentials', async () => {
    const atlas: RouteRecord = { ...both, app: 'atlas', p: ['snapshots'] };
    const { request, origins } = edge({ 'atlas.example.com': atlas });
    const res = await request(
      'atlas.example.com',
      `${STORAGE_PATH}snapshots/fires.json`,
      { authorization: { value: 'Bearer x' } },
      {
        querystring: { 'response-content-type': { value: 'text/html' } },
        cookies: { session: { value: 's' } },
      },
    );
    expect(res.statusCode).toBeUndefined();
    expect(res.uri).toBe('/atlas/prod/snapshots/fires.json');
    expect(res.querystring).toEqual({});
    expect(res.cookies).toEqual({});
    expect(res.headers.authorization).toBeUndefined();
    // The behavior's own origin: no switch.
    expect(origins).toEqual([]);
    // Its own cache key: the server of a server-only app gets the same path unchanged.
    expect(res.headers['x-platform-host']?.value).toBe(STORAGE_CACHE_HOST);
    expect((await request('atlas.example.com', `${STORAGE_PATH}uploads/a.json`)).statusCode).toBe(404);
    expect((await request('atlas.example.com', `${STORAGE_PATH}snapshots/../x`)).statusCode).toBe(404);
  });

  it('keeps a public file and a server response for the same path apart in the cache', async () => {
    const feeds: RouteRecord = { v: 1, app: 'feeds', stage: 'prod', d: 'd1', o: 'fn.example', p: ['out'] };
    const { request } = edge({ 'feeds.example.com': feeds });
    const file = await request('feeds.example.com', `${STORAGE_PATH}out/a.json`);
    const server = await request('feeds.example.com', '/feeds/prod/out/a.json');
    // CloudFront keys its cache on the URI and x-platform-host, not the behavior or origin.
    expect(file.uri).toBe(server.uri);
    expect(file.headers['x-platform-host']?.value).toBe(STORAGE_CACHE_HOST);
    expect(server.headers['x-platform-host']?.value).toBe('feeds.example.com');
    // A client can't pick the storage key for the server: the router sets the header.
    const forged = await request('feeds.example.com', '/feeds/prod/out/a.json', {
      'x-platform-host': { value: STORAGE_CACHE_HOST },
    });
    expect(forged.headers['x-platform-host']?.value).toBe('feeds.example.com');
  });

  it('answers 404 for realtime until the platform entry exists', async () => {
    const { request } = edge({ 'draw.example.com': { ...both, rt: { n: 'draw--prod', m: 'p' } } });
    expect((await request('draw.example.com', REALTIME_PATH)).statusCode).toBe(404);
  });

  it('answers health from the route when the stage has no server', async () => {
    const site: RouteRecord = { v: 1, app: 'docs', stage: 'prod', d: 'd7', s: 'docs/prod/d7', spa: 1 };
    const { request, origins } = edge({ 'docs.example.com': site, 'shop.example.com': both });

    const res = await request('docs.example.com', HEALTH_PATH);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']?.value).toBe('no-store');
    expect(JSON.parse(res.body!)).toEqual({ ok: true, app: 'docs', stage: 'prod', revision: 'd7' });

    expect((await request('docs.example.com', '/about')).uri).toBe('/docs/prod/d7/index.html');
    expect((await request('docs.example.com', '/__platform/auth/me')).statusCode).toBe(404);
    expect((await request('nothing.example.com', HEALTH_PATH)).statusCode).toBe(404);
    // A stage with a server answers health from the server.
    expect((await request('shop.example.com', HEALTH_PATH)).statusCode).toBeUndefined();
    expect(origins).toEqual(['fn.example']);
  });
});

describe('telemetry', () => {
  it('computes percentiles from fixed buckets', () => {
    const hist = Array.from({ length: 13 }, () => 0);
    for (const ms of [3, 8, 40, 40, 90, 200, 400, 900, 2000, 20000]) hist[latencyBucket(ms)]!++;
    expect(percentile(hist, 50)).toBe(100);
    expect(percentile(hist, 95)).toBe(30000);
    expect(percentile([], 50)).toBeNull();
  });
  it('groups similar errors', () => {
    const a = errorFingerprint('Error', 'user 123 not found', 'Error\n    at handler (/app/src/x.ts:1:2)');
    const b = errorFingerprint('Error', 'user 456 not found', 'Error\n    at handler (/app/src/x.ts:9:9)');
    expect(a).toBe(b);
  });
  it('groups errors that differ only in the ARNs they name', () => {
    const denied = (action: string, param: string) =>
      `User: arn:aws:sts::111122223333:assumed-role/platform-control-plane/platform--prod is not authorized to perform: ${action} on resource: arn:aws:ssm:us-east-1:111122223333:parameter/platform/apps/atlas/${param} because no identity-based policy allows the ${action} action`;
    const stack = 'AwsError\n    at AppSecrets.put (file:///var/task/index.mjs:131:71414)';
    const fp = (action: string, param: string) => errorFingerprint('AwsError', denied(action, param), stack);
    const tagging = fp('ssm:AddTagsToResource', '_shared/secrets/ARCGIS_API_KEY');
    expect(fp('ssm:AddTagsToResource', 'pr-1/secrets/CESIUM_ION_TOKEN')).toBe(tagging);
    expect(fp('ssm:AddTagsToResource', 'prod/secrets/ATLAS_PROBE')).toBe(tagging);
    expect(fp('ssm:PutParameter', 'prod/secrets/ATLAS_PROBE')).not.toBe(tagging);
    expect(
      normalizeErrorMessage('Requested resource not found: arn:aws-us-gov:dynamodb:x:1:table/a (retry)'),
    ).toBe('Requested resource not found: <arn> (retry)');
  });
  it('makes sortable deployment ids', () => {
    const a = newDeploymentId();
    expect(a).toMatch(/^d[0-9a-z]{26}$/);
  });
});

describe('platform config', () => {
  const base: PlatformConfig = {
    domain: 'example.com',
    region: 'us-east-1',
    zone: 'platform.example.com',
    consoleHost: 'platform.example.com',
    edgeHost: 'edge.platform.example.com',
    loginHost: 'login.platform.example.com',
    github: { owner: 'o', repo: 'r', ownerId: 1, repoId: 2 },
    members: [{ github: 'ada', role: 'admin' }],
    reservedAppNames: [],
    previewTtlDays: 7,
    limits: { appsPerMember: 1, stagesPerApp: 1, emailsPerDay: 1, servicesPerApp: 1 },
    telemetry: { logRetentionDays: { prod: 1, other: 1 } },
  };
  const floor = (edgeRequestsPerMinute: number) =>
    definePlatformConfig({ ...base, limits: { ...base.limits, edgeRequestsPerMinute } });

  it('takes an edge floor WAF can enforce, or none', () => {
    expect(definePlatformConfig(base).limits.edgeRequestsPerMinute).toBeUndefined();
    expect(floor(1000).limits.edgeRequestsPerMinute).toBe(1000);
    expect(() => floor(9)).toThrow(/at least 10/);
    expect(() => floor(10.5)).toThrow(/at least 10/);
  });
});
