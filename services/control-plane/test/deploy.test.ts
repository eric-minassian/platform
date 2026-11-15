import { assert, describe, it } from '@effect/vitest';
import type { AppRecord, DeploymentRecord } from '@ericminassian/platform-core';
import type { DeployStageResult } from '@ericminassian/platform-engine';
import { Effect, Exit, Layer, Option } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { Artifacts } from '../src/artifacts.ts';
import { Deployer, DeployFailed, StageEngine } from '../src/deploy.ts';
import { type DeploymentItem, type StageItem, Store } from '../src/store.ts';
import { memoryStore, settingsLayer } from './support.ts';

const shop: AppRecord = {
  name: 'shop',
  repo: 'bob/shop',
  owners: ['bob'],
  createdBy: 'bob',
  createdAt: '2026-11-01T00:00:00Z',
};

const deployment = (id: string, over: Partial<DeploymentItem> = {}): DeploymentItem => ({
  id,
  app: 'shop',
  stage: 'prod',
  status: 'queued',
  actor: 'bob',
  events: [],
  createdAt: '2026-11-01T00:00:00.000Z',
  ...over,
});

const route = (d: string) => ({ v: 1 as const, app: 'shop', stage: 'prod', d, o: 'fn.example' });

const liveStage: StageItem = {
  app: 'shop',
  stage: 'prod',
  host: 'shop.example.com',
  url: 'https://shop.example.com',
  status: 'deploying',
  preview: false,
  currentDeployment: 'd0',
  currentRevision: 'rev0',
  route: route('d0'),
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
};

const deployed: DeployStageResult = {
  bindings: {} as DeployStageResult['bindings'],
  host: 'shop.example.com',
  url: 'https://shop.example.com',
  route: route('d1'),
  webFunction: { name: 'shop--prod', endpointDomain: 'fn.example', revisionId: 'rev1' },
  resources: [],
};

/** The deployer on an in-memory store, a scripted engine, and an edge that serves `served`. */
const deployer = (options: {
  readonly deployments: ReadonlyArray<DeploymentItem>;
  readonly stages?: ReadonlyArray<StageItem>;
  readonly manifest?: unknown;
  readonly deploy?: StageEngine['Service']['deploy'];
  readonly served?: string;
  /** Wraps the in-memory store, e.g. to make some writes fail. */
  readonly store?: (store: Store['Service']) => Store['Service'];
}) =>
  Deployer.layer.pipe(
    Layer.provide([
      Layer.mock(Artifacts, {
        readText: () =>
          Effect.succeed(
            JSON.stringify({
              manifest: options.manifest ?? { name: 'shop', web: { server: 'src/server.ts' } },
            }),
          ),
        locate: (ref, file) =>
          Effect.succeed(
            file === 'server.zip'
              ? Option.some({ bucket: 'artifacts', key: `${ref.deployment}/${file}` })
              : Option.none(),
          ),
      }),
      Layer.mock(StageEngine, {
        deploy:
          options.deploy ??
          ((_input, log) =>
            Effect.sync(() => {
              log({ level: 'info', msg: 'table shop--prod', resource: 'table shop--prod' });
              return deployed;
            })),
        // The engine answers the route it wrote, which can differ from the target's recorded one.
        rollback: (input) => Effect.succeed({ ...input.route, o: 'fn-rolled.example' }),
      }),
      FetchHttpClient.layer.pipe(
        Layer.provide(
          Layer.succeed(FetchHttpClient.Fetch, (async () =>
            Response.json({ revision: options.served ?? 'd1' })) as unknown as typeof globalThis.fetch),
        ),
      ),
      settingsLayer(),
    ]),
    Layer.provideMerge(
      Layer.effect(
        Store,
        Effect.gen(function* () {
          const store = yield* Store;
          return options.store ? options.store(store) : store;
        }),
      ).pipe(
        Layer.provide(
          memoryStore({ apps: [shop], deployments: options.deployments, stages: options.stages ?? [] }),
        ),
      ),
    ),
  );

const read = Effect.gen(function* () {
  const store = yield* Store;
  const dep = Option.getOrThrow(yield* store.getDeployment('d1'));
  const stage = Option.getOrThrow(yield* store.getStage('shop', 'prod'));
  return { dep, stage, messages: dep.events.map((e) => e.msg) };
});

