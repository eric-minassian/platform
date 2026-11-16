import type { PlatformRuntimeConfig, RouteRecord } from '@ericminassian/platform-core';
import { describe, expect, it } from 'vitest';
import {
  aliasForVersion,
  functionUrlDomain,
  publishRequestFunction,
  pruneVersions,
} from '../src/drivers/request-function.ts';
import { createRevision, ensureEndpoint } from '../src/drivers/web-function.ts';
import { rollbackStage } from '../src/stage.ts';
import type { EngineContext } from '../src/util.ts';

const FUNCTION = 'shop--prod--web';
const ALIASES = ['live', 'live-b'] as const;
const domain = (alias: string) => `${alias}-url.lambda-url.us-east-1.on.aws`;

type Input = Record<string, unknown> & {
  FunctionName?: string;
  Qualifier?: string;
  Name?: string;
  FunctionVersion?: string;
  StatementId?: string;
  Value?: string;
};

/**
 * An in-memory request-mode function (versions, aliases, URLs and their
 * policies) with a route store and sites bucket, behind fake clients.
 * Records every command sent.
 */
function fakeAws(
  opts: {
    versions?: string[];
    aliases?: Record<string, string>;
    route?: RouteRecord;
    staticFiles?: boolean;
  } = {},
) {
  const calls: Array<{ name: string; input: Input }> = [];
  const notFound = () => Object.assign(new Error('not found'), { name: 'ResourceNotFoundException' });
  const state = {
    exists: opts.versions !== undefined,
    versions: [...(opts.versions ?? [])],
    aliases: new Map(Object.entries(opts.aliases ?? {})),
    urls: new Set(Object.keys(opts.aliases ?? {})),
    policies: new Map<string, Array<Record<string, unknown>>>(),
    route: opts.route,
  };
  const arn = `arn:aws:lambda:us-east-1:111122223333:function:${FUNCTION}`;
  const handlers: Record<string, (input: Input) => unknown> = {
    GetFunctionConfigurationCommand: ({ Qualifier }) => {
      if (!state.exists || (Qualifier && !state.versions.includes(Qualifier))) throw notFound();
      return { FunctionArn: arn, State: 'Active', LastUpdateStatus: 'Successful' };
    },
    CreateFunctionCommand: () => {
      state.exists = true;
      return { FunctionArn: arn };
    },
    UpdateFunctionCodeCommand: () => ({}),
    UpdateFunctionConfigurationCommand: () => ({}),
    TagResourceCommand: () => ({}),
    PublishVersionCommand: () => {
      const v = String(Math.max(0, ...state.versions.map(Number)) + 1);
      state.versions.push(v);
      return { Version: v };
    },
    GetAliasCommand: ({ Name }) => {
      const v = state.aliases.get(Name!);
      if (!v) throw notFound();
      return { FunctionVersion: v };
    },
    CreateAliasCommand: ({ Name, FunctionVersion }) => state.aliases.set(Name!, FunctionVersion!),
    UpdateAliasCommand: ({ Name, FunctionVersion }) => state.aliases.set(Name!, FunctionVersion!),
    GetFunctionUrlConfigCommand: ({ Qualifier }) => {
      if (!state.urls.has(Qualifier!)) throw notFound();
      return {
        FunctionUrl: `https://${domain(Qualifier!)}/`,
        AuthType: 'NONE',
        InvokeMode: 'RESPONSE_STREAM',
      };
    },
    CreateFunctionUrlConfigCommand: ({ Qualifier }) => {
      state.urls.add(Qualifier!);
      return { FunctionUrl: `https://${domain(Qualifier!)}/` };
    },
    GetPolicyCommand: ({ Qualifier }) => {
      const statements = state.policies.get(Qualifier!);
      if (!statements) throw notFound();
      return { Policy: JSON.stringify({ Statement: statements }) };
    },
    AddPermissionCommand: (input) => {
      const list = state.policies.get(input.Qualifier!) ?? [];
      list.push({ Sid: input.StatementId, ...input });
      state.policies.set(input.Qualifier!, list);
      return {};
    },
    ListVersionsByFunctionCommand: () => ({
      Versions: [{ Version: '$LATEST' }, ...state.versions.map((Version) => ({ Version }))],
    }),
    DeleteFunctionCommand: ({ Qualifier }) => {
      if ([...state.aliases.values()].includes(Qualifier!))
        throw Object.assign(new Error('in use'), { name: 'ResourceConflictException' });
      state.versions = state.versions.filter((v) => v !== Qualifier);
      return {};
    },
    ListObjectsV2Command: () => ({ KeyCount: opts.staticFiles === false ? 0 : 1 }),
    GetKeyCommand: () => {
      if (!state.route) throw notFound();
      return { Value: JSON.stringify(state.route) };
    },
    DescribeKeyValueStoreCommand: () => ({ ETag: 'e1' }),
    PutKeyCommand: ({ Value }) => {
      state.route = JSON.parse(Value!) as RouteRecord;
      return {};
    },
  };
  const client = {
    send: async (cmd: { constructor: { name: string }; input: Input }) => {
      const name = cmd.constructor.name;
      calls.push({ name, input: cmd.input });
      const handler = handlers[name];
      if (!handler) throw new Error(`unexpected ${name}`);
      return handler(cmd.input);
    },
  };
  const ctx = {
    clients: { lambda: client, s3: client, kvs: client },
    region: 'us-east-1',
    target: 'aws',
    log: () => {},
    accountId: async () => '111122223333',
  } as unknown as EngineContext;
  const sent = (name: string) => calls.filter((c) => c.name === name).map((c) => c.input);
  const pinned = () => Object.fromEntries(state.aliases);
  return { ctx, calls, sent, state, pinned };
}

