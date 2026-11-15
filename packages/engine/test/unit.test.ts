import { type PlatformRuntimeConfig, parseManifest, type RouteRecord } from '@ericminassian/platform-core';
import { describe, expect, it } from 'vitest';
import { fixTimestamps } from '../src/compat.ts';
import { snapRetention } from '../src/drivers/logs.ts';
import { endpointForRevision } from '../src/drivers/web-function.ts';
import { cacheControlFor, contentTypeFor, hostFor, policies } from '../src/index.ts';
import { rollbackStage, staleStaticPrefixes } from '../src/stage.ts';
import type { EngineContext } from '../src/util.ts';

const platform = (over: Partial<PlatformRuntimeConfig> = {}): PlatformRuntimeConfig => ({
  v: 1,
  target: 'aws',
  accountId: '111122223333',
  region: 'us-east-1',
  domain: 'example.com',
  publicScheme: 'https',
  artifactsBucket: 'a',
  sitesBucket: 's',
  storageBucket: 'store',
  stateTable: 'platform',
  telemetryTable: 'platform-telemetry',
  ...over,
});

describe('stage role policy', () => {
  const manifest = parseManifest({
    name: 'todo',
    db: true,
    queues: { emails: {} },
    storage: ['uploads'],
    crons: { nightly: '0 3 * * *' },
  });
  const doc = policies.stageRolePolicy({
    app: 'todo',
    stage: 'prod',
    region: 'us-east-1',
    accountId: '111122223333',
    manifest,
    platform: platform(),
  });
  const bySid = Object.fromEntries(doc.Statement.map((s) => [s.Sid, s]));

  it('scopes every grant to this stage', () => {
    expect(bySid.Db?.Resource).toEqual([
      'arn:aws:dynamodb:us-east-1:111122223333:table/todo--prod',
      'arn:aws:dynamodb:us-east-1:111122223333:table/todo--prod/index/*',
    ]);
    expect(bySid.Queues?.Resource).toBe('arn:aws:sqs:us-east-1:111122223333:todo--prod--*');
    expect(bySid.Events?.Resource).toBe('arn:aws:events:us-east-1:111122223333:event-bus/todo--prod');
    expect(bySid.StorageObjects?.Resource).toBe('arn:aws:s3:::store/todo/prod/*');
    expect(bySid.StorageList?.Condition).toEqual({ StringLike: { 's3:prefix': ['todo/prod/*'] } });
    expect(bySid.InvokeWorker?.Resource).toBe(
      'arn:aws:lambda:us-east-1:111122223333:function:todo--prod--worker',
    );
    expect(bySid.Secrets?.Resource).toContain(
      'arn:aws:ssm:us-east-1:111122223333:parameter/platform/apps/todo/_shared/secrets/*',
    );
  });

  it("can't create log groups, so none outlives a destroyed stage", () => {
    const boundary = policies.boundaryPolicy({ region: 'us-east-1', accountId: '1', storageBucket: 'st' });
    for (const d of [doc, boundary]) {
      expect(d.Statement.flatMap((s) => [s.Action].flat())).not.toContain('logs:CreateLogGroup');
    }
    expect(bySid.Logs?.Action).toEqual(['logs:CreateLogStream', 'logs:PutLogEvents']);
  });

  it('omits grants for features the app does not use', () => {
    const minimal = policies.stageRolePolicy({
      app: 'site',
      stage: 'pr-1',
      region: 'us-east-1',
      accountId: '1',
      manifest: parseManifest({ name: 'site', web: { static: 'dist' } }),
      platform: platform(),
    });
    const sids = minimal.Statement.map((s) => s.Sid);
    expect(sids).not.toContain('Db');
    expect(sids).not.toContain('Queues');
    expect(sids).not.toContain('StorageObjects');
    expect(sids).not.toContain('InvokeWorker');
  });

  it('trusts Lambda and Scheduler', () => {
    expect(policies.stageTrustPolicy().Statement[0]?.Principal).toEqual({
      Service: ['lambda.amazonaws.com', 'scheduler.amazonaws.com'],
    });
  });

  it('only lets the control plane create roles that carry the boundary', () => {
    const cp = policies.controlPlanePolicy({
      region: 'us-east-1',
      accountId: '1',
      runtime: { artifactsBucket: 'a', sitesBucket: 's', storageBucket: 'st', boundaryPolicyArn: 'arn:b' },
    });
    const create = cp.Statement.find((s) => s.Sid === 'StageRoles');
    expect(create?.Condition).toEqual({ StringEquals: { 'iam:PermissionsBoundary': 'arn:b' } });
    expect(create?.Resource).toBe('arn:aws:iam::1:role/platform/apps/*');
  });
});