describe('Deployer.run', () => {
  it.effect('deploys, records its progress, and waits for the edge before calling it live', () =>
    Effect.gen(function* () {
      yield* Deployer.use((d) => d.run('d1'));
      const { dep, stage, messages } = yield* read;
      assert.strictEqual(dep.status, 'succeeded');
      assert.strictEqual(dep.url, 'https://shop.example.com');
      assert.strictEqual(dep.revisionId, 'rev1');
      assert.deepStrictEqual(messages, [
        'deploying shop to prod',
        'table shop--prod',
        'waiting for the edge to serve this deployment',
        'edge is serving this deployment',
        'live at https://shop.example.com',
      ]);
      assert.deepStrictEqual(
        [
          stage.status,
          stage.currentDeployment,
          stage.previousDeployment,
          stage.previousRevision,
          stage.previousRoute?.d,
        ],
        ['active', 'd1', 'd0', 'rev0', 'd0'],
      );
    }).pipe(Effect.provide(deployer({ deployments: [deployment('d1')], stages: [liveStage] }))),
  );

  it.live('rides out transient failures recording success, since the stage already serves it', () => {
    let throttled = 0;
    return Effect.gen(function* () {
      yield* Deployer.use((d) => d.run('d1'));
      const { dep, stage } = yield* read;
      assert.strictEqual(throttled, 2);
      assert.strictEqual(dep.status, 'succeeded');
      assert.strictEqual(stage.currentDeployment, 'd1');
    }).pipe(
      Effect.provide(
        deployer({
          deployments: [deployment('d1')],
          stages: [liveStage],
          store: (store) =>
            Store.of({
              ...store,
              // Decided per attempt, as a real write is sent again on each retry.
              updateDeployment: (app, id, patch, ifStatus) =>
                Effect.suspend(() =>
                  patch.status === 'succeeded' && throttled < 2
                    ? Effect.sync(() => throttled++).pipe(
                        Effect.andThen(Effect.die(new Error('ThrottlingException: rate exceeded'))),
                      )
                    : store.updateDeployment(app, id, patch, ifStatus),
                ),
            }),
        }),
      ),
    );
  });

  it.effect('records a failure, leaving the live deployment in place', () =>
    Effect.gen(function* () {
      yield* Deployer.use((d) => d.run('d1'));
      const { dep, stage, messages } = yield* read;
      assert.deepStrictEqual([dep.status, dep.error], ['failed', 'role policy too large']);
      assert.strictEqual(messages.at(-1), 'role policy too large');
      assert.deepStrictEqual([stage.status, stage.currentDeployment], ['active', 'd0']);
    }).pipe(
      Effect.provide(
        deployer({
          deployments: [deployment('d1')],
          stages: [liveStage],
          deploy: () => Effect.fail(new DeployFailed({ message: 'role policy too large' })),
        }),
      ),
    ),
  );

  it.effect('fails a deployment whose plat.config.ts names another app', () =>
    Effect.gen(function* () {
      yield* Deployer.use((d) => d.run('d1'));
      const { dep, stage } = yield* read;
      assert.strictEqual(dep.error, 'plat.config.ts name "blog" does not match app "shop"');
      assert.strictEqual(stage.status, 'failed', 'a stage with nothing live is failed');
    }).pipe(
      Effect.provide(
        deployer({
          deployments: [deployment('d1')],
          stages: [{ ...liveStage, currentDeployment: undefined, route: undefined }],
          manifest: { name: 'blog' },
        }),
      ),
    ),
  );

  it.effect('runs a deployment once, however often the job is retried', () =>
    Effect.gen(function* () {
      yield* Deployer.use((d) => d.run('d1'));
      const { dep, stage } = yield* read;
      assert.deepStrictEqual([dep.status, dep.events], ['running', []]);
      assert.strictEqual(stage.status, 'deploying');
    }).pipe(
      Effect.provide(
        deployer({ deployments: [deployment('d1', { status: 'running' })], stages: [liveStage] }),
      ),
    ),
  );
});

describe('Deployer.rollback', () => {
  const previous = deployment('d0', {
    status: 'succeeded',
    route: route('d0'),
    revisionId: 'rev0',
    url: 'https://shop.example.com',
  });

  it.effect('points the stage back at the previous deployment', () =>
    Effect.gen(function* () {
      const live = yield* Deployer.use((d) => d.rollback('shop', 'prod'));
      assert.deepStrictEqual(live, { currentDeployment: 'd0', url: 'https://shop.example.com' });
      const store = yield* Store;
      const stage = Option.getOrThrow(yield* store.getStage('shop', 'prod'));
      assert.deepStrictEqual(
        [
          stage.currentDeployment,
          stage.previousDeployment,
          stage.currentRevision,
          stage.route?.d,
          stage.route?.o,
        ],
        ['d0', 'd1', 'rev0', 'd0', 'fn-rolled.example'],
      );
      const rolledBack = Option.getOrThrow(yield* store.getDeployment('d1'));
      assert.strictEqual(rolledBack.status, 'rolled_back' satisfies DeploymentRecord['status']);
    }).pipe(
      Effect.provide(
        deployer({
          deployments: [previous, deployment('d1', { status: 'succeeded', route: route('d1') })],
          stages: [
            {
              ...liveStage,
              status: 'active',
              currentDeployment: 'd1',
              previousDeployment: 'd0',
              route: route('d1'),
            },
          ],
        }),
      ),
    ),
  );

  it.effect('refuses what it cannot roll back to', () =>
    Effect.gen(function* () {
      const refusal = (to?: string) =>
        Deployer.use((d) => d.rollback('shop', 'prod', to)).pipe(
          Effect.flip,
          Effect.map((e) => e.message),
        );
      assert.strictEqual(yield* refusal(), 'shop/prod has no previous deployment to roll back to');
      assert.strictEqual(yield* refusal('d0'), 'd0 is already live');
      assert.strictEqual(yield* refusal('d9'), 'deployment d9 is not part of shop/prod');
      const exit = yield* Effect.exit(Deployer.use((d) => d.rollback('shop', 'pr-1')));
      assert.isTrue(Exit.isFailure(exit));
    }).pipe(
      Effect.provide(deployer({ deployments: [previous], stages: [{ ...liveStage, status: 'active' }] })),
    ),
  );
});
