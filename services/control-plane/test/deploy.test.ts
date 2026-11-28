import type { LambdaClient } from '@aws-sdk/client-lambda';
import { assert, describe, it } from '@effect/vitest';
import type { AppRecord, ArtifactFile, DeploymentRecord } from '@ericminassian/platform-core';
import type { DeployStageInput, DeployStageResult, RollbackStageInput } from '@ericminassian/platform-engine';
import { Effect, Exit, Layer, Option } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { Artifacts } from '../src/artifacts.ts';
import { Deployer, DeployFailed, StageEngine } from '../src/deploy.ts';
import { type DeploymentItem, type StageItem, Store } from '../src/store.ts';
import { awsLayer, memoryStore, settingsLayer } from './support.ts';

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
  /** Artifacts that were uploaded (default: server.zip). */
  readonly files?: ReadonlyArray<ArtifactFile>;
  readonly deploy?: StageEngine['Service']['deploy'];
  readonly rollback?: (input: RollbackStageInput) => void;
  readonly served?: string;
  /** Wraps the in-memory store, e.g. to make some writes fail. */
  readonly store?: (store: Store['Service']) => Store['Service'];
  /** The account's Lambda concurrency limit (default 1,000). */
  readonly accountConcurrency?: number;
}) =>
  Deployer.layer.pipe(
    Layer.provide([
      awsLayer({
        lambda: () =>
          ({
            send: async () => ({
              AccountLimit: { ConcurrentExecutions: options.accountConcurrency ?? 1000 },
            }),
          }) as unknown as LambdaClient,
      }),
      Layer.mock(Artifacts, {
        readText: () =>
          Effect.succeed(
            JSON.stringify({
              manifest: options.manifest ?? { name: 'shop', web: { server: 'src/server.ts' } },
            }),
          ),
        locate: (ref, file) =>
          Effect.succeed(
            (options.files ?? ['server.zip']).includes(file)
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
        rollback: (input) =>
          Effect.sync(() => {
            options.rollback?.(input);
            return { ...input.route, o: 'fn-rolled.example' };
          }),
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
        'the server runs in instance mode',
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

  it.effect('fails a deployment whose manifest.json still declares services', () =>
    Effect.gen(function* () {
      yield* Deployer.use((d) => d.run('d1'));
      const { dep } = yield* read;
      assert.strictEqual(dep.status, 'failed');
      assert.match(dep.error ?? '', /services: removed in 0\.5\.0/);
    }).pipe(
      Effect.provide(
        deployer({
          deployments: [deployment('d1')],
          stages: [liveStage],
          manifest: {
            name: 'shop',
            web: { server: 'src/server.ts' },
            services: { ais: { entry: 'src/ais.ts' } },
          },
          files: ['server.zip'],
        }),
      ),
    ),
  );

  describe('compute modes', () => {
    /** The engine's answer for a request-mode server. */
    const requestMode = (input: DeployStageInput): DeployStageResult => ({
      ...deployed,
      compute: input.webCompute ?? 'instance',
      ...(input.webCompute === 'request'
        ? {
            webFunction: undefined,
            requestFunction: { name: 'shop--prod--web', urlDomain: 'u.lambda-url.example', version: '7' },
            route: { ...route('d1'), o: 'u.lambda-url.example', c: 'r' as const, k: 'secret' },
          }
        : {}),
    });
    const recording = (inputs: DeployStageInput[]) => (input: DeployStageInput) =>
      Effect.sync(() => {
        inputs.push(input);
        return requestMode(input);
      });

    it.effect('starts a new prod stage in request mode, and records the version', () => {
      const inputs: DeployStageInput[] = [];
      return Effect.gen(function* () {
        yield* Deployer.use((d) => d.run('d1'));
        const { dep, stage, messages } = yield* read;
        assert.strictEqual(inputs[0]?.webCompute, 'request');
        assert.include(messages, 'the server runs in request mode');
        assert.deepStrictEqual([dep.compute, dep.version, dep.revisionId], ['request', '7', undefined]);
        assert.deepStrictEqual([stage.compute, stage.currentRevision], ['request', '7']);
      }).pipe(
        Effect.provide(
          deployer({
            deployments: [deployment('d1', { sdk: '0.4.0' })],
            stages: [{ ...liveStage, currentDeployment: undefined, route: undefined }],
            deploy: recording(inputs),
          }),
        ),
      );
    });

    it.effect(
      'keeps a new stage on a Web Function while the account lacks the concurrency, and says why',
      () => {
        const inputs: DeployStageInput[] = [];
        return Effect.gen(function* () {
          yield* Deployer.use((d) => d.run('d1'));
          const { dep, messages } = yield* read;
          assert.strictEqual(inputs[0]?.webCompute, 'instance');
          assert.strictEqual(dep.compute, 'instance');
          assert.isTrue(messages.some((m) => /Lambda concurrency limit is 10/.test(m)));
        }).pipe(
          Effect.provide(
            deployer({
              deployments: [deployment('d1', { sdk: '0.4.0' })],
              stages: [{ ...liveStage, currentDeployment: undefined, route: undefined }],
              deploy: recording(inputs),
              accountConcurrency: 10,
            }),
          ),
        );
      },
    );

    it.effect('keeps prod in the mode the chooser put it in, and previews on request mode', () => {
      const inputs: DeployStageInput[] = [];
      const run = (stage: StageItem) =>
        Deployer.use((d) => d.run('d1')).pipe(
          Effect.provide(
            deployer({
              deployments: [deployment('d1', { stage: stage.stage, sdk: '0.4.0' })],
              stages: [stage],
              deploy: recording(inputs),
            }),
          ),
        );
      return Effect.gen(function* () {
        yield* run({ ...liveStage, compute: 'instance' });
        yield* run({ ...liveStage, stage: 'pr-3', preview: true, compute: 'instance' });
        assert.deepStrictEqual(
          inputs.map((i) => [i.stage, i.webCompute]),
          [
            ['prod', 'instance'],
            ['pr-3', 'request'],
          ],
        );
      });
    });

    it.effect('runs a build from before request mode as a Web Function, and refuses it per request', () =>
      Effect.gen(function* () {
        const inputs: DeployStageInput[] = [];
        const run = (manifest: unknown) =>
          Effect.gen(function* () {
            yield* Deployer.use((d) => d.run('d1'));
            return (yield* read).dep;
          }).pipe(
            Effect.provide(
              deployer({
                deployments: [deployment('d1', { sdk: '0.3.0' })],
                stages: [{ ...liveStage, currentDeployment: undefined, route: undefined }],
                manifest,
                deploy: recording(inputs),
              }),
            ),
          );
        const auto = yield* run({ name: 'shop', web: { server: 'src/server.ts' } });
        assert.deepStrictEqual([auto.status, inputs[0]?.webCompute], ['succeeded', 'instance']);
        const refused = yield* run({ name: 'shop', web: { server: 'src/server.ts', compute: 'request' } });
        assert.deepStrictEqual(
          [refused.status, refused.error],
          [
            'failed',
            "web.compute is 'request', but this build's @ericminassian/platform is 0.3.0: request mode needs 0.4.0 or later",
          ],
        );
      }),
    );

    it.effect('runs a compute switch in its mode, from the build it switches, and restarts the count', () => {
      const inputs: DeployStageInput[] = [];
      return Effect.gen(function* () {
        yield* Deployer.use((d) => d.run('d1'));
        const { dep, stage } = yield* read;
        assert.strictEqual(dep.status, 'succeeded');
        assert.deepStrictEqual(
          [inputs[0]?.deploymentId, inputs[0]?.webCompute, inputs[0]?.artifacts.server?.key],
          ['d1', 'request', 'd0/server.zip'],
        );
        assert.deepStrictEqual([stage.compute, stage.computeStreak], ['request', undefined]);
      }).pipe(
        Effect.provide(
          deployer({
            deployments: [
              deployment('d1', {
                actor: 'platform',
                sdk: '0.4.0',
                compute: 'request',
                computeSwitchOf: 'd0',
              }),
            ],
            stages: [
              {
                ...liveStage,
                compute: 'instance',
                computeStreak: { to: 'request', days: 3, day: '2026-11-16' },
              },
            ],
            deploy: recording(inputs),
          }),
        ),
      );
    });
  });

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

  it.effect('restores the target’s compute mode, with its version', () => {
    const inputs: RollbackStageInput[] = [];
    const requestRoute = { ...route('d0'), o: 'u.lambda-url.example', c: 'r' as const, k: 'secret' };
    return Effect.gen(function* () {
      yield* Deployer.use((d) => d.rollback('shop', 'prod'));
      assert.deepStrictEqual(
        [inputs[0]?.version, inputs[0]?.revisionId, inputs[0]?.route.c],
        ['4', undefined, 'r'],
      );
      const stage = Option.getOrThrow(yield* (yield* Store).getStage('shop', 'prod'));
      assert.deepStrictEqual(
        [stage.compute, stage.currentRevision, stage.computeStreak],
        ['request', '4', undefined],
      );
    }).pipe(
      Effect.provide(
        deployer({
          deployments: [
            deployment('d0', { status: 'succeeded', route: requestRoute, version: '4', compute: 'request' }),
            deployment('d1', { status: 'succeeded', route: route('d1'), compute: 'instance' }),
          ],
          stages: [
            {
              ...liveStage,
              status: 'active',
              currentDeployment: 'd1',
              previousDeployment: 'd0',
              compute: 'instance',
              computeStreak: { to: 'request', days: 1, day: '2026-11-16' },
            },
          ],
          rollback: (input) => inputs.push(input),
        }),
      ),
    );
  });

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
