import type { ApiKey, ChannelNamespace } from '@aws-sdk/client-appsync';
import type { Tag } from '@aws-sdk/client-sesv2';
import {
  type PlatformRuntimeConfig,
  parseManifest,
  platformNames,
  REALTIME_KVS_KEY,
  type RouteRecord,
} from '@ericminassian/platform-core';
import { describe, expect, it } from 'vitest';
import { fixTimestamps } from '../src/compat.ts';
import {
  ensureChannelNamespace,
  ensurePublicApiKey,
  ensureRealtimePlatform,
  namespaceAuthModes,
} from '../src/drivers/appsync.ts';
import { snapRetention } from '../src/drivers/logs.ts';
import {
  deleteTenant,
  ensureConfigurationSet,
  ensureTenant,
  ensureTenantResources,
} from '../src/drivers/ses.ts';
import { endpointForRevision } from '../src/drivers/web-function.ts';
import { cacheControlFor, contentTypeFor, hostFor, policies, type ResourceRef } from '../src/index.ts';
import {
  deployStage,
  destroyStage,
  reconcileStageEmail,
  rollbackStage,
  staleStaticPrefixes,
} from '../src/stage.ts';
import type { EngineContext, EngineLog, PolicyDocument } from '../src/util.ts';

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

/** IAM wildcard match: `*` is any run, `?` one character. Actions match case-insensitively. */
const iamMatch = (pattern: string, value: string, flags = '') => {
  const literal = pattern.replaceAll(/[.+^${}()|[\]\\]/g, String.raw`\$&`);
  return new RegExp('^' + literal.replaceAll('*', '.*').replaceAll('?', '.') + '$', flags).test(value);
};