describe('static assets', () => {
  it('caches hashed files forever and revalidates the rest', () => {
    expect(cacheControlFor('assets/index-BRmjjcSz.js')).toMatch(/immutable/);
    expect(cacheControlFor('/assets/logo.svg')).toMatch(/immutable/);
    expect(cacheControlFor('chunk.a1b2c3d4.css')).toMatch(/immutable/);
    expect(cacheControlFor('index.html')).toMatch(/must-revalidate/);
    expect(cacheControlFor('robots.txt')).toMatch(/must-revalidate/);
    expect(cacheControlFor('my-component.js')).toMatch(/must-revalidate/);
  });
  it('knows common content types', () => {
    expect(contentTypeFor('a/b/index.html')).toBe('text/html; charset=utf-8');
    expect(contentTypeFor('x.woff2')).toBe('font/woff2');
    expect(contentTypeFor('unknown.bin')).toBe('application/octet-stream');
  });
});

describe('misc', () => {
  it('fixes emulator epoch timestamps', () => {
    const fixed = JSON.parse(
      fixTimestamps('{"createdAt":1794686149,"nested":[{"updatedAt":1794686149000}],"n":5}'),
    );
    expect(fixed.createdAt).toBe('2026-11-14T19:55:49.000Z');
    expect(fixed.nested[0].updatedAt).toBe('2026-11-14T19:55:49.000Z');
    expect(fixed.n).toBe(5);
    expect(fixTimestamps('not json')).toBe('not json');
  });
  it('uses <app>.localhost for the local stage', () => {
    expect(hostFor(platform({ target: 'emulator', domain: 'localhost' }), 'todo', 'local')).toBe(
      'todo.localhost',
    );
    expect(hostFor(platform(), 'todo', 'prod')).toBe('todo.example.com');
    expect(hostFor(platform(), 'todo', 'pr-3')).toBe('todo--pr-3.example.com');
  });
  it('snaps log retention to allowed values', () => {
    expect(snapRetention(7)).toBe(7);
    expect(snapRetention(10)).toBe(14);
    expect(snapRetention(99999)).toBe(3653);
  });
});

describe('static garbage collection', () => {
  const p = (d: string) => `shop/prod/${d}/`;

  it('keeps the newest deployments and the new one', () => {
    const all = ['d1', 'd2', 'd3', 'd4', 'd5'].map(p);
    expect(staleStaticPrefixes(all, ['shop/prod/d5'])).toEqual([p('d2'), p('d1')]);
  });

  it('keeps the previously live deployment even when it is older', () => {
    // Rolled back to d1, then deployed d5: edges still on d1's route keep serving it.
    const all = ['d1', 'd2', 'd3', 'd4', 'd5'].map(p);
    expect(staleStaticPrefixes(all, ['shop/prod/d5', 'shop/prod/d1'])).toEqual([p('d2')]);
  });
});

/**
 * In-memory Web Function endpoints, resource policy, route store and sites
 * bucket behind fake clients. Records every command name sent.
 */
