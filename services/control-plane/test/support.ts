/**
 * Test doubles for the control plane: settings for a test platform, an
 * in-memory `Store` that behaves like the DynamoDB one, and the API served
 * through the platform's server wrapper on whatever services a test gives it.
 */
import { toFetchHandler } from '@ericminassian/platform';
import {
  type AppRecord,
  definePlatformConfig,
  type PlatformConfig,
  type PlatformRuntimeConfig,
} from '@ericminassian/platform-core';
import { createPlatformFetch } from '@ericminassian/platform/testing';
import { DateTime, Effect, Layer, Option, Ref } from 'effect';
import { decodeJwt, SignJWT } from 'jose';
import { HttpLive } from '../src/api/http.ts';
import { Artifacts } from '../src/artifacts.ts';
import { Tokens } from '../src/auth.ts';
import type { GithubOidcClaims } from '../src/authz.ts';
import { Aws } from '../src/aws.ts';
import { type GithubAppSettings, Settings } from '../src/config.ts';
import { DataBrowser } from '../src/data.ts';
import { StageEngine } from '../src/deploy.ts';
import { Dns } from '../src/dns.ts';
import { EdgeFloor } from '../src/edge-floor.ts';
import { AppEmail } from '../src/email.ts';
import { GitHub } from '../src/github.ts';
import { WorkerJobs } from '../src/jobs/call.ts';
import { AppQueues } from '../src/jobs/queues.ts';
import { AppRealtime } from '../src/jobs/realtime.ts';
import { AppServices } from '../src/jobs/services.ts';
import { Logs } from '../src/logs.ts';
import { AppSecrets } from '../src/secrets.ts';
import {
  AlreadyExists,
  type DeploymentItem,
  type EdgeFloorItem,
  type Patch,
  type StageItem,
  Store,
} from '../src/store.ts';
import { TelemetryQuery } from '../src/telemetry/query.ts';

export const platform: PlatformConfig = definePlatformConfig({
  domain: 'example.com',
  region: 'us-east-1',
  zone: 'platform.example.com',
  consoleHost: 'platform.example.com',
  edgeHost: 'edge.platform.example.com',
  loginHost: 'login.platform.example.com',
  github: { owner: 'owner', repo: 'platform', ownerId: 1, repoId: 2 },
  members: [
    { github: 'ada', role: 'admin' },
    { github: 'bob', role: 'member' },
  ],
  reservedAppNames: ['www'],
  previewTtlDays: 7,
  limits: { appsPerMember: 2, stagesPerApp: 3, emailsPerDay: 2000, servicesPerApp: 2 },
  telemetry: { logRetentionDays: { prod: 30, other: 7 } },
});

export const runtime: PlatformRuntimeConfig = {
  v: 1,
  target: 'aws',
  accountId: '000000000000',
  region: 'us-east-1',
  domain: 'example.com',
  publicScheme: 'https',
  artifactsBucket: 'artifacts',
  sitesBucket: 'sites',
  storageBucket: 'storage',
  stateTable: 'platform',
  telemetryTable: 'platform-telemetry',
};

export const githubApp: GithubAppSettings = { clientId: 'Iv1.test', clientSecret: 'secret' };

export const settingsLayer = (overrides: Partial<Settings['Service']> = {}): Layer.Layer<Settings> =>
  Layer.succeed(
    Settings,
    Settings.of({
      platform,
      consoleUrl: 'https://platform.example.com',
      runtime: Effect.succeed(runtime),
      sessionKey: Effect.succeed(new TextEncoder().encode('test-session-key-of-at-least-32-chars')),
      githubApp: Effect.succeedNone,
      ...overrides,
    }),
  );