/** Whether an unconditional Allow in `doc` grants `action` on `resource`. */
const allows = (doc: PolicyDocument, action: string, resource: string) =>
  doc.Statement.some(
    (s) =>
      s.Effect === 'Allow' &&
      !s.Condition &&
      [s.Action].flat().some((a) => iamMatch(a, action, 'i')) &&
      [s.Resource ?? []].flat().some((r) => iamMatch(r, resource)),
  );

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
  const bySid = Object.fromEntries(doc.Statement.map((s) => [s.Sid ?? '', s] as const));

  it('scopes every grant to this stage', () => {
    expect(bySid.Db?.Resource).toEqual([
      'arn:aws:dynamodb:us-east-1:111122223333:table/todo--prod',
      'arn:aws:dynamodb:us-east-1:111122223333:table/todo--prod/index/*',
    ]);
    expect(bySid.Queues?.Resource).toBe('arn:aws:sqs:us-east-1:111122223333:todo--prod--*');
    expect(bySid.Events?.Resource).toBe('arn:aws:events:us-east-1:111122223333:event-bus/todo--prod');
    expect(bySid.StorageObjects?.Resource).toEqual(['arn:aws:s3:::store/todo/prod/*']);
    expect(bySid.StorageList?.Condition).toEqual({ StringLike: { 's3:prefix': ['todo/prod/*'] } });
    expect(bySid.InvokeWorker?.Resource).toBe(
      'arn:aws:lambda:us-east-1:111122223333:function:todo--prod--worker',
    );
    expect(bySid.Secrets?.Resource).toContain(
      'arn:aws:ssm:us-east-1:111122223333:parameter/platform/apps/todo/_shared/secrets/*',
    );
  });

  it('adds the public prefix only for public stores', () => {
    const files = policies.stageRolePolicy({
      app: 'atlas',
      stage: 'pr-3',
      region: 'us-east-1',
      accountId: '111122223333',
      manifest: parseManifest({ name: 'atlas', storage: { uploads: {}, snapshots: { public: true } } }),
      platform: platform(),
    });
    const sids = Object.fromEntries(files.Statement.map((s) => [s.Sid ?? '', s] as const));
    expect(sids.StorageObjects?.Resource).toEqual([
      'arn:aws:s3:::store/atlas/pr-3/*',
      'arn:aws:s3:::store/_public/atlas/pr-3/*',
    ]);
    expect(sids.StorageList?.Condition).toEqual({
      StringLike: { 's3:prefix': ['atlas/pr-3/*', '_public/atlas/pr-3/*'] },
    });
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

  it("lets the control plane read the edge floor's samples only when there is one", () => {
    const runtime = { artifactsBucket: 'a', sitesBucket: 's', storageBucket: 'st' };
    const acl = 'arn:aws:wafv2:us-east-1:1:global/webacl/platform-edge/abc';
    const with_ = policies.controlPlanePolicy({
      region: 'us-east-1',
      accountId: '1',
      runtime: { ...runtime, edgeWebAclArn: acl },
    });
    expect(allows(with_, 'wafv2:GetSampledRequests', acl)).toBe(true);
    expect(allows(with_, 'wafv2:UpdateWebACL', acl)).toBe(false);
    const without = policies.controlPlanePolicy({ region: 'us-east-1', accountId: '1', runtime });
    expect(without.Statement.some((st) => st.Sid === 'EdgeFloor')).toBe(false);
  });

  it('lets the control plane create tagged secrets, list and delete them', () => {
    const cp = policies.controlPlanePolicy({
      region: 'us-east-1',
      accountId: '1',
      runtime: { artifactsBucket: 'a', sitesBucket: 's', storageBucket: 'st' },
    });
    const secret = 'arn:aws:ssm:us-east-1:1:parameter/platform/apps/atlas/_shared/secrets/API_KEY';
    // PutParameter with Tags is authorized as both actions.
    for (const action of [
      'ssm:PutParameter',
      'ssm:AddTagsToResource',
      'ssm:GetParametersByPath',
      'ssm:DeleteParameter',
    ]) {
      expect(allows(cp, action, secret), action).toBe(true);
    }
    expect(allows(cp, 'ssm:AddTagsToResource', 'arn:aws:ssm:us-east-1:1:parameter/other/KEY')).toBe(false);
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
    ) as { createdAt: string; nested: [{ updatedAt: string }]; n: number };
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
      state.route = JSON.parse(Value) as RouteRecord;
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
    (JSON.parse(state.policy ?? '{"Statement":[]}') as { Statement: Array<{ Resource?: string | string[] }> })
      .Statement[0]?.Resource ?? [];
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

describe('realtime', () => {
  const rt = { apiId: 'api1', httpDomain: 'h.appsync.example', realtimeDomain: 'r.appsync.example' };
  const now = 1_800_000_000;
  const day = 86_400;

  /** AppSync API keys and namespaces, plus the route store, behind one fake client. */
  function fakeRealtime(
    opts: {
      keys?: ApiKey[];
      namespaces?: Record<string, ChannelNamespace>;
      quota?: boolean;
      kvs?: string;
    } = {},
  ) {
    const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
    const keys = [...(opts.keys ?? [])];
    const namespaces = new Map(Object.entries(opts.namespaces ?? {}));
    const state = { kvs: opts.kvs };
    const notFound = () => Object.assign(new Error('not found'), { name: 'NotFoundException' });
    const handlers: Record<string, (input: Record<string, unknown>) => unknown> = {
      ListApiKeysCommand: () => ({ apiKeys: keys }),
      CreateApiKeyCommand: (i) => {
        const key = {
          id: `da2-new${keys.length}`,
          description: i.description as string,
          expires: i.expires as number,
        };
        keys.push(key);
        return { apiKey: key };
      },
      UpdateApiKeyCommand: (i) => {
        const key = keys.find((k) => k.id === i.id)!;
        key.expires = i.expires as number;
        return { apiKey: key };
      },
      GetChannelNamespaceCommand: (i) => {
        const ns = namespaces.get(i.name as string);
        if (!ns) throw notFound();
        return { channelNamespace: ns };
      },
      CreateChannelNamespaceCommand: (i) => {
        if (opts.quota) throw Object.assign(new Error('quota'), { name: 'ServiceQuotaExceededException' });
        const ns = { ...i, channelNamespaceArn: `arn:ns/${i.name as string}` } as ChannelNamespace;
        namespaces.set(i.name as string, ns);
        return { channelNamespace: ns };
      },
      UpdateChannelNamespaceCommand: (i) => {
        namespaces.set(i.name as string, { ...namespaces.get(i.name as string), ...i });
        return {};
      },
      GetKeyCommand: () => {
        if (!state.kvs) throw notFound();
        return { Value: state.kvs };
      },
      DescribeKeyValueStoreCommand: () => ({ ETag: 'e1' }),
      PutKeyCommand: (i) => {
        state.kvs = i.Value as string;
        return {};
      },
    };
    const client = {
      send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
        calls.push({ name: cmd.constructor.name, input: cmd.input });
        const handler = handlers[cmd.constructor.name];
        if (!handler) throw new Error(`unexpected ${cmd.constructor.name}`);
        return handler(cmd.input);
      },
    };
    const ctx = {
      clients: { appsync: client, kvs: client },
      region: 'us-east-1',
      target: 'aws',
      log: () => {},
      accountId: async () => '111122223333',
    } as unknown as EngineContext;
    const sent = (name: string) => calls.filter((c) => c.name === name);
    return { ctx, sent, keys, namespaces, state };
  }

  const publicKey = (expires: number, id = 'da2-live'): ApiKey => ({
    id,
    description: platformNames.realtimePublicKey,
    expires,
  });

  describe('public subscribe key', () => {
    it('creates one valid for just under a year', async () => {
      const f = fakeRealtime();
      expect(await ensurePublicApiKey(f.ctx, 'api1', now)).toBe('da2-new0');
      expect(f.sent('CreateApiKeyCommand')[0]?.input).toEqual({
        apiId: 'api1',
        description: platformNames.realtimePublicKey,
        expires: now + 364 * day,
      });
    });

    it('leaves a key with most of its life alone', async () => {
      const f = fakeRealtime({ keys: [publicKey(now + 340 * day)] });
      expect(await ensurePublicApiKey(f.ctx, 'api1', now)).toBe('da2-live');
      expect(f.sent('UpdateApiKeyCommand')).toEqual([]);
      expect(f.sent('CreateApiKeyCommand')).toEqual([]);
    });

    it('extends the same key (same value) once under 335 days remain', async () => {
      const f = fakeRealtime({ keys: [publicKey(now + 300 * day)] });
      expect(await ensurePublicApiKey(f.ctx, 'api1', now)).toBe('da2-live');
      expect(f.keys[0]?.expires).toBe(now + 364 * day);
    });

    it('replaces an expired key and ignores keys it does not own', async () => {
      const f = fakeRealtime({
        keys: [
          publicKey(now - day, 'da2-old'),
          { id: 'da2-other', description: 'someone else', expires: now + 300 * day },
        ],
      });
      expect(await ensurePublicApiKey(f.ctx, 'api1', now)).toBe('da2-new2');
    });
  });

  describe('channel namespaces', () => {
    it('lets only IAM publish, and picks the subscribe mode', () => {
      expect(namespaceAuthModes('public')).toEqual({
        publishAuthModes: [{ authType: 'AWS_IAM' }],
        subscribeAuthModes: [{ authType: 'API_KEY' }],
      });
      expect(namespaceAuthModes('signed-in').subscribeAuthModes).toEqual([{ authType: 'AWS_LAMBDA' }]);
    });

    it('creates a namespace, then only updates it when the subscribe mode changes', async () => {
      const f = fakeRealtime();
      const spec = { apiId: 'api1', name: 'draw--prod', subscribe: 'public' as const, tags: { a: 'b' } };
      expect(await ensureChannelNamespace(f.ctx, spec)).toEqual({
        name: 'draw--prod',
        arn: 'arn:ns/draw--prod',
      });
      expect(f.sent('CreateChannelNamespaceCommand')[0]?.input.tags).toEqual({ a: 'b' });
      await ensureChannelNamespace(f.ctx, spec);
      expect(f.sent('UpdateChannelNamespaceCommand')).toEqual([]);
      await ensureChannelNamespace(f.ctx, { ...spec, subscribe: 'signed-in' });
      expect(f.sent('UpdateChannelNamespaceCommand')[0]?.input.subscribeAuthModes).toEqual([
        { authType: 'AWS_LAMBDA' },
      ]);
    });

    it('names the quota to raise when the API is full', async () => {
      const f = fakeRealtime({ quota: true });
      await expect(
        ensureChannelNamespace(f.ctx, { apiId: 'api1', name: 'x--pr-9', subscribe: 'public', tags: {} }),
      ).rejects.toThrow(/Channel namespaces per API.*default 50/s);
    });
  });

  describe('ensureRealtimePlatform', () => {
    it('does nothing on a platform without realtime', async () => {
      const f = fakeRealtime();
      expect(await ensureRealtimePlatform(f.ctx, platform())).toBeUndefined();
    });

    it('writes the router entry only when it changes', async () => {
      const f = fakeRealtime({ keys: [publicKey(now + 1000 * day)] });
      const p = platform({ realtime: rt, kvsArn: 'arn:kvs' });
      const entry = await ensureRealtimePlatform(f.ctx, p);
      expect(entry).toEqual({ v: 1, o: 'r.appsync.example', h: 'h.appsync.example', k: 'da2-live' });
      expect(JSON.parse(f.state.kvs!)).toEqual(entry);
      await ensureRealtimePlatform(f.ctx, p);
      expect(f.sent('PutKeyCommand')).toHaveLength(1);
      expect(f.sent('GetKeyCommand')[0]?.input.Key).toBe(REALTIME_KVS_KEY);
    });

    it('only reports the entry where there is no route store (plat dev)', async () => {
      const f = fakeRealtime({ keys: [publicKey(now + 1000 * day)] });
      expect((await ensureRealtimePlatform(f.ctx, platform({ realtime: rt })))?.k).toBe('da2-live');
      expect(f.sent('PutKeyCommand')).toEqual([]);
    });
  });

  describe('policies', () => {
    const manifest = parseManifest({
      name: 'draw',
      web: { server: 'src/server.ts' },
      realtime: { channels: { board: {} } },
    });
    const stagePolicy = (p: PlatformRuntimeConfig, m = manifest) =>
      policies.stageRolePolicy({
        app: 'draw',
        stage: 'pr-3',
        region: 'us-east-1',
        accountId: '1',
        manifest: m,
        platform: p,
      });

    it('lets a stage publish to its own namespace and nothing else', () => {
      const s = stagePolicy(platform({ realtime: rt })).Statement.find((x) => x.Sid === 'Realtime');
      expect(s).toEqual({
        Sid: 'Realtime',
        Effect: 'Allow',
        Action: 'appsync:EventPublish',
        Resource: 'arn:aws:appsync:us-east-1:1:apis/api1/channelNamespace/draw--pr-3',
      });
      expect(
        stagePolicy(
          platform({ realtime: rt }),
          parseManifest({ name: 'draw', web: { server: 'x' } }),
        ).Statement.map((x) => x.Sid),
      ).not.toContain('Realtime');
    });

    it('bounds publishing to stage namespaces and lets the control plane manage them', () => {
      const boundary = policies.boundaryPolicy({
        region: 'us-east-1',
        accountId: '1',
        storageBucket: 's',
        realtimeApiId: 'api1',
      });
      expect(boundary.Statement.find((x) => x.Sid === 'StageRealtime')?.Resource).toBe(
        'arn:aws:appsync:us-east-1:1:apis/api1/channelNamespace/*--*',
      );
      expect(
        policies
          .boundaryPolicy({ region: 'us-east-1', accountId: '1', storageBucket: 's' })
          .Statement.map((x) => x.Sid),
      ).not.toContain('StageRealtime');
      const cp = policies.controlPlanePolicy({
        region: 'us-east-1',
        accountId: '1',
        runtime: { artifactsBucket: 'a', sitesBucket: 's', storageBucket: 'st', realtime: { apiId: 'api1' } },
      });
      const manage = cp.Statement.find((x) => x.Sid === 'Realtime');
      expect(manage?.Resource).toEqual([
        'arn:aws:appsync:us-east-1:1:apis/api1',
        'arn:aws:appsync:us-east-1:1:apis/api1/*',
      ]);
      expect(manage?.Action).toContain('appsync:UpdateApiKey');
      expect(manage?.Action).not.toContain('appsync:EventPublish');
    });
  });

  describe('a store that changes visibility', () => {
    /** Answers the live route and whether a prefix has files; any other call fails. */
    const fake = (live: RouteRecord | undefined, filesUnder: string[]) => {
      const calls: Array<[string, Record<string, unknown>]> = [];
      const send = async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
        const name = cmd.constructor.name;
        calls.push([name, cmd.input]);
        if (name === 'GetKeyCommand') {
          if (!live) throw Object.assign(new Error('missing'), { name: 'ResourceNotFoundException' });
          return { Value: JSON.stringify(live) };
        }
        if (name === 'ListObjectsV2Command') {
          const prefix = String(cmd.input.Prefix);
          return { KeyCount: filesUnder.some((f) => f.startsWith(prefix)) ? 1 : 0 };
        }
        throw new Error(`stopped at ${name}`);
      };
      const ctx = {
        clients: new Proxy({}, { get: () => ({ send }) }),
        region: 'us-east-1',
        target: 'aws',
        log: () => {},
        accountId: async () => '1',
      } as unknown as EngineContext;
      return { ctx, calls };
    };
    const deploy = (ctx: EngineContext, storage: Record<string, { public?: boolean }>) =>
      deployStage(ctx, {
        manifest: parseManifest({ name: 'atlas', web: { static: 'dist' }, storage }),
        stage: 'prod',
        deploymentId: 'd2',
        platform: platform({ kvsArn: 'arn:kvs/x' }),
        artifacts: {},
      });
    const live = (p?: string[]): RouteRecord => ({
      v: 1,
      app: 'atlas',
      stage: 'prod',
      d: 'd1',
      s: 'atlas/prod/d1',
      ...(p ? { p } : {}),
    });

    it('is refused when it has private files, before anything changes', async () => {
      const aws = fake(live(), ['atlas/prod/snapshots/a.json']);
      await expect(deploy(aws.ctx, { snapshots: { public: true } })).rejects.toThrow(
        /store "snapshots" has files from when it was private, and a store with files can't become public/,
      );
      expect(aws.calls.map(([name]) => name)).toEqual(['GetKeyCommand', 'ListObjectsV2Command']);
      expect(aws.calls[1]?.[1]).toMatchObject({ Bucket: 'store', Prefix: 'atlas/prod/snapshots/' });
    });

    it('is refused when it has public files', async () => {
      const aws = fake(live(['snapshots']), ['_public/atlas/prod/snapshots/a.json']);
      await expect(deploy(aws.ctx, { snapshots: {} })).rejects.toThrow(/when it was public.*become private/);
    });

    it('goes ahead when the store has no files where it was', async () => {
      // Files of another store, and a store whose visibility doesn't change, don't matter.
      const aws = fake(live(['tiles']), ['atlas/prod/uploads/a.json', '_public/atlas/prod/tiles/t.png']);
      await expect(
        deploy(aws.ctx, { snapshots: { public: true }, tiles: { public: true }, uploads: {} }),
      ).rejects.toThrow(/stopped at/);
      expect(aws.calls.filter(([name]) => name === 'ListObjectsV2Command').map(([, i]) => i.Prefix)).toEqual([
        'atlas/prod/snapshots/',
      ]);
    });

    it('treats every store as private before the stage has a route', async () => {
      const aws = fake(undefined, ['atlas/prod/snapshots/a.json']);
      await expect(deploy(aws.ctx, { snapshots: { public: true } })).rejects.toThrow(/when it was private/);
    });
  });

  it('refuses a realtime app on a platform that predates realtime, before creating anything', async () => {
    const ctx = {
      clients: new Proxy(
        {},
        { get: () => ({ send: () => Promise.reject(new Error('no AWS calls expected')) }) },
      ),
      region: 'us-east-1',
      target: 'aws',
      log: () => {},
      accountId: async () => '1',
    } as unknown as EngineContext;
    await expect(
      deployStage(ctx, {
        manifest: parseManifest({
          name: 'draw',
          web: { static: 'dist' },
          realtime: { channels: { board: {} } },
        }),
        stage: 'prod',
        deploymentId: 'd1',
        platform: platform(),
        artifacts: {},
      }),
    ).rejects.toThrow(/no realtime API yet/);
  });
});

describe('email', () => {
  const acct = '111122223333';
  const mail = {
    domain: 'mail.example.com',
    identityArn: `arn:aws:ses:us-east-1:${acct}:identity/mail.example.com`,
  };
  const csArn = (name: string) => `arn:aws:ses:us-east-1:${acct}:configuration-set/${name}`;
  const tags = { 'platform:app': 'todo', 'platform:stage': 'prod' };
  const tagList = (t: Record<string, string>): Tag[] =>
    Object.entries(t).map(([Key, Value]) => ({ Key, Value }));

  interface FakeTenant {
    id: string;
    scope: 'ACCOUNT' | 'TENANT';
    reasons: string[];
    tags: Tag[];
    resources: string[];
  }

  /**
   * SES configuration sets, tenants and their associations behind one fake client. Other
   * services (destroy's other steps) report nothing left: lists are empty, everything else is
   * already gone.
   */
  function fakeSes(
    opts: {
      configurationSets?: Record<string, { metrics: boolean; tags: Tag[] }>;
      tenants?: Record<string, Partial<FakeTenant>>;
    } = {},
  ) {
    const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
    const logs: Array<{ level: string; msg: string }> = [];
    const configurationSets = new Map(Object.entries(opts.configurationSets ?? {}));
    let ids = 0;
    const tenant = (t: Partial<FakeTenant>): FakeTenant => ({
      id: `tn-${++ids}`,
      scope: 'ACCOUNT',
      reasons: [],
      tags: [],
      resources: [],
      ...t,
    });
    const tenants = new Map(Object.entries(opts.tenants ?? {}).map(([n, t]) => [n, tenant(t)]));
    const notFound = () => Object.assign(new Error('not found'), { name: 'NotFoundException' });
    const tenantOut = (name: string, t: FakeTenant) => ({
      TenantName: name,
      TenantId: t.id,
      TenantArn: `arn:aws:ses:us-east-1:${acct}:tenant/${name}/${t.id}`,
      Tags: t.tags,
      SuppressionAttributes: { SuppressionScope: t.scope, SuppressedReasons: t.reasons },
    });
    const get = (name: unknown) => {
      const t = tenants.get(name as string);
      if (!t) throw notFound();
      return t;
    };
    type In = Record<string, unknown>;
    const handlers: Record<string, (i: In) => unknown> = {
      GetConfigurationSetCommand: (i) => {
        const cs = configurationSets.get(i.ConfigurationSetName as string);
        if (!cs) throw notFound();
        return {
          ConfigurationSetName: i.ConfigurationSetName,
          ReputationOptions: { ReputationMetricsEnabled: cs.metrics },
          Tags: cs.tags,
        };
      },
      CreateConfigurationSetCommand: (i) => {
        configurationSets.set(i.ConfigurationSetName as string, {
          metrics: Boolean(
            (i.ReputationOptions as { ReputationMetricsEnabled?: boolean }).ReputationMetricsEnabled,
          ),
          tags: i.Tags as Tag[],
        });
        return {};
      },
      PutConfigurationSetReputationOptionsCommand: (i) => {
        configurationSets.get(i.ConfigurationSetName as string)!.metrics =
          i.ReputationMetricsEnabled as boolean;
        return {};
      },
      DeleteConfigurationSetCommand: (i) => {
        if (!configurationSets.delete(i.ConfigurationSetName as string)) throw notFound();
        return {};
      },
      GetTenantCommand: (i) => ({ Tenant: tenantOut(i.TenantName as string, get(i.TenantName)) }),
      CreateTenantCommand: (i) => {
        const s = i.SuppressionAttributes as { SuppressionScope: 'TENANT'; SuppressedReasons: string[] };
        const t = tenant({
          scope: s.SuppressionScope,
          reasons: [...s.SuppressedReasons],
          tags: i.Tags as Tag[],
        });
        tenants.set(i.TenantName as string, t);
        return tenantOut(i.TenantName as string, t);
      },
      PutTenantSuppressionAttributesCommand: (i) => {
        const t = get(i.TenantName);
        t.scope = i.SuppressionScope as 'TENANT';
        t.reasons = [...(i.SuppressedReasons as string[])];
        return {};
      },
      ListTenantResourcesCommand: (i) => ({
        TenantResources: get(i.TenantName).resources.map((ResourceArn) => ({ ResourceArn })),
      }),
      CreateTenantResourceAssociationCommand: (i) => {
        const t = get(i.TenantName);
        if (t.resources.includes(i.ResourceArn as string))
          throw Object.assign(new Error('already associated'), { name: 'AlreadyExistsException' });
        t.resources.push(i.ResourceArn as string);
        return {};
      },
      DeleteTenantResourceAssociationCommand: (i) => {
        const t = get(i.TenantName);
        t.resources = t.resources.filter((r) => r !== i.ResourceArn);
        return {};
      },
      DeleteTenantCommand: (i) => {
        get(i.TenantName);
        tenants.delete(i.TenantName as string);
        return {};
      },
      TagResourceCommand: (i) => {
        const arn = i.ResourceArn as string;
        const name = arn.split('/')[1]!;
        const target = arn.includes(':tenant/') ? get(name) : configurationSets.get(name)!;
        const added = i.Tags as Tag[];
        target.tags = [...target.tags.filter((t) => !added.some((a) => a.Key === t.Key)), ...added];
        return {};
      },
    };
    const client = {
      send: async (cmd: { constructor: { name: string }; input: In }) => {
        const name = cmd.constructor.name;
        calls.push({ name, input: cmd.input });
        const handler = handlers[name];
        if (handler) return handler(cmd.input);
        if (/^(List|DescribeLogGroups)/.test(name)) return {};
        throw notFound();
      },
    };
    const log: EngineLog = (level, msg) => logs.push({ level, msg });
    const ctx = {
      clients: new Proxy({}, { get: () => client }),
      region: 'us-east-1',
      target: 'aws',
      log,
      accountId: async () => acct,
    } as unknown as EngineContext;
    const sent = (name: string) => calls.filter((c) => c.name === name);
    const sesCalls = () => calls.filter((c) => c.name in handlers).map((c) => c.name);
    return { ctx, calls, sent, sesCalls, logs, configurationSets, tenants };
  }

  describe('policies', () => {
    const manifest = parseManifest({
      name: 'todo',
      web: { server: 'src/server.ts' },
      email: { name: 'Todo' },
    });
    const stagePolicy = (stage: string, p = platform({ email: mail }), m = manifest) =>
      policies.stageRolePolicy({
        app: 'todo',
        stage,
        region: 'us-east-1',
        accountId: acct,
        manifest: m,
        platform: p,
      });
    const sid = (doc: ReturnType<typeof stagePolicy>, id: string) => doc.Statement.find((s) => s.Sid === id);

    it('lets a stage send only from its address, as its tenant, through its configuration set', () => {
      expect(sid(stagePolicy('prod'), 'Email')).toEqual({
        Sid: 'Email',
        Effect: 'Allow',
        Action: 'ses:SendEmail',
        Resource: [mail.identityArn, csArn('todo--prod')],
        Condition: {
          StringEquals: {
            'ses:FromAddress': 'todo@mail.example.com',
            'ses:TenantName': 'todo--prod',
            'ses:ApiVersion': '2',
          },
        },
      });
      const preview = sid(stagePolicy('pr-3'), 'Email');
      expect(preview?.Resource).toEqual([mail.identityArn, csArn('todo--pr-3')]);
      expect(preview?.Condition?.StringEquals).toMatchObject({
        'ses:FromAddress': 'todo--pr-3@mail.example.com',
        'ses:TenantName': 'todo--pr-3',
      });
    });

    it("lets a stage count its own sends and no one else's", () => {
      expect(sid(stagePolicy('pr-3'), 'EmailUsage')).toEqual({
        Sid: 'EmailUsage',
        Effect: 'Allow',
        Action: 'dynamodb:UpdateItem',
        Resource: `arn:aws:dynamodb:us-east-1:${acct}:table/platform-telemetry`,
        Condition: { 'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': ['mail#todo#pr-3'] } },
      });
    });

    it('grants nothing for email unless the app declares it and the platform has a mail domain', () => {
      const without = parseManifest({ name: 'todo', web: { server: 'src/server.ts' } });
      for (const doc of [
        stagePolicy('prod', platform({ email: mail }), without),
        stagePolicy('prod', platform()),
      ]) {
        const sids = doc.Statement.map((s) => s.Sid);
        expect(sids).not.toContain('Email');
        expect(sids).not.toContain('EmailUsage');
      }
    });

    it('bounds stage roles to sending as a stage tenant and to usage rows', () => {
      const boundary = policies.boundaryPolicy({
        region: 'us-east-1',
        accountId: acct,
        storageBucket: 's',
        email: { identityArn: mail.identityArn, usageTable: 'platform-telemetry' },
      });
      expect(boundary.Statement.filter((s) => s.Sid?.startsWith('StageEmail'))).toEqual([
        {
          Sid: 'StageEmail',
          Effect: 'Allow',
          Action: 'ses:SendEmail',
          Resource: [mail.identityArn, csArn('*--*')],
          Condition: { StringLike: { 'ses:TenantName': '*--*' } },
        },
        {
          Sid: 'StageEmailUsage',
          Effect: 'Allow',
          Action: 'dynamodb:UpdateItem',
          Resource: `arn:aws:dynamodb:us-east-1:${acct}:table/platform-telemetry`,
          Condition: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['mail#*#*'] } },
        },
      ]);
      // Every stage's grant fits inside the boundary's patterns.
      expect(sid(stagePolicy('pr-3'), 'Email')?.Condition?.StringEquals?.['ses:TenantName']).toMatch(
        /^.+--.+$/,
      );
      expect(
        policies
          .boundaryPolicy({ region: 'us-east-1', accountId: acct, storageBucket: 's' })
          .Statement.map((s) => s.Sid),
      ).not.toContain('StageEmail');
    });

    it('lets the control plane manage stage tenants but never send', () => {
      const runtime = { artifactsBucket: 'a', sitesBucket: 's', storageBucket: 'st' };
      const cp = policies.controlPlanePolicy({
        region: 'us-east-1',
        accountId: acct,
        runtime: { ...runtime, email: { identityArn: mail.identityArn } },
      });
      const manage = cp.Statement.find((s) => s.Sid === 'Email');
      expect(manage?.Resource).toEqual([
        `arn:aws:ses:us-east-1:${acct}:tenant/*--*`,
        `arn:aws:ses:us-east-1:${acct}:configuration-set/*--*`,
      ]);
      expect(manage?.Action).toEqual(
        expect.arrayContaining([
          'ses:CreateTenant',
          'ses:DeleteTenant',
          'ses:PutTenantSuppressionAttributes',
          'ses:ListTenantResources',
          'ses:CreateConfigurationSet',
          'ses:DeleteConfigurationSet',
          'ses:GetReputationEntity',
          'ses:UpdateReputationEntityCustomerManagedStatus',
          'ses:ListSuppressedDestinations',
          'ses:DeleteSuppressedDestination',
        ]),
      );
      expect(cp.Statement.find((s) => s.Sid === 'EmailDomain')).toEqual({
        Sid: 'EmailDomain',
        Effect: 'Allow',
        Action: ['ses:CreateTenantResourceAssociation', 'ses:DeleteTenantResourceAssociation'],
        Resource: mail.identityArn,
      });
      const actions = cp.Statement.flatMap((s) => [s.Action].flat());
      expect(actions.filter((a) => a.startsWith('ses:Send'))).toEqual([]);
      expect(actions.filter((a) => a.startsWith('ses:') && a.endsWith('*'))).toEqual([]);
      expect(
        policies
          .controlPlanePolicy({ region: 'us-east-1', accountId: acct, runtime })
          .Statement.map((s) => s.Sid),
      ).not.toContain('Email');
    });
  });

  describe('drivers', () => {
    it('creates a configuration set with reputation metrics, then leaves it alone', async () => {
      const f = fakeSes();
      expect(await ensureConfigurationSet(f.ctx, { name: 'todo--prod', tags })).toEqual({
        name: 'todo--prod',
        arn: csArn('todo--prod'),
      });
      expect(f.sent('CreateConfigurationSetCommand')[0]?.input).toEqual({
        ConfigurationSetName: 'todo--prod',
        ReputationOptions: { ReputationMetricsEnabled: true },
        Tags: tagList(tags),
      });
      await ensureConfigurationSet(f.ctx, { name: 'todo--prod', tags });
      expect(f.sesCalls()).toEqual([
        'GetConfigurationSetCommand',
        'CreateConfigurationSetCommand',
        'GetConfigurationSetCommand',
      ]);
    });

    it('turns metrics back on and restores missing tags on an existing set', async () => {
      const f = fakeSes({
        configurationSets: { 'todo--prod': { metrics: false, tags: [{ Key: 'x', Value: '1' }] } },
      });
      await ensureConfigurationSet(f.ctx, { name: 'todo--prod', tags });
      expect(f.configurationSets.get('todo--prod')).toEqual({
        metrics: true,
        tags: [{ Key: 'x', Value: '1' }, ...tagList(tags)],
      });
      expect(f.sent('CreateConfigurationSetCommand')).toEqual([]);
    });

    it('creates a tenant on its own suppression list', async () => {
      const f = fakeSes();
      const t = await ensureTenant(f.ctx, { name: 'todo--prod', tags });
      expect(t).toEqual({
        name: 'todo--prod',
        id: 'tn-1',
        arn: `arn:aws:ses:us-east-1:${acct}:tenant/todo--prod/tn-1`,
      });
      expect(f.sent('CreateTenantCommand')[0]?.input).toEqual({
        TenantName: 'todo--prod',
        Tags: tagList(tags),
        SuppressionAttributes: { SuppressedReasons: ['BOUNCE', 'COMPLAINT'], SuppressionScope: 'TENANT' },
      });
      await ensureTenant(f.ctx, { name: 'todo--prod', tags });
      expect(f.sesCalls()).toEqual(['GetTenantCommand', 'CreateTenantCommand', 'GetTenantCommand']);
    });

    it('moves an existing tenant off the account list in place (same id, same history)', async () => {
      const f = fakeSes({ tenants: { 'todo--prod': { tags: tagList(tags) } } });
      const t = await ensureTenant(f.ctx, { name: 'todo--prod', tags });
      expect(t.id).toBe('tn-1');
      expect(f.tenants.get('todo--prod')).toMatchObject({
        scope: 'TENANT',
        reasons: ['BOUNCE', 'COMPLAINT'],
      });
      expect(f.sesCalls()).toEqual(['GetTenantCommand', 'PutTenantSuppressionAttributesCommand']);
    });

    it('associates the domain and the configuration set once, and drops strays', async () => {
      const stray = `arn:aws:ses:us-east-1:${acct}:identity/mail.old.example.com`;
      const f = fakeSes({ tenants: { 'todo--prod': { resources: [stray] } } });
      const wanted = [mail.identityArn, csArn('todo--prod')];
      await ensureTenantResources(f.ctx, 'todo--prod', wanted);
      expect(f.tenants.get('todo--prod')?.resources).toEqual(wanted);
      await ensureTenantResources(f.ctx, 'todo--prod', wanted);
      expect(f.sent('CreateTenantResourceAssociationCommand')).toHaveLength(2);
      expect(f.sent('DeleteTenantResourceAssociationCommand').map((c) => c.input.ResourceArn)).toEqual([
        stray,
      ]);
    });

    it("removes a tenant's associations before the tenant, and tolerates a missing one", async () => {
      const f = fakeSes({
        tenants: { 'todo--prod': { resources: [mail.identityArn, csArn('todo--prod')] } },
      });
      expect(await deleteTenant(f.ctx, 'todo--prod')).toBe(true);
      expect(f.sesCalls()).toEqual([
        'ListTenantResourcesCommand',
        'DeleteTenantResourceAssociationCommand',
        'DeleteTenantResourceAssociationCommand',
        'DeleteTenantCommand',
      ]);
      expect(await deleteTenant(f.ctx, 'todo--prod')).toBe(false);
    });
  });

  describe('stages', () => {
    const reconcile = (
      f: ReturnType<typeof fakeSes>,
      over: { stage?: string; email?: unknown; platform?: PlatformRuntimeConfig } = {},
    ) => {
      const resources: ResourceRef[] = [];
      const stage = over.stage ?? 'prod';
      const manifest = parseManifest({
        name: 'todo',
        web: { server: 'src/server.ts' },
        ...(over.email === undefined ? { email: { name: 'Todo', dailyLimit: 500 } } : { email: over.email }),
      });
      return reconcileStageEmail(f.ctx, {
        app: 'todo',
        stage,
        manifest,
        platform: over.platform ?? platform({ email: mail }),
        tags,
        resources,
      }).then((bindings) => ({ bindings, resources }));
    };

    it('binds a prod stage to its tenant, address and declared limit', async () => {
      const f = fakeSes();
      const { bindings, resources } = await reconcile(f);
      expect(bindings).toEqual({
        mode: 'ses',
        from: 'todo@mail.example.com',
        name: 'Todo',
        tenant: 'todo--prod',
        dailyLimit: 500,
        usageTable: 'platform-telemetry',
      });
      expect(f.tenants.get('todo--prod')).toMatchObject({
        scope: 'TENANT',
        resources: [mail.identityArn, csArn('todo--prod')],
      });
      expect(f.configurationSets.get('todo--prod')?.metrics).toBe(true);
      expect(resources.map((r) => `${r.type}:${r.name}`)).toEqual([
        'email-tenant:todo--prod',
        'configuration-set:todo--prod',
      ]);
      // Tenant, then configuration set, each ready before the association that names it.
      expect(f.sesCalls().indexOf('CreateTenantResourceAssociationCommand')).toBeGreaterThan(
        f.sesCalls().indexOf('CreateTenantCommand'),
      );
    });

    it('caps previews, defaults the limit, and keeps mail local in the emulator', async () => {
      const preview = await reconcile(fakeSes(), { stage: 'pr-3' });
      expect(preview.bindings).toMatchObject({
        from: 'todo--pr-3@mail.example.com',
        tenant: 'todo--pr-3',
        dailyLimit: 50,
      });
      const local = await reconcile(fakeSes(), {
        stage: 'local',
        email: true,
        platform: platform({ target: 'emulator', email: { ...mail, domain: 'mail.localhost' } }),
      });
      expect(local.bindings).toEqual({
        mode: 'local',
        from: 'todo--local@mail.localhost',
        tenant: 'todo--local',
        dailyLimit: 50,
        usageTable: 'platform-telemetry',
      });
      const prod = await reconcile(fakeSes(), { email: true });
      expect(prod.bindings?.dailyLimit).toBe(200);
      expect(prod.bindings).not.toHaveProperty('name');
    });

    it('keeps the tenant and its configuration set when email leaves the config', async () => {
      const f = fakeSes({
        configurationSets: { 'todo--prod': { metrics: true, tags: [] } },
        tenants: { 'todo--prod': { scope: 'TENANT', resources: [mail.identityArn, csArn('todo--prod')] } },
      });
      const { bindings, resources } = await reconcile(f, { email: false });
      expect(bindings).toBeUndefined();
      expect(resources).toEqual([]);
      expect(f.sesCalls()).toEqual(['GetTenantCommand']);
      expect(f.logs).toContainEqual({ level: 'warn', msg: expect.stringMatching(/keeping it/) as unknown });
      // Nothing to warn about for an app that never sent.
      const fresh = fakeSes();
      await reconcile(fresh, { email: false });
      expect(fresh.logs).toEqual([]);
    });

    it('leaves SES alone on a platform without a mail domain', async () => {
      const f = fakeSes();
      expect((await reconcile(f, { email: false, platform: platform() })).bindings).toBeUndefined();
      expect(f.calls).toEqual([]);
    });

    it('refuses an email app on a platform that predates email, before creating anything', async () => {
      const f = fakeSes();
      await expect(
        deployStage(f.ctx, {
          manifest: parseManifest({ name: 'todo', web: { static: 'dist' }, email: true }),
          stage: 'prod',
          deploymentId: 'd1',
          platform: platform(),
          artifacts: {},
        }),
      ).rejects.toThrow(/no mail domain yet.*deploy the platform's foundation first/);
      expect(f.calls).toEqual([]);
    });

    it('deletes the tenant (associations first) and the configuration set with the stage', async () => {
      const f = fakeSes({
        configurationSets: { 'todo--pr-3': { metrics: true, tags: [] } },
        tenants: { 'todo--pr-3': { scope: 'TENANT', resources: [mail.identityArn, csArn('todo--pr-3')] } },
      });
      await destroyStage(f.ctx, { app: 'todo', stage: 'pr-3', platform: platform({ email: mail }) });
      expect(f.tenants.size).toBe(0);
      expect(f.configurationSets.size).toBe(0);
      expect(f.sesCalls()).toEqual([
        'ListTenantResourcesCommand',
        'DeleteTenantResourceAssociationCommand',
        'DeleteTenantResourceAssociationCommand',
        'DeleteTenantCommand',
        'DeleteConfigurationSetCommand',
      ]);
    });
  });
});