const spec = {
  name: FUNCTION,
  roleArn: 'arn:aws:iam::111122223333:role/platform/apps/shop--prod',
  code: { bucket: 'artifacts', key: 'shop/prod/d1/server.zip' },
  env: { PLATFORM_BINDINGS: '{}' },
  memoryMb: 1024,
  timeoutSeconds: 30,
  logGroup: '/platform/apps/shop/prod/web',
  deploymentId: 'd1',
  description: 'shop/prod server (d1)',
};

describe('publishRequestFunction', () => {
  it('creates an arm64 handler function with quiet JSON logs, then publishes the deployment as a version', async () => {
    const aws = fakeAws();
    expect(await publishRequestFunction(aws.ctx, spec)).toMatchObject({ version: '1' });
    expect(aws.sent('CreateFunctionCommand')[0]).toMatchObject({
      FunctionName: FUNCTION,
      Handler: 'index.handler',
      Runtime: 'nodejs24.x',
      Architectures: ['arm64'],
      MemorySize: 1024,
      LoggingConfig: { LogFormat: 'JSON', SystemLogLevel: 'WARN', LogGroup: '/platform/apps/shop/prod/web' },
    });
    expect(aws.sent('PublishVersionCommand')).toEqual([{ FunctionName: FUNCTION, Description: 'd1' }]);
  });

  it('updates code and settings of an existing function before publishing', async () => {
    const aws = fakeAws({ versions: ['1'] });
    expect(await publishRequestFunction(aws.ctx, { ...spec, deploymentId: 'd2' })).toMatchObject({
      version: '2',
    });
    const order = aws.calls.map((c) => c.name).filter((n) => /Update|Publish|Create/.test(n));
    expect(order).toEqual([
      'UpdateFunctionCodeCommand',
      'UpdateFunctionConfigurationCommand',
      'PublishVersionCommand',
    ]);
  });
});

