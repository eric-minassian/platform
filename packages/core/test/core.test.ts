import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { buildRouterFunctionCode } from '../src/cloudfront-function.ts';
import {
  decide,
  errorFingerprint,
  HEALTH_PATH,
  latencyBucket,
  names,
  newDeploymentId,
  parseManifest,
  parseStageHost,
  percentile,
  REALTIME_KVS_KEY,
  REALTIME_PATH,
  REALTIME_TOKEN_PATH,
  type RealtimeEdgeEntry,
  type RouteRecord,
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
    expect(names.deadLetterQueue(app, stage, 'c'.repeat(20)).length).toBeLessThanOrEqual(80);
    expect(names.eventRule(app, stage, 'x'.repeat(60)).length).toBeLessThanOrEqual(64);
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
    expect(m.queues.emails?.visibilityTimeoutSeconds).toBe(360);
    expect(m.auth).toEqual({ enabled: false, required: false });
    expect(m.web?.serverRoutes).toEqual(['/api/']);
  });

  it('reports readable errors', () => {
    expect(() => parseManifest({ name: 'x', crons: { nightly: 'nope' } })).toThrow(/name.*crons\.nightly/s);
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
    const request = (host: string, uri: string, headers: Record<string, { value: string }> = {}) =>
      handler({
        request: { uri, querystring: {}, headers: { host: { value: host }, ...headers }, cookies: {} },
      });
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
  it('makes sortable deployment ids', () => {
    const a = newDeploymentId();
    expect(a).toMatch(/^d[0-9a-z]{26}$/);
  });
});