function fakeAws(
  opts: { endpoints?: Record<string, string>; route?: RouteRecord; staticFiles?: boolean } = {},
) {
  const calls: string[] = [];
  const endpoints = new Map<string, { revisionId: string }>(
    Object.entries(opts.endpoints ?? {}).map(([name, revisionId]) => [name, { revisionId }]),
  );
  const state = { route: opts.route, policy: undefined as string | undefined };
  const domain = (name: string) => `${name}.fn.example`;
  const arn = (name: string) => `arn:fn/shop--prod/endpoint/${name}`;
  const notFound = () => Object.assign(new Error('not found'), { name: 'ResourceNotFoundException' });
  type Input = {
    endpointName: string;
    revisionWeights: Array<{ revisionId: string }>;
    policy: string;
    Value: string;
  };
  const handlers: Record<string, (input: Input) => unknown> = {
    GetWebFunctionCommand: () => ({ functionArn: 'arn:fn/shop--prod' }),
    GetWebFunctionRevisionCommand: () => ({ state: 'Active' }),
    GetWebFunctionEndpointCommand: ({ endpointName }) => {
      const e = endpoints.get(endpointName);
      if (!e) throw notFound();
      return {
        endpointArn: arn(endpointName),
        domainName: domain(endpointName),
        state: 'Active',
        updateStatus: 'Successful',
        revisionWeights: [{ revisionId: e.revisionId, weight: 100 }],
      };
    },
    CreateWebFunctionEndpointCommand: ({ endpointName, revisionWeights }) => {
      endpoints.set(endpointName, { revisionId: revisionWeights[0]!.revisionId });
      return {};
    },
    UpdateWebFunctionEndpointCommand: ({ endpointName, revisionWeights }) => {
      endpoints.set(endpointName, { revisionId: revisionWeights[0]!.revisionId });
      return {};
    },
    GetResourcePolicyCommand: () => {
      if (!state.policy) throw notFound();
      return { policy: state.policy, revisionId: 'p1' };
    },
    PutResourcePolicyCommand: ({ policy }) => {
      state.policy = policy;
      return {};
    },
    ListObjectsV2Command: () => ({ KeyCount: opts.staticFiles === false ? 0 : 1 }),
    GetKeyCommand: () => {
      if (!state.route) throw notFound();
      return { Value: JSON.stringify(state.route) };
    },
    DescribeKeyValueStoreCommand: () => ({ ETag: 'e1' }),
    PutKeyCommand: ({ Value }) => {
      state.route = JSON.parse(Value);
      return {};
    },
  };
  const client = {
    send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
      const name = cmd.constructor.name;
      calls.push(name);
      const handler = handlers[name];
      if (!handler) throw new Error(`unexpected ${name}`);
      return handler(cmd.input as Input);
    },
  };
  const ctx = {
    clients: { s3: client, lambdaWeb: client, kvs: client },
    region: 'us-east-1',
    target: 'aws',
    log: () => {},
    accountId: async () => '111122223333',
  } as unknown as EngineContext;
  const pinned = () => Object.fromEntries([...endpoints].map(([n, e]) => [n, e.revisionId]));
  const routerArns = () =>
    (JSON.parse(state.policy ?? '{"Statement":[]}').Statement[0]?.Resource ?? []) as string[];
  return { ctx, calls, state, pinned, routerArns, domain };
}

const routeTo = (d: string, o?: string): RouteRecord => ({
  v: 1,
  app: 'shop',
  stage: 'prod',
  d,
  ...(o ? { o } : {}),
  s: `shop/prod/${d}`,
  r: ['/api/'],
  spa: 1,
});