describe('aliasForVersion', () => {
  const put = (aws: ReturnType<typeof fakeAws>, version: string, liveDomain?: string) =>
    aliasForVersion(aws.ctx, {
      functionName: FUNCTION,
      aliasNames: ALIASES,
      version,
      ...(liveDomain ? { liveDomain } : {}),
    });

  it('gives a first version an alias with a public, streaming function URL', async () => {
    const aws = fakeAws({ versions: ['1'] });
    expect(await put(aws, '1')).toEqual({ domainName: domain('live'), pinned: ['1'] });
    expect(aws.sent('CreateFunctionUrlConfigCommand')).toEqual([
      { FunctionName: FUNCTION, Qualifier: 'live', AuthType: 'NONE', InvokeMode: 'RESPONSE_STREAM' },
    ]);
    // Both grants a URL without IAM auth needs, on the alias.
    expect(aws.sent('AddPermissionCommand')).toEqual([
      {
        FunctionName: FUNCTION,
        Qualifier: 'live',
        Principal: '*',
        StatementId: 'FunctionUrlPublic',
        Action: 'lambda:InvokeFunctionUrl',
        FunctionUrlAuthType: 'NONE',
      },
      {
        FunctionName: FUNCTION,
        Qualifier: 'live',
        Principal: '*',
        StatementId: 'FunctionUrlInvoke',
        Action: 'lambda:InvokeFunction',
        InvokedViaFunctionUrl: true,
      },
    ]);
  });

  it('puts each new version on the alias the live route does not use', async () => {
    const aws = fakeAws({ versions: ['1', '2'], aliases: { live: '1' } });
    expect(await put(aws, '2', domain('live'))).toEqual({ domainName: domain('live-b'), pinned: ['1', '2'] });
    expect(aws.pinned()).toEqual({ live: '1', 'live-b': '2' });

    aws.state.versions.push('3');
    expect((await put(aws, '3', domain('live-b'))).domainName).toBe(domain('live'));
    expect(aws.pinned()).toEqual({ live: '3', 'live-b': '2' });
    // An alias that already has its URL and grants keeps them.
    expect(aws.sent('CreateFunctionUrlConfigCommand').map((i) => i.Qualifier)).toEqual(['live-b']);
    expect(aws.sent('AddPermissionCommand').map((i) => i.Qualifier)).toEqual([
      'live-b',
      'live-b',
      'live',
      'live',
    ]);
  });

  it('reads the route’s domain out of a function URL', () => {
    expect(functionUrlDomain('https://abc.lambda-url.us-east-1.on.aws/')).toBe(
      'abc.lambda-url.us-east-1.on.aws',
    );
  });
});

describe('pruneVersions', () => {
  it('keeps the newest versions and every one an alias points at', async () => {
    const aws = fakeAws({ versions: ['1', '2', '3', '4', '5', '6'], aliases: { live: '6', 'live-b': '2' } });
    await pruneVersions(aws.ctx, FUNCTION, { keepNewest: 3, keep: ['6', '2'] });
    expect(aws.state.versions).toEqual(['2', '4', '5', '6']);
  });
});

describe('rollbackStage in request mode', () => {
  const routeTo = (d: string, alias: string): RouteRecord => ({
    v: 1,
    app: 'shop',
    stage: 'prod',
    d,
    o: domain(alias),
    c: 'r',
    k: 'secret',
    s: `shop/prod/${d}`,
    r: ['/api/'],
    spa: 1,
  });
  const platform: PlatformRuntimeConfig = {
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
    kvsArn: 'arn:kvs/x',
  };
  const rollback = (aws: ReturnType<typeof fakeAws>, route: RouteRecord, version?: string) =>
    rollbackStage(aws.ctx, { app: 'shop', stage: 'prod', platform, route, ...(version ? { version } : {}) });

  it('only writes the route when an alias still serves the previous version', async () => {
    const aws = fakeAws({
      versions: ['1', '2'],
      aliases: { live: '1', 'live-b': '2' },
      route: routeTo('d2', 'live-b'),
    });
    const route = await rollback(aws, routeTo('d1', 'stale'), '1');
    expect(route).toEqual(routeTo('d1', 'live'));
    expect(aws.state.route).toEqual(route);
    expect(aws.sent('UpdateAliasCommand')).toEqual([]);
  });

  it('repoints the alias the live route does not use for an older version', async () => {
    const aws = fakeAws({
      versions: ['1', '2', '3'],
      aliases: { live: '2', 'live-b': '3' },
      route: routeTo('d3', 'live-b'),
    });
    const route = await rollback(aws, routeTo('d1', 'live'), '1');
    expect(aws.pinned()).toEqual({ live: '1', 'live-b': '3' });
    expect(route.o).toBe(domain('live'));
  });

  it('refuses a deployment whose version was cleaned up, before changing anything', async () => {
    const aws = fakeAws({ versions: ['4', '5'], aliases: { live: '5' }, route: routeTo('d5', 'live') });
    await expect(rollback(aws, routeTo('d1', 'live'), '1')).rejects.toThrow(
      "deployment d1 can't be rolled back to: its server version has been cleaned up",
    );
    await expect(rollback(aws, routeTo('d1', 'live'))).rejects.toThrow('its server version was not recorded');
    expect(aws.sent('PutKeyCommand')).toEqual([]);
    expect(aws.sent('UpdateAliasCommand')).toEqual([]);
  });
});