/** Applies a patch the way `UpdateExpression` does: `undefined` removes the attribute. */
const patched = <T extends object>(item: T, patch: Patch<T>): T => {
  const next: Record<string, unknown> = { ...(item as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete next[k];
    else next[k] = v;
  }
  return next as T;
};

/** The state table in memory. */
export const memoryStore = (
  seed: {
    readonly apps?: ReadonlyArray<AppRecord>;
    readonly stages?: ReadonlyArray<StageItem>;
    readonly deployments?: ReadonlyArray<DeploymentItem>;
    readonly edgeFloor?: EdgeFloorItem;
  } = {},
): Layer.Layer<Store> =>
  Layer.sync(Store, () => {
    const apps = new Map((seed.apps ?? []).map((a) => [a.name, a]));
    const stages = new Map((seed.stages ?? []).map((s) => [`${s.app}#${s.stage}`, s]));
    const deployments = new Map((seed.deployments ?? []).map((d) => [d.id, d]));
    let edgeFloor = seed.edgeFloor;
    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const required = <A>(value: A | undefined, what: string) =>
      value === undefined ? Effect.die(new Error(`${what} does not exist`)) : Effect.succeed(value);

    return Store.of({
      getApp: (name) => Effect.sync(() => Option.fromNullishOr(apps.get(name))),
      listApps: Effect.sync(() => [...apps.values()]),
      createApp: (app) =>
        apps.has(app.name)
          ? Effect.fail(new AlreadyExists())
          : Effect.sync(() => {
              apps.set(app.name, app);
            }),
      updateApp: (name, patch) =>
        Effect.map(required(apps.get(name), `app ${name}`), (app) => {
          const next = patched(app, patch);
          apps.set(name, next);
          return next;
        }),
      deleteApp: (name) =>
        Effect.sync(() => {
          apps.delete(name);
        }),
      getStage: (app, stage) => Effect.sync(() => Option.fromNullishOr(stages.get(`${app}#${stage}`))),
      listStages: (app) => Effect.sync(() => [...stages.values()].filter((s) => s.app === app)),
      listAllStages: Effect.sync(() => [...stages.values()]),
      putStage: (stage) =>
        Effect.sync(() => {
          stages.set(`${stage.app}#${stage.stage}`, stage);
        }),
      updateStage: (app, stage, patch) =>
        Effect.gen(function* () {
          const key = `${app}#${stage}`;
          const next = patched(yield* required(stages.get(key), `stage ${key}`), {
            ...patch,
            updatedAt: yield* nowIso,
          });
          stages.set(key, next);
          return next;
        }),
      createDeployment: (deployment) =>
        Effect.sync(() => {
          deployments.set(deployment.id, deployment);
        }),
      getDeployment: (id) => Effect.sync(() => Option.fromNullishOr(deployments.get(id))),
      listDeployments: (app, limit = 50) =>
        Effect.sync(() =>
          [...deployments.values()]
            .filter((d) => d.app === app)
            .toSorted((a, b) => b.id.localeCompare(a.id))
            .slice(0, limit),
        ),
      updateDeployment: (_app, id, patch, ifStatus) =>
        Effect.sync(() => {
          const current = deployments.get(id);
          if (!current || (ifStatus && current.status !== ifStatus)) return false;
          deployments.set(id, patched(current, patch));
          return true;
        }),
      appendDeploymentEvents: (_app, id, events) =>
        Effect.sync(() => {
          const current = deployments.get(id);
          if (current)
            deployments.set(id, { ...current, events: [...current.events, ...events].slice(0, 500) });
        }),
      getEdgeFloor: Effect.sync(() => Option.fromNullishOr(edgeFloor)),
      setEdgeFloor: (item) =>
        Effect.sync(() => {
          if (edgeFloor?.on === item.on) return false;
          edgeFloor = item;
          return true;
        }),
    });
  });

/**
 * `Tokens` with real platform tokens, but GitHub Actions OIDC tokens taken at
 * their word: tests can't get GitHub to sign one, and the claims are what the
 * rules read.
 */
export const tokensLayer: Layer.Layer<Tokens, never, Settings> = Layer.effect(
  Tokens,
  Effect.gen(function* () {
    const real = yield* Tokens;
    return Tokens.of({
      ...real,
      verifyGithubOidc: (token) => Effect.sync(() => decodeJwt(token) as GithubOidcClaims),
    });
  }),
).pipe(Layer.provide(Tokens.layer));

/** A GitHub Actions OIDC token as far as `Authenticated` can tell (see `tokensLayer`). */
export const ciToken = (claims: GithubOidcClaims) =>
  Effect.promise(() =>
    new SignJWT({ ...claims })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('https://token.actions.githubusercontent.com')
      .sign(new TextEncoder().encode('not-github-but-the-test-does-not-check')),
  );

/**
 * The API on the given services, behind the platform's server wrapper (as on
 * Lambda), answering requests for `https://platform.example.com`.
 */
export const api = (services: Layer.Layer<Layer.Success<ReturnType<typeof testServices>>>) =>
  Effect.gen(function* () {
    const handler = toFetchHandler(HttpLive.pipe(Layer.provide(services)));
    yield* Effect.addFinalizer(() => Effect.promise(handler.dispose));
    const fetch = createPlatformFetch(handler);
    return (path: string, init?: RequestInit & { readonly json?: unknown }) => {
      const { json, ...rest } = init ?? {};
      const headers = new Headers(rest.headers);
      if (json !== undefined) headers.set('content-type', 'application/json');
      return Effect.promise(() =>
        fetch(
          new Request(`https://platform.example.com${path}`, {
            ...rest,
            headers,
            ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
          }),
        ),
      );
    };
  });

/** AWS clients for a test: the ones given, and clients that fail loudly for the rest. */
export const awsLayer = (clients: Partial<Aws['Service']>): Layer.Layer<Aws> => {
  const missing = (name: string) => () => {
    throw new Error(`the test gave no ${name} client`);
  };
  return Layer.succeed(
    Aws,
    Aws.of({
      ddb: missing('ddb'),
      s3: missing('s3'),
      ssm: missing('ssm'),
      lambda: missing('lambda'),
      sqs: missing('sqs'),
      scheduler: missing('scheduler'),
      sns: missing('sns'),
      logs: missing('logs'),
      cloudwatch: missing('cloudwatch'),
      sesv2: missing('sesv2'),
      ce: missing('ce'),
      wafv2: missing('wafv2'),
      cloudfront: missing('cloudfront'),
      ...clients,
    }),
  );
};

export interface TestServices {
  readonly settings?: Partial<Settings['Service']>;
  readonly store?: Layer.Layer<Store>;
  readonly github?: Partial<GitHub['Service']>;
  readonly telemetry?: Partial<TelemetryQuery['Service']>;
  readonly logs?: Partial<Logs['Service']>;
  readonly data?: Partial<DataBrowser['Service']>;
  readonly secrets?: Partial<AppSecrets['Service']>;
  readonly queues?: Partial<AppQueues['Service']>;
  readonly realtime?: Partial<AppRealtime['Service']>;
  readonly email?: Partial<AppEmail['Service']>;
  readonly edge?: Partial<EdgeFloor['Service']>;
  readonly artifacts?: Partial<Artifacts['Service']>;
  /** The engine behind the services endpoints (`describeServices`, `controlService`). */
  readonly engine?: Partial<StageEngine['Service']>;
  /** AWS clients the services endpoints call (CloudWatch). */
  readonly aws?: Partial<Aws['Service']>;
  /** What a synchronous worker job (`call`) answers. */
  readonly call?: WorkerJobs['Service']['call'];
  /** Records the jobs the API runs on the worker. */
  readonly jobs?: Ref.Ref<ReadonlyArray<{ readonly name: string; readonly payload: unknown }>>;
}

/**
 * Every service the API calls. GitHub accepts any token as its own login,
 * every hostname is free, and services a test doesn't describe fail loudly
 * when called.
 */
export const testServices = (options: TestServices = {}) => {
  const telemetry = Layer.mock(TelemetryQuery, options.telemetry ?? {});
  return Layer.mergeAll(
    options.store ?? memoryStore(),
    tokensLayer,
    Layer.mock(GitHub, {
      login: (token) => Effect.succeed(token),
      exchangeCode: (_app, code) => Effect.succeed(code),
      ...options.github,
    }),
    Dns.layerWith({
      resolveNs: () => Promise.reject(Object.assign(new Error('no data'), { code: 'ENODATA' })),
      resolveCname: () => Promise.reject(Object.assign(new Error('no data'), { code: 'ENODATA' })),
      resolve4: () => Promise.reject(Object.assign(new Error('no data'), { code: 'ENODATA' })),
    }),
    telemetry,
    AppServices.layer.pipe(
      Layer.provide([Layer.mock(StageEngine, options.engine ?? {}), awsLayer(options.aws ?? {}), telemetry]),
    ),
    Layer.mock(Logs, options.logs ?? {}),
    Layer.mock(DataBrowser, options.data ?? {}),
    Layer.mock(AppSecrets, options.secrets ?? {}),
    Layer.mock(AppQueues, options.queues ?? {}),
    Layer.mock(AppRealtime, options.realtime ?? {}),
    Layer.mock(AppEmail, options.email ?? {}),
    Layer.mock(EdgeFloor, options.edge ?? {}),
    Layer.mock(Artifacts, options.artifacts ?? {}),
    Layer.mock(WorkerJobs, {
      start: ({ kind, ...payload }) =>
        options.jobs ? Ref.update(options.jobs, (jobs) => [...jobs, { name: kind, payload }]) : Effect.void,
      ...(options.call ? { call: options.call } : {}),
    }),
  ).pipe(Layer.provideMerge(settingsLayer(options.settings)));
};