describe('endpointForRevision', () => {
  const spec = (revisionId: string, liveDomain?: string) => ({
    functionName: 'shop--prod',
    functionArn: 'arn:fn/shop--prod',
    endpointNames: ['live', 'live-b'] as const,
    revisionId,
    distributionArn: 'arn:cloudfront::dist/E1',
    ...(liveDomain ? { liveDomain } : {}),
  });

  it('uses the endpoint a new function was created with for its first revision', async () => {
    const aws = fakeAws({ endpoints: { live: 'r1' } });
    const r = await endpointForRevision(aws.ctx, spec('r1'));
    expect(r).toEqual({ domainName: aws.domain('live'), pinned: ['r1'] });
    expect(aws.calls).not.toContain('UpdateWebFunctionEndpointCommand');
    expect(aws.routerArns()).toBe('arn:fn/shop--prod/endpoint/live');
  });

  it('puts a new revision on the endpoint the live route does not use', async () => {
    const aws = fakeAws({ endpoints: { live: 'r1' } });
    const r = await endpointForRevision(aws.ctx, spec('r2', aws.domain('live')));
    expect(r).toEqual({ domainName: aws.domain('live-b'), pinned: ['r1', 'r2'] });
    expect(aws.pinned()).toEqual({ live: 'r1', 'live-b': 'r2' });
    expect(aws.routerArns()).toEqual([
      'arn:fn/shop--prod/endpoint/live',
      'arn:fn/shop--prod/endpoint/live-b',
    ]);

    const next = await endpointForRevision(aws.ctx, spec('r3', aws.domain('live-b')));
    expect(next.domainName).toBe(aws.domain('live'));
    expect(aws.pinned()).toEqual({ live: 'r3', 'live-b': 'r2' });
  });
});

describe('rollbackStage', () => {
  const rollback = (aws: ReturnType<typeof fakeAws>, target: RouteRecord, revisionId: string) =>
    rollbackStage(aws.ctx, {
      app: 'shop',
      stage: 'prod',
      platform: platform({ kvsArn: 'arn:kvs/x', distributionArn: 'arn:cloudfront::dist/E1' }),
      route: target,
      revisionId,
    });

  it('only writes the route when an endpoint still serves the previous revision', async () => {
    const aws = fakeAws({
      endpoints: { live: 'r1', 'live-b': 'r2' },
      route: routeTo('d2', 'live-b.fn.example'),
    });
    // The target's recorded endpoint is stale on purpose: the engine finds the right one.
    const route = await rollback(aws, routeTo('d1', 'stale.fn.example'), 'r1');
    expect(route).toEqual(routeTo('d1', aws.domain('live')));
    expect(aws.state.route).toEqual(route);
    expect(aws.calls).not.toContain('UpdateWebFunctionEndpointCommand');
    expect(aws.calls).not.toContain('CreateWebFunctionEndpointCommand');
  });

  it('repoints the endpoint the live route does not use for an older revision', async () => {
    const aws = fakeAws({
      endpoints: { live: 'r2', 'live-b': 'r3' },
      route: routeTo('d3', 'live-b.fn.example'),
    });
    const route = await rollback(aws, routeTo('d1', 'live.fn.example'), 'r1');
    expect(aws.pinned()).toEqual({ live: 'r1', 'live-b': 'r3' });
    expect(route.o).toBe(aws.domain('live'));
  });

  it('migrates a stage that has only one endpoint', async () => {
    const aws = fakeAws({ endpoints: { live: 'r2' }, route: routeTo('d2', 'live.fn.example') });
    const route = await rollback(aws, routeTo('d1', 'live.fn.example'), 'r1');
    expect(aws.pinned()).toEqual({ live: 'r2', 'live-b': 'r1' });
    expect(route.o).toBe(aws.domain('live-b'));
  });

  it('refuses a deployment whose static files were cleaned up, before changing anything', async () => {
    const aws = fakeAws({ staticFiles: false, route: routeTo('d2', 'live.fn.example') });
    await expect(rollback(aws, routeTo('d1', 'live.fn.example'), 'r1')).rejects.toThrow(
      "deployment d1 can't be rolled back to: its static files have been cleaned up",
    );
    expect(aws.calls).toEqual(['ListObjectsV2Command']);
  });
});