describe('Web Functions', () => {
  /** One Web Function endpoint and revision behind a fake client. */
  function fakeWeb(endpoint?: { revisionId: string; maxEnvironments?: number }) {
    const sent: Array<{ name: string; input: Record<string, unknown> }> = [];
    let current = endpoint;
    const client = {
      send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
        const name = cmd.constructor.name;
        sent.push({ name, input: cmd.input });
        switch (name) {
          case 'GetWebFunctionEndpointCommand':
            if (!current) throw Object.assign(new Error('not found'), { name: 'ResourceNotFoundException' });
            return {
              endpointArn: 'arn:endpoint/live',
              domainName: 'live.fn.example',
              state: 'Active',
              updateStatus: 'Successful',
              revisionWeights: [{ revisionId: current.revisionId, weight: 100 }],
              ...(current.maxEnvironments
                ? { scalingConfig: { maxEnvironments: current.maxEnvironments } }
                : {}),
            };
          case 'CreateWebFunctionEndpointCommand':
          case 'UpdateWebFunctionEndpointCommand': {
            const weights = cmd.input.revisionWeights as Array<{ revisionId: string }>;
            const scaling = cmd.input.scalingConfig as { maxEnvironments?: number } | undefined;
            current = {
              revisionId: weights[0]!.revisionId,
              ...(scaling?.maxEnvironments ? { maxEnvironments: scaling.maxEnvironments } : {}),
            };
            return {};
          }
          case 'CreateWebFunctionRevisionCommand':
            return { revisionId: 'r2' };
          case 'GetWebFunctionRevisionCommand':
            return { state: 'Active' };
          default:
            throw new Error(`unexpected ${name}`);
        }
      },
    };
    const ctx = {
      clients: { lambdaWeb: client },
      region: 'us-east-1',
      target: 'aws',
      log: () => {},
    } as unknown as EngineContext;
    return { ctx, sent, endpoint: () => current };
  }

  it('caps an endpoint’s environments, and changes a cap that differs', async () => {
    const created = fakeWeb();
    await ensureEndpoint(created.ctx, {
      functionName: 'shop--prod',
      endpointName: 'live',
      revisionId: 'r1',
      maxEnvironments: 10,
    });
    expect(created.sent.find((c) => c.name === 'CreateWebFunctionEndpointCommand')?.input).toMatchObject({
      scalingConfig: { maxEnvironments: 10 },
    });

    const capped = fakeWeb({ revisionId: 'r1', maxEnvironments: 10 });
    await ensureEndpoint(capped.ctx, {
      functionName: 'shop--prod',
      endpointName: 'live',
      revisionId: 'r1',
      maxEnvironments: 10,
    });
    expect(capped.sent.map((c) => c.name)).not.toContain('UpdateWebFunctionEndpointCommand');
    await ensureEndpoint(capped.ctx, {
      functionName: 'shop--prod',
      endpointName: 'live',
      revisionId: 'r1',
      maxEnvironments: 2,
    });
    expect(capped.endpoint()).toEqual({ revisionId: 'r1', maxEnvironments: 2 });
  });

  it('logs only the runtime’s warnings', async () => {
    const web = fakeWeb();
    await createRevision(web.ctx, {
      functionName: 'shop--prod',
      code: { bucket: 'a', key: 'k' },
      runtime: 'nodejs24.x',
      roleArn: 'arn:role',
      env: {},
      timeoutSeconds: 30,
      maxConcurrency: 64,
      logGroup: '/platform/apps/shop/prod/web',
    });
    expect(web.sent.find((c) => c.name === 'CreateWebFunctionRevisionCommand')?.input).toMatchObject({
      serviceConfig: {
        telemetryConfig: {
          loggingConfig: { logGroup: '/platform/apps/shop/prod/web', systemLogLevel: 'WARN' },
        },
      },
    });
  });
});
