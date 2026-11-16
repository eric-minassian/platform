import { DescribeLogGroupsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { BatchGetImageCommand, PutImageCommand } from '@aws-sdk/client-ecr';
import { DescribeServicesCommand, DescribeTaskDefinitionCommand } from '@aws-sdk/client-ecs';
import { GetRoleCommand } from '@aws-sdk/client-iam';
import { GetScheduleCommand, GetScheduleGroupCommand, ListSchedulesCommand } from '@aws-sdk/client-scheduler';
import {
  BINDINGS_ENV,
  CONTAINER_BASE_IMAGE,
  type ContainersRuntimeConfig,
  encodeBindings,
  names,
  newDeploymentId,
  type PlatformRuntimeConfig,
  parseManifest,
  type ResolvedManifest,
} from '@ericminassian/platform-core';
import { strToU8, zipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  baseImageTag,
  createEngine,
  deleteService,
  type EmulatorConnection,
  type Engine,
  type EngineContext,
  engineContext,
  ensureBaseImage,
  ensureLocalPlatform,
  ensureService,
  findEmulatorBinary,
  type ImageSource,
  images,
  listImages,
  registerTaskDefinition,
  RolloutError,
  ServiceNotFoundError,
  startEmulator,
  uploadBlob,
  waitForRollout,
} from '../../src/index.ts';

const app = 'svctest';
const prod = parseManifest({
  name: app,
  env: { GREETING: 'hi' },
  services: { ais: { entry: 'src/ais.ts' } },
});
const previewOff = parseManifest({
  name: app,
  services: { ais: { entry: 'src/ais.ts', previewMinutes: 0 } },
});
const previewWithCron = parseManifest({
  name: app,
  crons: { tick: '*/5 * * * *' },
  services: { ais: { entry: 'src/ais.ts', previewMinutes: 10, spot: false, cpu: 0.5, memoryMb: 1024 } },
});

const WORKER = 'export const handler = async () => ({ ok: true });';
const serviceCode = (n: number) => `console.log('ais ${n}'); setInterval(() => {}, 60_000);`;

/** A small arm64 image standing in for the Node base, so no test reaches the internet. */
function syntheticImage(marker: string) {
  const layer = images.buildLayer([
    { path: '/usr/local/bin/node', content: strToU8(`#!/bin/sh\n# ${marker}\n`), mode: 0o755 },
  ]);
  const config = strToU8(
    JSON.stringify({
      architecture: 'arm64',
      os: 'linux',
      config: {
        Env: ['PATH=/usr/local/bin:/usr/bin:/bin'],
        Entrypoint: ['docker-entrypoint.sh'],
        Cmd: ['node'],
      },
      rootfs: { type: 'layers', diff_ids: [layer.diffId] },
      history: [{ created_by: marker }],
    }),
  );
  const manifest = images.imageManifest({ digest: images.sha256Digest(config), size: config.length }, [
    images.layerDescriptor(layer),
  ]);
  return { layer, config, manifest, digest: images.sha256Digest(strToU8(manifest)) };
}

/** Put the synthetic base where the engine keeps the real one (`base--<digest>`). */
async function seedBaseImage(ctx: EngineContext, repository: string) {
  const image = syntheticImage('base');
  await uploadBlob(ctx, repository, image.layer.blob, image.layer.digest);
  await uploadBlob(ctx, repository, image.config, images.sha256Digest(image.config));
  await ctx.clients.ecr.send(
    new PutImageCommand({
      repositoryName: repository,
      imageManifest: image.manifest,
      imageManifestMediaType: images.MEDIA_TYPES.ociManifest,
      imageTag: baseImageTag(CONTAINER_BASE_IMAGE.digest),
    }),
  );
  return image;
}

describe.skipIf(!findEmulatorBinary() && !process.env.PLAT_EMULATOR_ENDPOINT)(
  'long-running services on the AWS Emulator',
  () => {
    let conn: EmulatorConnection;
    let engine: Engine;
    let ctx: EngineContext;
    let platform: PlatformRuntimeConfig;
    let containers: ContainersRuntimeConfig;
    let base: ReturnType<typeof syntheticImage>;
    const prodDeployments: Array<{ id: string; taskDefinition: string; digest: string }> = [];

    beforeAll(async () => {
      conn = await startEmulator({ idleTimeoutSeconds: 600 });
      engine = createEngine({
        region: conn.region,
        emulator: { endpoint: conn.endpoint, caFile: conn.caFile, credentials: conn.credentials },
      });
      ctx = engineContext(engine);
      platform = await ensureLocalPlatform(engine, { port: 3000, jwksBaseUrl: conn.endpoint });
      containers = platform.containers!;
      base = await seedBaseImage(ctx, containers.repository);
    });

    afterAll(async () => {
      await conn?.stop();
    });

    async function deploy(stage: string, manifest: ResolvedManifest, code = serviceCode(1)) {
      const deploymentId = newDeploymentId();
      const put = (file: string, body: Uint8Array) =>
        engine.putArtifact(platform, names.artifactKey(app, stage, deploymentId, file), body);
      const services = Object.keys(manifest.services).length
        ? await put(
            'services.zip',
            zipSync({
              'ais/index.mjs': strToU8(code),
              'ais/index.mjs.map': strToU8('{"version":3,"sources":[],"mappings":""}'),
            }),
          )
        : undefined;
      const worker = manifest.worker
        ? await put('worker.zip', zipSync({ 'index.mjs': strToU8(WORKER) }))
        : undefined;
      const result = await engine.deployStage({
        manifest,
        stage,
        deploymentId,
        platform,
        artifacts: { ...(services ? { services } : {}), ...(worker ? { worker } : {}) },
        webMode: 'external',
      });
      return { deploymentId, result };
    }

    const ecsService = async (stage: string) =>
      (
        await ctx.clients.ecs.send(
          new DescribeServicesCommand({
            cluster: containers.cluster,
            services: [names.service(app, stage, 'ais')],
          }),
        )
      ).services?.[0];
    const schedules = async (stage: string) =>
      (
        await ctx.clients.scheduler
          .send(new ListSchedulesCommand({ GroupName: names.scheduleGroup(app, stage) }))
          .catch(() => ({ Schedules: [] }))
      ).Schedules?.map((s) => s.Name!).toSorted() ?? [];

    it('sets up container compute for the emulator', () => {
      expect(containers).toMatchObject({
        cluster: 'platform',
        repository: 'platform-containers',
        repositoryUri: `${conn.accountId}.dkr.ecr.${conn.region}.amazonaws.com/platform-containers`,
      });
      expect(containers.subnets.length).toBeGreaterThan(0);
      expect(containers.securityGroups).toHaveLength(1);
    });

    it('copies a base image from its registry once', async () => {
      const image = syntheticImage('copied');
      const fetched: string[] = [];
      const blobs = new Map([
        [image.layer.digest, image.layer.blob],
        [images.sha256Digest(image.config), image.config],
      ]);
      const source: ImageSource = {
        manifest: async () => {
          fetched.push('manifest');
          return { bytes: strToU8(image.manifest), mediaType: images.MEDIA_TYPES.ociManifest };
        },
        blob: async (_ref, digest) => {
          fetched.push(digest);
          return blobs.get(digest)!;
        },
      };
      const ref = { registry: 'public.example', repository: 'library/test', digest: image.digest };
      const copied = await ensureBaseImage(ctx, { repository: containers.repository, base: ref, source });
      expect(fetched).toEqual(expect.arrayContaining(['manifest', image.layer.digest]));
      const held = await ctx.clients.ecr.send(
        new BatchGetImageCommand({
          repositoryName: containers.repository,
          imageIds: [{ imageTag: copied.tag }],
        }),
      );
      expect(held.images?.[0]?.imageId?.imageDigest).toBe(image.digest);

      fetched.length = 0;
      const again = await ensureBaseImage(ctx, { repository: containers.repository, base: ref, source });
      expect(fetched).toEqual([]);
      expect(again.config.rootfs.diff_ids).toEqual([image.layer.diffId]);
    });

    it('builds the image, registers the task definition and runs the service on prod', async () => {
      const { deploymentId, result } = await deploy('prod', prod);
      const [svc] = result.services ?? [];
      expect(svc).toMatchObject({ name: 'ais', desired: 1 });
      expect(svc?.stopsAt).toBeUndefined();
      expect(svc?.image).toMatch(new RegExp(`^${containers.repositoryUri}@sha256:[0-9a-f]{64}$`));
      const digest = svc!.image.split('@')[1]!;
      prodDeployments.push({ id: deploymentId, taskDefinition: svc!.taskDefinitionArn, digest });
      expect(
        result.resources.filter((r) => ['image', 'task-definition', 'ecs-service'].includes(r.type)),
      ).toEqual([
        {
          type: 'image',
          name: `platform-containers:${names.serviceImageTag(app, 'prod', 'ais', deploymentId)}`,
        },
        { type: 'task-definition', name: 'svctest--prod--ais:1', arn: svc!.taskDefinitionArn },
        {
          type: 'ecs-service',
          name: 'svctest--prod--ais',
          arn: `arn:aws:ecs:${conn.region}:${conn.accountId}:service/platform/svctest--prod--ais`,
        },
      ]);

      // The image: the base's layers plus the app's.
      const image = await ctx.clients.ecr.send(
        new BatchGetImageCommand({
          repositoryName: containers.repository,
          imageIds: [{ imageTag: names.serviceImageTag(app, 'prod', 'ais', deploymentId) }],
        }),
      );
      expect(image.images?.[0]?.imageId?.imageDigest).toBe(digest);
      const manifest = images.parseImageManifest(image.images![0]!.imageManifest!);
      expect(manifest.layers).toHaveLength(2);
      expect(manifest.layers[0]?.digest).toBe(base.layer.digest);

      // The task definition: the worker's environment, the stage role, tagged with the deployment.
      const td = await ctx.clients.ecs.send(
        new DescribeTaskDefinitionCommand({ taskDefinition: svc!.taskDefinitionArn, include: ['TAGS'] }),
      );
      const container = td.taskDefinition?.containerDefinitions?.[0];
      const env = Object.fromEntries(
        (container?.environment ?? []).map((e) => [e.name ?? '', e.value ?? '']),
      );
      expect(env).toMatchObject({
        PLATFORM_SERVICE: 'ais',
        GREETING: 'hi',
        NODE_OPTIONS: '--enable-source-maps',
      });
      expect(env[BINDINGS_ENV]).toBe(encodeBindings(result.bindings));
      const role = await ctx.clients.iam.send(new GetRoleCommand({ RoleName: names.role(app, 'prod') }));
      expect(td.taskDefinition).toMatchObject({
        family: 'svctest--prod--ais',
        cpu: '256',
        memory: '512',
        taskRoleArn: role.Role?.Arn,
        executionRoleArn: containers.executionRoleArn,
        runtimePlatform: { cpuArchitecture: 'ARM64', operatingSystemFamily: 'LINUX' },
      });
      expect(container).toMatchObject({
        name: 'app',
        image: svc!.image,
        logConfiguration: {
          logDriver: 'awslogs',
          options: {
            'awslogs-group': '/platform/apps/svctest/prod/services/ais',
            'awslogs-stream-prefix': 'ecs',
          },
        },
      });
      expect(Object.fromEntries((td.tags ?? []).map((t) => [t.key ?? '', t.value ?? '']))).toMatchObject({
        'platform:app': app,
        'platform:stage': 'prod',
        'platform:deployment': deploymentId,
      });

      // The service: one task on Spot, rolled out.
      const service = await ecsService('prod');
      expect(service).toMatchObject({
        desiredCount: 1,
        runningCount: 1,
        taskDefinition: svc!.taskDefinitionArn,
      });
      expect(service?.capacityProviderStrategy?.[0]?.capacityProvider).toBe('FARGATE_SPOT');
      expect(service?.deployments?.[0]?.rolloutState).toBe('COMPLETED');

      const groups = await ctx.clients.logs.send(
        new DescribeLogGroupsCommand({ logGroupNamePrefix: '/platform/apps/svctest/prod/services/' }),
      );
      expect(groups.logGroups?.map((g) => [g.logGroupName, g.retentionInDays])).toEqual([
        ['/platform/apps/svctest/prod/services/ais', 30],
      ]);
    });

    it('describes the service as ECS runs it', async () => {
      const [state, ...rest] = await engine.describeServices({ app, stage: 'prod', platform });
      expect(rest).toEqual([]);
      expect(state).toMatchObject({
        name: 'ais',
        desired: 1,
        running: 1,
        pending: 0,
        rollout: 'completed',
        deploymentId: prodDeployments[0]!.id,
      });
      expect(state?.startedAt).toMatch(/^\d{4}-/);
      expect(state?.stopsAt).toBeUndefined();
      expect(state?.events.length).toBeGreaterThan(0);
      expect(
        await engine.describeServices({
          app,
          stage: 'prod',
          platform: { ...platform, containers: undefined },
        }),
      ).toEqual([]);
    });

    it('rebuilds on redeploy: the same code gives the same image', async () => {
      const same = await deploy('prod', prod);
      const changed = await deploy('prod', prod, serviceCode(2));
      for (const d of [same, changed]) {
        const svc = d.result.services![0]!;
        prodDeployments.push({
          id: d.deploymentId,
          taskDefinition: svc.taskDefinitionArn,
          digest: svc.image.split('@')[1]!,
        });
      }
      const [first, second, third] = prodDeployments;
      expect(second!.digest).toBe(first!.digest);
      expect(third!.digest).not.toBe(first!.digest);
      expect(third!.taskDefinition).toMatch(/:3$/);
      expect((await ecsService('prod'))?.taskDefinition).toBe(third!.taskDefinition);
    });

    it('starts, stops and restarts a service', async () => {
      const control = (action: 'start' | 'stop' | 'restart', minutes?: number) =>
        engine.controlService({
          app,
          stage: 'prod',
          platform,
          name: 'ais',
          action,
          ...(minutes ? { minutes } : {}),
        });
      expect(await control('stop')).toEqual({ desired: 0 });
      expect((await ecsService('prod'))?.desiredCount).toBe(0);

      const before = Date.now();
      const started = await control('start', 5);
      expect(started.desired).toBe(1);
      const stopsAt = Date.parse(started.stopsAt!);
      expect(stopsAt).toBeGreaterThanOrEqual(before + 5 * 60_000 - 1_000);
      expect(stopsAt).toBeLessThanOrEqual(Date.now() + 5 * 60_000);
      const schedule = await ctx.clients.scheduler.send(
        new GetScheduleCommand({ GroupName: names.scheduleGroup(app, 'prod'), Name: 'ais--stop' }),
      );
      expect(schedule).toMatchObject({
        ScheduleExpression: `at(${started.stopsAt!.slice(0, 19)})`,
        ActionAfterCompletion: 'DELETE',
        Target: {
          Arn: 'arn:aws:scheduler:::aws-sdk:ecs:updateService',
          RoleArn: containers.schedulerRoleArn,
          Input: JSON.stringify({ Cluster: 'platform', Service: 'svctest--prod--ais', DesiredCount: 0 }),
        },
      });
      expect((await engine.describeServices({ app, stage: 'prod', platform }))[0]?.stopsAt).toBe(
        started.stopsAt,
      );

      expect(await control('restart')).toEqual(started);
      expect(await control('start')).toEqual({ desired: 1 });
      expect(await schedules('prod')).toEqual([]);

      await expect(
        engine.controlService({ app, stage: 'prod', platform, name: 'nope', action: 'stop' }),
      ).rejects.toBeInstanceOf(ServiceNotFoundError);
    });

    it("rolls a service back to an earlier deployment's build", async () => {
      const [first] = prodDeployments;
      const route = { v: 1 as const, app, stage: 'prod', d: first!.id };
      await engine.rollbackStage({ app, stage: 'prod', platform, route, services: ['ais', 'gone'] });
      expect((await ecsService('prod'))?.taskDefinition).toBe(first!.taskDefinition);
      await expect(
        engine.rollbackStage({
          app,
          stage: 'prod',
          platform,
          route: { ...route, d: 'dmissing' },
          services: ['ais'],
        }),
      ).rejects.toThrow(
        "deployment dmissing can't be rolled back to: the build of service ais has been cleaned up",
      );
    });

    it('keeps the builds of the newest deployments and of the previous one', async () => {
      // The stage runs the first deployment's build after the rollback, so it survives these two.
      const fourth = await deploy('prod', prod, serviceCode(4));
      const fifth = await deploy('prod', prod, serviceCode(5));
      const tags = (await listImages(ctx, containers.repository, `${app}--prod--`))
        .map((i) => i.tag)
        .toSorted();
      const kept = [prodDeployments[2]!.id, fourth.deploymentId, fifth.deploymentId];
      expect(tags).toEqual(kept.map((d) => names.serviceImageTag(app, 'prod', 'ais', d)).toSorted());
      await expect(
        engine.rollbackStage({
          app,
          stage: 'prod',
          platform,
          route: { v: 1, app, stage: 'prod', d: prodDeployments[0]!.id },
          services: ['ais'],
        }),
      ).rejects.toThrow(/the build of service ais has been cleaned up/);
    });

    it("doesn't run a preview's service when its previewMinutes is 0", async () => {
      const { result } = await deploy('pr-5', previewOff);
      expect(result.services?.[0]).toMatchObject({ name: 'ais', desired: 0 });
      expect(result.services?.[0]?.stopsAt).toBeUndefined();
      expect((await ecsService('pr-5'))?.desiredCount).toBe(0);
      expect(await schedules('pr-5')).toEqual([]);
    });

    it('runs a preview for its minutes, next to its crons', async () => {
      const before = Date.now();
      const { result } = await deploy('pr-6', previewWithCron);
      const svc = result.services![0]!;
      expect(svc.desired).toBe(1);
      expect(Date.parse(svc.stopsAt!)).toBeGreaterThanOrEqual(before + 10 * 60_000 - 1_000);
      expect(await schedules('pr-6')).toEqual(['ais--stop', 'tick']);
      const service = await ecsService('pr-6');
      expect(service?.capacityProviderStrategy?.[0]?.capacityProvider).toBe('FARGATE');
      const td = await ctx.clients.ecs.send(
        new DescribeTaskDefinitionCommand({ taskDefinition: svc.taskDefinitionArn }),
      );
      expect(td.taskDefinition).toMatchObject({ cpu: '512', memory: '1024' });

      // Crons go, the stop schedule stays: with the worker kept, then without one.
      const noCrons = parseManifest({ name: app, queues: { jobs: {} }, services: previewWithCron.services });
      await deploy('pr-6', noCrons);
      expect(await schedules('pr-6')).toEqual(['ais--stop']);
      await deploy('pr-6', parseManifest({ name: app, services: previewWithCron.services }));
      expect(await schedules('pr-6')).toEqual(['ais--stop']);
    });

    it('removes a service the manifest drops, and brings it back', async () => {
      await deploy('pr-6', parseManifest({ name: app }));
      expect((await ecsService('pr-6'))?.status).not.toBe('ACTIVE');
      expect(await listImages(ctx, containers.repository, `${app}--pr-6--`)).toEqual([]);
      expect(
        (await engine.listStageResources(app, 'pr-6')).filter((r) => r.type === 'task-definition'),
      ).toEqual([]);
      const group = await ctx.clients.scheduler
        .send(new GetScheduleGroupCommand({ Name: names.scheduleGroup(app, 'pr-6') }))
        .catch(() => undefined);
      expect(group?.State ?? 'deleted').not.toBe('ACTIVE');

      // The old service of the same name may still be draining.
      const { result } = await deploy('pr-6', previewWithCron);
      expect(result.services?.[0]?.desired).toBe(1);
      expect((await ecsService('pr-6'))?.status).toBe('ACTIVE');
    });

    it('fails a rollout with the reason its tasks stopped', async () => {
      const name = `${app}--probe--broken`;
      const taskDefinition = await registerTaskDefinition(ctx, {
        family: name,
        cpu: 0.25,
        memoryMb: 512,
        taskRoleArn: containers.executionRoleArn,
        executionRoleArn: containers.executionRoleArn,
        image: `${containers.repositoryUri}@sha256:${'0'.repeat(64)}`,
        environment: {},
        logGroup: '/platform/apps/svctest/probe/services/broken',
        region: conn.region,
      });
      await ensureService(ctx, {
        cluster: containers.cluster,
        name,
        taskDefinition,
        desiredCount: 1,
        spot: true,
        subnets: containers.subnets,
        securityGroups: containers.securityGroups,
      });
      const error = await waitForRollout(ctx, {
        cluster: containers.cluster,
        service: name,
        taskDefinition,
        deadline: Date.now() + 120_000,
        intervalMs: 1_000,
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RolloutError);
      expect((error as Error).message).toMatch(/CannotPullContainerError/);
      await deleteService(ctx, containers.cluster, name);
    });

    it("destroys every stage's services, builds and images", async () => {
      for (const stage of ['prod', 'pr-5', 'pr-6']) await engine.destroyStage({ app, stage, platform });
      for (const stage of ['prod', 'pr-5', 'pr-6']) {
        const left = await engine.listStageResources(app, stage);
        expect(left.filter((r) => ['ecs-service', 'task-definition', 'schedule'].includes(r.type))).toEqual(
          [],
        );
      }
      expect(await listImages(ctx, containers.repository, `${app}--`)).toEqual([]);
      // The base image stays for every other app.
      expect((await listImages(ctx, containers.repository, 'base--')).length).toBeGreaterThan(0);
    });
  },
);
