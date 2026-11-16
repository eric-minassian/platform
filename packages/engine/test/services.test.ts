import { type PlatformRuntimeConfig, parseManifest } from '@ericminassian/platform-core';
import { gunzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { roundNumbers } from '../src/compat.ts';
import { baseImageTag, ensureBaseImage, type ImageSource, pushImage } from '../src/drivers/ecr.ts';
import {
  ensureService,
  RolloutError,
  serviceSettings,
  taskDefinitionInput,
  waitForRollout,
} from '../src/drivers/ecs.ts';
import { atExpression, parseAtExpression } from '../src/drivers/scheduler.ts';
import {
  buildLayer,
  type ImageConfig,
  imageConfig,
  imageManifest,
  MEDIA_TYPES,
  parseImageManifest,
  sha256Digest,
  tarFiles,
} from '../src/images.ts';
import { policies } from '../src/index.ts';
import {
  awaitServiceRollouts,
  buildOf,
  deployDesiredCount,
  deployStopTime,
  recoveryFor,
  rollbackSelection,
  staleServiceBuilds,
} from '../src/services.ts';
import { deployStage } from '../src/stage.ts';
import type { EngineContext } from '../src/util.ts';

const text = (s: string) => new TextEncoder().encode(s);

/** Entries of a ustar archive: name, type flag, mode, uid, mtime, size, content. */
function readTar(tar: Uint8Array) {
  const out: Array<{
    name: string;
    type: string;
    mode: number;
    uid: number;
    mtime: number;
    content: string;
  }> = [];
  const str = (b: Uint8Array) => new TextDecoder().decode(b).replace(/\0.*$/s, '');
  for (let at = 0; at + 512 <= tar.length;) {
    const h = tar.subarray(at, at + 512);
    if (h.every((b) => b === 0)) break;
    const sum = h.reduce((a, b, i) => a + (i >= 148 && i < 156 ? 0x20 : b), 0);
    expect(Number.parseInt(str(h.subarray(148, 156)).trim(), 8)).toBe(sum);
    expect(str(h.subarray(257, 263))).toBe('ustar');
    const prefix = str(h.subarray(345, 500));
    const name = (prefix ? `${prefix}/` : '') + str(h.subarray(0, 100));
    const size = Number.parseInt(str(h.subarray(124, 136)), 8);
    out.push({
      name,
      type: String.fromCharCode(h[156]!),
      mode: Number.parseInt(str(h.subarray(100, 108)), 8),
      uid: Number.parseInt(str(h.subarray(108, 116)), 8),
      mtime: Number.parseInt(str(h.subarray(136, 148)), 8),
      content: new TextDecoder().decode(tar.subarray(at + 512, at + 512 + size)),
    });
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

describe('image layers', () => {
  const files = [
    { path: '/app/index.mjs.map', content: text('{"version":3}') },
    { path: '/app/index.mjs', content: text('console.log("hi")') },
  ];

  it('writes a sorted ustar archive with parent directories, owned by root at mtime 0', () => {
    const tar = tarFiles(files);
    expect(tar.length % 512).toBe(0);
    expect(tar.subarray(-1024).every((b) => b === 0)).toBe(true);
    expect(readTar(tar)).toEqual([
      { name: 'app/', type: '5', mode: 0o755, uid: 0, mtime: 0, content: '' },
      { name: 'app/index.mjs', type: '0', mode: 0o644, uid: 0, mtime: 0, content: 'console.log("hi")' },
      { name: 'app/index.mjs.map', type: '0', mode: 0o644, uid: 0, mtime: 0, content: '{"version":3}' },
    ]);
  });

  it('gives the same bytes and digests for the same files in any order', () => {
    const a = buildLayer(files);
    const b = buildLayer(files.toReversed());
    expect(b.blob).toEqual(a.blob);
    expect(a.digest).toBe(sha256Digest(a.blob));
    expect(a.diffId).toBe(sha256Digest(gunzipSync(a.blob)));
    expect(a.diffId).toBe(sha256Digest(tarFiles(files)));
    expect(a.size).toBe(a.blob.length);
    expect([...a.blob.subarray(4, 8)]).toEqual([0, 0, 0, 0]); // gzip mtime
    expect(buildLayer([{ path: '/app/index.mjs', content: text('other') }]).digest).not.toBe(a.digest);
  });

  it('splits long paths into the ustar prefix and rejects unsafe ones', () => {
    const long = `/${'d'.repeat(90)}/${'f'.repeat(60)}.js`;
    expect(readTar(tarFiles([{ path: long, content: text('x') }])).at(-1)?.name).toBe(long.slice(1));
    expect(() => tarFiles([{ path: '/app/../etc/passwd', content: text('x') }])).toThrow(/invalid file path/);
    expect(() =>
      tarFiles([
        { path: '/a', content: text('1') },
        { path: 'a', content: text('2') },
      ]),
    ).toThrow(/duplicate/);
  });
});

describe('image config and manifest', () => {
  const base: ImageConfig = {
    architecture: 'arm64',
    os: 'linux',
    created: '2026-11-01T00:00:00Z',
    config: {
      Env: ['PATH=/usr/local/bin:/usr/bin', 'NODE_VERSION=24.11.0'],
      Entrypoint: ['docker-entrypoint.sh'],
      Cmd: ['node'],
      Labels: { a: 'b' },
    },
    rootfs: { type: 'layers', diff_ids: ['sha256:base1', 'sha256:base2'] },
    history: [{ created_by: 'base' }],
  };
  const layer = buildLayer([{ path: '/app/index.mjs', content: text('1') }]);

  it('puts the layer on top of the base and sets the process', () => {
    const config = imageConfig(base, layer, {
      entrypoint: ['node', '/app/index.mjs'],
      env: { NODE_VERSION: 'x', EXTRA: '1' },
      workingDir: '/app',
      user: 'node',
    });
    expect(config.rootfs.diff_ids).toEqual(['sha256:base1', 'sha256:base2', layer.diffId]);
    expect(config.config).toEqual({
      Env: ['PATH=/usr/local/bin:/usr/bin', 'NODE_VERSION=x', 'EXTRA=1'],
      Entrypoint: ['node', '/app/index.mjs'],
      WorkingDir: '/app',
      User: 'node',
      Labels: { a: 'b' },
    });
    expect(config.history).toEqual([
      { created_by: 'base' },
      { created: '2026-11-01T00:00:00Z', created_by: 'platform' },
    ]);
    expect(base.rootfs.diff_ids).toHaveLength(2); // the base is not modified
    expect(JSON.stringify(imageConfig(base, layer, { entrypoint: ['node'] }))).toBe(
      JSON.stringify(imageConfig(base, layer, { entrypoint: ['node'] })),
    );
  });

  it('writes an OCI manifest and refuses multi-platform indexes as a base', () => {
    const raw = imageManifest({ digest: 'sha256:c', size: 10 }, [
      { mediaType: MEDIA_TYPES.ociLayerGzip, digest: 'sha256:l', size: 5, annotations: { x: 'y' } },
    ]);
    expect(JSON.parse(raw)).toEqual({
      schemaVersion: 2,
      mediaType: MEDIA_TYPES.ociManifest,
      config: { mediaType: MEDIA_TYPES.ociConfig, digest: 'sha256:c', size: 10 },
      layers: [{ mediaType: MEDIA_TYPES.ociLayerGzip, digest: 'sha256:l', size: 5 }],
    });
    expect(parseImageManifest(raw).config.digest).toBe('sha256:c');
    expect(() =>
      parseImageManifest(
        JSON.stringify({ schemaVersion: 2, mediaType: MEDIA_TYPES.ociIndex, manifests: [] }),
      ),
    ).toThrow(/multi-platform/);
  });
});

/** An in-memory ECR repository behind a fake client. */
function fakeEcr(opts: { partSize?: number } = {}) {
  const blobs = new Map<string, Uint8Array>();
  const images = new Map<string, { digest: string; manifest: string; mediaType: string }>();
  const uploads = new Map<string, Uint8Array[]>();
  const calls: string[] = [];
  const handlers: Record<string, (i: Record<string, unknown>) => unknown> = {
    BatchCheckLayerAvailabilityCommand: (i) => ({
      layers: (i.layerDigests as string[]).map((d) => ({
        layerDigest: d,
        layerAvailability: blobs.has(d) ? 'AVAILABLE' : 'UNAVAILABLE',
      })),
    }),
    InitiateLayerUploadCommand: () => {
      const id = `u${uploads.size}`;
      uploads.set(id, []);
      return { uploadId: id, partSize: opts.partSize ?? 10 * 1024 * 1024 };
    },
    UploadLayerPartCommand: (i) => {
      const parts = uploads.get(i.uploadId as string)!;
      expect(i.partFirstByte).toBe(parts.reduce((n, p) => n + p.length, 0));
      parts.push(i.layerPartBlob as Uint8Array);
      return {};
    },
    CompleteLayerUploadCommand: (i) => {
      const bytes = new Uint8Array(Buffer.concat(uploads.get(i.uploadId as string)!));
      const digest = (i.layerDigests as string[])[0]!;
      if (sha256Digest(bytes) !== digest)
        throw Object.assign(new Error('bad digest'), { name: 'InvalidLayerException' });
      blobs.set(digest, bytes);
      return { layerDigest: digest };
    },
    PutImageCommand: (i) => {
      const manifest = i.imageManifest as string;
      const digest = sha256Digest(text(manifest));
      const tag = i.imageTag as string;
      for (const d of [parseImageManifest(manifest).config, ...parseImageManifest(manifest).layers])
        if (!blobs.has(d.digest))
          throw Object.assign(new Error('missing'), { name: 'LayersNotFoundException' });
      if (images.get(tag)?.digest === digest)
        throw Object.assign(new Error('exists'), { name: 'ImageAlreadyExistsException' });
      images.set(tag, { digest, manifest, mediaType: i.imageManifestMediaType as string });
      return { image: { imageId: { imageDigest: digest, imageTag: tag } } };
    },
    BatchGetImageCommand: (i) => {
      const tag = (i.imageIds as Array<{ imageTag: string }>)[0]!.imageTag;
      const image = images.get(tag);
      return image
        ? {
            images: [
              {
                imageId: { imageDigest: image.digest, imageTag: tag },
                imageManifest: image.manifest,
                imageManifestMediaType: image.mediaType,
              },
            ],
          }
        : { images: [], failures: [{ failureCode: 'ImageNotFound' }] };
    },
    GetDownloadUrlForLayerCommand: (i) => ({
      downloadUrl: `https://layers.example/${i.layerDigest as string}?sig=1`,
    }),
  };
  const client = {
    send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
      calls.push(cmd.constructor.name);
      const h = handlers[cmd.constructor.name];
      if (!h) throw new Error(`unexpected ${cmd.constructor.name}`);
      return h(cmd.input);
    },
    config: {
      requestHandler: {
        handle: async (req: { path: string }) => {
          calls.push('download');
          const body = blobs.get(req.path.slice(1));
          return { response: { statusCode: body ? 200 : 404, body: [body ?? new Uint8Array()] } };
        },
      },
    },
  };
  const ctx = {
    clients: { ecr: client },
    region: 'us-east-1',
    target: 'aws',
    log: () => {},
    accountId: async () => '111122223333',
  } as unknown as EngineContext;
  return { ctx, calls, blobs, images };
}

/** A tiny base image served by a fake public registry. */
function syntheticBase() {
  const layer = buildLayer([{ path: '/usr/local/bin/node', content: text('#!/bin/sh\n'), mode: 0o755 }]);
  const config = text(
    JSON.stringify({
      architecture: 'arm64',
      os: 'linux',
      config: { Env: ['PATH=/usr/local/bin'], Cmd: ['node'] },
      rootfs: { type: 'layers', diff_ids: [layer.diffId] },
    }),
  );
  const manifest = text(
    imageManifest({ digest: sha256Digest(config), size: config.length }, [
      { mediaType: MEDIA_TYPES.ociLayerGzip, digest: layer.digest, size: layer.size },
    ]),
  );
  const blobs = new Map([
    [layer.digest, layer.blob],
    [sha256Digest(config), config],
  ]);
  const fetched: string[] = [];
  const source: ImageSource = {
    manifest: async () => {
      fetched.push('manifest');
      return { bytes: manifest, mediaType: MEDIA_TYPES.ociManifest };
    },
    blob: async (_ref, digest) => {
      fetched.push(digest);
      return blobs.get(digest)!;
    },
  };
  const ref = { registry: 'public.example', repository: 'library/node', digest: sha256Digest(manifest) };
  return { ref, source, fetched, layer, blobs };
}

describe('container images on ECR', () => {
  it('copies the base image once, in parts, and verifies every digest', async () => {
    const ecr = fakeEcr({ partSize: 16 });
    const { ref, source, fetched, layer } = syntheticBase();
    const base = await ensureBaseImage(ecr.ctx, { repository: 'repo', base: ref, source });
    expect(base.tag).toBe(baseImageTag(ref.digest));
    expect(base.tag).toMatch(/^base--[0-9a-f]{12}$/);
    expect(base.digest).toBe(ref.digest);
    expect(base.config.rootfs.diff_ids).toEqual([layer.diffId]);
    expect(ecr.images.get(base.tag)?.digest).toBe(ref.digest);
    expect(ecr.calls.filter((c) => c === 'UploadLayerPartCommand').length).toBeGreaterThan(2);

    fetched.length = 0;
    const again = await ensureBaseImage(ecr.ctx, { repository: 'repo', base: ref, source });
    expect(fetched).toEqual([]); // served from the repository
    expect(again.config).toEqual(base.config);
  });

  it('refuses a base whose blobs or manifest do not match their digests', async () => {
    const { ref, source, blobs, layer } = syntheticBase();
    await expect(
      ensureBaseImage(fakeEcr().ctx, {
        repository: 'repo',
        base: { ...ref, digest: `sha256:${'0'.repeat(64)}` },
        source,
      }),
    ).rejects.toThrow(/different digest/);
    blobs.set(layer.digest, text('tampered'));
    await expect(ensureBaseImage(fakeEcr().ctx, { repository: 'repo', base: ref, source })).rejects.toThrow(
      /doesn't match its digest/,
    );
  });

  it('pushes the base plus one layer, and pushing it again uploads nothing', async () => {
    const ecr = fakeEcr();
    const { ref, source } = syntheticBase();
    const base = await ensureBaseImage(ecr.ctx, { repository: 'repo', base: ref, source });
    const spec = {
      repository: 'repo',
      repositoryUri: '1.dkr.ecr.us-east-1.amazonaws.com/repo',
      base,
      files: [{ path: '/app/index.mjs', content: text('export {}') }],
      entrypoint: ['node', '/app/index.mjs'],
      workingDir: '/app',
      user: 'node',
      tag: 'shop--prod--ais--d1',
    };
    const pushed = await pushImage(ecr.ctx, spec);
    expect(pushed.image).toBe(`1.dkr.ecr.us-east-1.amazonaws.com/repo@${pushed.digest}`);
    const manifest = parseImageManifest(ecr.images.get('shop--prod--ais--d1')!.manifest);
    expect(manifest.layers.map((l) => l.digest)).toEqual([
      ...base.manifest.layers.map((l) => l.digest),
      manifest.layers[1]!.digest,
    ]);
    const config = JSON.parse(new TextDecoder().decode(ecr.blobs.get(manifest.config.digest))) as ImageConfig;
    expect(config.config).toMatchObject({
      Entrypoint: ['node', '/app/index.mjs'],
      WorkingDir: '/app',
      User: 'node',
    });
    expect(config.config?.Cmd).toBeUndefined();

    ecr.calls.length = 0;
    expect(await pushImage(ecr.ctx, spec)).toEqual(pushed);
    expect(ecr.calls).not.toContain('InitiateLayerUploadCommand');
    // Same build under the next deployment's tag: same digest, no new blobs.
    expect((await pushImage(ecr.ctx, { ...spec, tag: 'shop--prod--ais--d2' })).digest).toBe(pushed.digest);
  });
});

describe('task definitions and services', () => {
  it('describes one ARM64 Fargate container that logs to the service log group', () => {
    const input = taskDefinitionInput({
      family: 'shop--prod--ais',
      cpu: 0.25,
      memoryMb: 512,
      taskRoleArn: 'arn:role/stage',
      executionRoleArn: 'arn:role/exec',
      image: 'repo@sha256:abc',
      environment: { PLATFORM_SERVICE: 'ais', A: '1' },
      logGroup: '/platform/apps/shop/prod/services/ais',
      region: 'us-east-1',
      tags: { 'platform:deployment': 'd1' },
    });
    expect(input).toMatchObject({
      family: 'shop--prod--ais',
      cpu: '256',
      memory: '512',
      networkMode: 'awsvpc',
      requiresCompatibilities: ['FARGATE'],
      runtimePlatform: { cpuArchitecture: 'ARM64', operatingSystemFamily: 'LINUX' },
      taskRoleArn: 'arn:role/stage',
      executionRoleArn: 'arn:role/exec',
      tags: [{ key: 'platform:deployment', value: 'd1' }],
    });
    expect(input.containerDefinitions).toEqual([
      {
        name: 'app',
        image: 'repo@sha256:abc',
        essential: true,
        environment: [
          { name: 'A', value: '1' },
          { name: 'PLATFORM_SERVICE', value: 'ais' },
        ],
        stopTimeout: 30,
        restartPolicy: { enabled: true, restartAttemptPeriod: 60 },
        logConfiguration: {
          logDriver: 'awslogs',
          options: {
            'awslogs-group': '/platform/apps/shop/prod/services/ais',
            'awslogs-region': 'us-east-1',
            'awslogs-stream-prefix': 'ecs',
            mode: 'non-blocking',
          },
        },
      },
    ]);
  });

  it('runs at most one task, on Spot unless asked otherwise, with a public address', () => {
    const settings = serviceSettings({
      cluster: 'platform',
      name: 's',
      taskDefinition: 'td',
      desiredCount: 1,
      spot: true,
      subnets: ['subnet-1'],
      securityGroups: ['sg-1'],
    });
    expect(settings.capacityProviderStrategy).toEqual([{ capacityProvider: 'FARGATE_SPOT', weight: 1 }]);
    expect(settings.deploymentConfiguration).toEqual({
      minimumHealthyPercent: 0,
      maximumPercent: 100,
      deploymentCircuitBreaker: { enable: true, rollback: true },
    });
    expect(settings.networkConfiguration.awsvpcConfiguration.assignPublicIp).toBe('ENABLED');
  });
});

type Dep = {
  taskDefinition: string;
  rolloutState: string;
  failedTasks?: number;
  createdAt: Date;
  rolloutStateReason?: string;
};

/** ECS services, tasks and log streams behind a fake client; `script` advances the service per poll. */
function fakeEcs(
  opts: {
    service?: { status?: string; taskDefinition?: string; capacity?: string; desiredCount?: number };
    script?: Array<Partial<{ deployments: Dep[]; status: string }>>;
    stopped?: Array<{
      taskArn: string;
      taskDefinitionArn: string;
      stoppedReason: string;
      exitCode?: number;
      stoppedAt: Date;
    }>;
    logs?: Record<string, string[]>;
    running?: Array<{ taskArn: string; taskDefinitionArn: string; startedAt: Date }>;
  } = {},
) {
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  let polls = 0;
  const state = { service: opts.service ? { status: 'ACTIVE', ...opts.service } : undefined };
  const handlers: Record<string, (i: Record<string, unknown>) => unknown> = {
    DescribeServicesCommand: () => {
      if (opts.script) {
        const step = opts.script[Math.min(polls++, opts.script.length - 1)]!;
        return {
          services: [
            {
              serviceName: 'svc',
              serviceArn: 'arn:svc',
              status: step.status ?? 'ACTIVE',
              deployments: step.deployments ?? [],
              events: [{ message: 'event one' }],
            },
          ],
        };
      }
      if (!state.service) return { services: [], failures: [{ reason: 'MISSING' }] };
      const s = state.service;
      if (s.status === 'DRAINING' && polls++ >= 1) s.status = 'INACTIVE';
      return {
        services: [
          {
            serviceName: 'svc',
            serviceArn: 'arn:svc',
            status: s.status,
            taskDefinition: s.taskDefinition,
            desiredCount: s.desiredCount ?? 1,
            capacityProviderStrategy: [{ capacityProvider: s.capacity ?? 'FARGATE_SPOT' }],
          },
        ],
      };
    },
    CreateServiceCommand: () => ({ service: { serviceArn: 'arn:svc' } }),
    UpdateServiceCommand: () => ({ service: { serviceArn: 'arn:svc' } }),
    TagResourceCommand: () => ({}),
    ListTasksCommand: (i) => ({
      taskArns: (i.desiredStatus === 'STOPPED' ? (opts.stopped ?? []) : (opts.running ?? [])).map(
        (t) => t.taskArn,
      ),
    }),
    DescribeTasksCommand: (i) => ({
      tasks: [
        ...(opts.stopped ?? []).map((t) => ({
          taskArn: t.taskArn,
          taskDefinitionArn: t.taskDefinitionArn,
          lastStatus: 'STOPPED',
          stoppedReason: t.stoppedReason,
          stoppedAt: t.stoppedAt,
          containers: [{ name: 'app', ...(t.exitCode !== undefined ? { exitCode: t.exitCode } : {}) }],
        })),
        ...(opts.running ?? []).map((t) => ({ ...t, lastStatus: 'RUNNING' })),
      ].filter((t) => (i.tasks as string[]).includes(t.taskArn)),
    }),
    GetLogEventsCommand: (i) => {
      const lines = opts.logs?.[i.logStreamName as string];
      if (!lines) throw Object.assign(new Error('no stream'), { name: 'ResourceNotFoundException' });
      return { events: lines.map((message) => ({ message })) };
    },
  };
  const client = {
    send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
      calls.push({ name: cmd.constructor.name, input: cmd.input });
      const h = handlers[cmd.constructor.name];
      if (!h) throw new Error(`unexpected ${cmd.constructor.name}`);
      return h(cmd.input);
    },
  };
  const ctx = {
    clients: { ecs: client, logs: client },
    region: 'us-east-1',
    target: 'aws',
    log: () => {},
    accountId: async () => '111122223333',
  } as unknown as EngineContext;
  const sent = (name: string) => calls.filter((c) => c.name === name).map((c) => c.input);
  return { ctx, sent, state };
}

const TD1 = 'arn:aws:ecs:us-east-1:1:task-definition/shop--prod--ais:1';
const TD2 = 'arn:aws:ecs:us-east-1:1:task-definition/shop--prod--ais:2';
const t0 = new Date('2026-11-16T10:00:00Z');
const t1 = new Date('2026-11-16T10:05:00Z');

describe('waitForRollout', () => {
  const spec = (over: Partial<Parameters<typeof waitForRollout>[1]> = {}) => ({
    cluster: 'platform',
    service: 'svc',
    taskDefinition: TD2,
    logGroup: '/g',
    deadline: Date.now() + 60_000,
    intervalMs: 0,
    ...over,
  });

  it('returns once the deployment of the new task definition has completed', async () => {
    const ecs = fakeEcs({
      script: [
        {
          deployments: [
            { taskDefinition: TD2, rolloutState: 'IN_PROGRESS', createdAt: t1 },
            { taskDefinition: TD1, rolloutState: 'COMPLETED', createdAt: t0 },
          ],
        },
        {
          deployments: [{ taskDefinition: TD2, rolloutState: 'IN_PROGRESS', failedTasks: 1, createdAt: t1 }],
        },
        { deployments: [{ taskDefinition: TD2, rolloutState: 'COMPLETED', failedTasks: 1, createdAt: t1 }] },
      ],
    });
    await waitForRollout(ecs.ctx, spec());
    expect(ecs.sent('DescribeServicesCommand')).toHaveLength(3);
  });

  it('returns once every new task has run for the stable time, before ECS completes it', async () => {
    const running = (startedAt: Date) => [
      { taskArn: 'arn:task/platform/new', taskDefinitionArn: TD2, startedAt },
    ];
    const inProgress = {
      deployments: [
        { taskDefinition: TD2, rolloutState: 'IN_PROGRESS', desiredCount: 1, runningCount: 1, createdAt: t1 },
      ],
    };
    const settled = fakeEcs({ script: [inProgress], running: running(new Date(Date.now() - 31_000)) });
    await waitForRollout(settled.ctx, spec());
    expect(settled.sent('DescribeServicesCommand')).toHaveLength(1);

    // A task that only just started is still being watched: here, until the deadline.
    const fresh = fakeEcs({ script: [inProgress], running: running(new Date()) });
    const late = waitForRollout(fresh.ctx, spec({ deadline: Date.now() + 50 }));
    await expect(late).rejects.toMatchObject({ failure: 'timeout' });
  });

  it('fails fast on the second failed task, with the stop reason and the last log lines', async () => {
    const ecs = fakeEcs({
      script: [
        {
          deployments: [{ taskDefinition: TD2, rolloutState: 'IN_PROGRESS', failedTasks: 2, createdAt: t1 }],
        },
      ],
      stopped: [
        {
          taskArn: 'arn:task/platform/older',
          taskDefinitionArn: TD2,
          stoppedReason: 'Essential container in task exited',
          exitCode: 1,
          stoppedAt: t0,
        },
        {
          taskArn: 'arn:task/platform/newest',
          taskDefinitionArn: TD2,
          stoppedReason: 'Essential container in task exited',
          exitCode: 1,
          stoppedAt: t1,
        },
        {
          taskArn: 'arn:task/platform/old-build',
          taskDefinitionArn: TD1,
          stoppedReason: 'Scaling activity',
          stoppedAt: t1,
        },
      ],
      logs: { 'ecs/app/newest': ['starting', 'Error: AIS_KEY is not set'] },
    });
    const error = await waitForRollout(ecs.ctx, spec()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RolloutError);
    expect((error as RolloutError).failure).toBe('failing');
    const message = (error as Error).message;
    expect(message).toContain("svc (shop--prod--ais:2) didn't start: its tasks keep stopping.");
    expect(message).toContain('task newest stopped (exit code 1): Essential container in task exited');
    expect(message).toContain('    | Error: AIS_KEY is not set');
    expect(message.indexOf('task newest')).toBeLessThan(message.indexOf('task older'));
    expect(message).not.toContain('old-build');
    expect(ecs.sent('GetLogEventsCommand')).toEqual([
      { logGroupName: '/g', logStreamName: 'ecs/app/newest', limit: 20, startFromHead: false },
    ]);
  });

  it('reports a rollout ECS failed, a replaced deployment and a timeout', async () => {
    const failed = fakeEcs({
      script: [
        {
          deployments: [
            {
              taskDefinition: TD2,
              rolloutState: 'FAILED',
              createdAt: t1,
              rolloutStateReason: 'circuit breaker',
            },
          ],
        },
      ],
    });
    const error = await waitForRollout(failed.ctx, spec()).catch((e: unknown) => e as RolloutError);
    expect(error?.failure).toBe('failed');
    expect(error?.message).toContain('circuit breaker');
    const replaced = fakeEcs({
      script: [{ deployments: [{ taskDefinition: TD1, rolloutState: 'IN_PROGRESS', createdAt: t1 }] }],
    });
    await expect(waitForRollout(replaced.ctx, spec())).rejects.toMatchObject({ failure: 'replaced' });
    const slow = fakeEcs({
      script: [{ deployments: [{ taskDefinition: TD2, rolloutState: 'IN_PROGRESS', createdAt: t1 }] }],
    });
    const late = waitForRollout(slow.ctx, spec({ deadline: Date.now() - 1 }));
    await expect(late).rejects.toMatchObject({ failure: 'timeout' });
    await expect(late).rejects.toThrow("didn't finish rolling out in time");
  });
});

describe('ensureService', () => {
  const spec = {
    cluster: 'platform',
    name: 'svc',
    taskDefinition: TD2,
    desiredCount: 1,
    spot: true,
    subnets: ['s'],
    securityGroups: ['g'],
    tags: { a: 'b' },
  };

  it('creates a missing service', async () => {
    const ecs = fakeEcs();
    expect(await ensureService(ecs.ctx, spec)).toEqual({ arn: 'arn:svc', created: true });
    expect(ecs.sent('CreateServiceCommand')[0]).toMatchObject({
      serviceName: 'svc',
      taskDefinition: TD2,
      tags: [{ key: 'a', value: 'b' }],
    });
  });

  it('updates an existing one, forcing a new deployment only to switch capacity', async () => {
    const same = fakeEcs({ service: { taskDefinition: TD1, capacity: 'FARGATE_SPOT' } });
    expect(await ensureService(same.ctx, spec)).toEqual({
      arn: 'arn:svc',
      created: false,
      previousTaskDefinition: TD1,
    });
    expect(same.sent('UpdateServiceCommand')[0]).toMatchObject({
      taskDefinition: TD2,
      forceNewDeployment: false,
    });
    const switched = fakeEcs({ service: { taskDefinition: TD1, capacity: 'FARGATE_SPOT' } });
    await ensureService(switched.ctx, { ...spec, spot: false });
    expect(switched.sent('UpdateServiceCommand')[0]).toMatchObject({
      capacityProviderStrategy: [{ capacityProvider: 'FARGATE', weight: 1 }],
      forceNewDeployment: true,
    });
  });

  it('waits for a deleted service of the same name to drain, then creates it', async () => {
    const ecs = fakeEcs({ service: { status: 'DRAINING', taskDefinition: TD1 } });
    expect((await ensureService(ecs.ctx, spec)).created).toBe(true);
    expect(ecs.sent('UpdateServiceCommand')).toEqual([]);
  });
});

describe('stage services', () => {
  it('runs services on every stage but previews, which run them for their minutes', () => {
    const now = new Date('2026-11-16T10:00:00.750Z');
    expect(deployDesiredCount('prod', { previewMinutes: 0 })).toBe(1);
    expect(deployDesiredCount('staging', { previewMinutes: 30 })).toBe(1);
    expect(deployDesiredCount('pr-7', { previewMinutes: 30 })).toBe(1);
    expect(deployDesiredCount('pr-7', { previewMinutes: 0 })).toBe(0);
    expect(deployStopTime('prod', { previewMinutes: 30 }, now)).toBeUndefined();
    expect(deployStopTime('pr-7', { previewMinutes: 0 }, now)).toBeUndefined();
    expect(deployStopTime('pr-7', { previewMinutes: 30 }, now)?.toISOString()).toBe(
      '2026-11-16T10:30:00.000Z',
    );
  });

  it('writes and reads one-shot schedule times in UTC', () => {
    const at = new Date('2026-11-16T10:30:00Z');
    expect(atExpression(at)).toBe('at(2026-11-16T10:30:00)');
    expect(parseAtExpression('at(2026-11-16T10:30:00)')).toEqual(at);
    expect(parseAtExpression('cron(0 3 * * ? *)')).toBeUndefined();
  });

  it('keeps the newest builds, the previous ones and whatever ECS still runs', () => {
    const td = (revision: number, deploymentId?: string) => ({
      arn: `td:${revision}`,
      revision,
      ...(deploymentId ? { deploymentId } : {}),
    });
    const img = (d: string) => ({ tag: `shop--prod--ais--${d}`, deploymentId: d });
    const stale = staleServiceBuilds({
      taskDefinitions: [td(7, 'd7'), td(6, 'd6'), td(5, 'd5'), td(4, 'd4'), td(3, 'd3'), td(2, 'd2'), td(1)],
      images: ['d7', 'd6', 'd5', 'd4', 'd3', 'd2'].map(img),
      // ECS still drains d3's task; d2 is what the stage ran before this deploy.
      inUse: ['td:3'],
      keep: ['d7', 'd2', undefined],
      kept: 3,
    });
    expect(stale.taskDefinitions).toEqual(['td:4', 'td:1']);
    expect(stale.imageTags).toEqual(['shop--prod--ais--d4']);
  });

  it('keeps one revision per deployment (a retried deploy registers twice)', () => {
    const stale = staleServiceBuilds({
      taskDefinitions: [
        { arn: 'td:2', revision: 2, deploymentId: 'd1' },
        { arn: 'td:1', revision: 1, deploymentId: 'd1' },
      ],
      images: [{ tag: 't', deploymentId: 'd1' }],
      inUse: [],
      keep: ['d1'],
      kept: 3,
    });
    expect(stale).toEqual({ taskDefinitions: ['td:1'], imageTags: [] });
  });

  it('repoints services both deployments have and leaves the others alone', () => {
    expect(rollbackSelection(['ais', 'old'], ['bolt', 'ais'])).toEqual({
      repoint: ['ais'],
      keep: ['bolt'],
      missing: ['old'],
    });
    const revisions = [
      { revision: 3, tags: { 'platform:deployment': 'd3' } },
      { revision: 2, tags: { 'platform:deployment': 'd1' } },
      { revision: 1, tags: { 'platform:deployment': 'd1' } },
    ];
    expect(buildOf(revisions, 'd1')?.revision).toBe(2);
    expect(buildOf(revisions, 'd0')).toBeUndefined();
  });

  it('goes back to the previous build when it gives up first, and stops a new service', () => {
    expect(recoveryFor('failing', { previousTaskDefinition: TD1 })).toEqual({ taskDefinition: TD1 });
    expect(recoveryFor('timeout', { previousTaskDefinition: TD1 })).toEqual({ taskDefinition: TD1 });
    expect(recoveryFor('failed', { previousTaskDefinition: TD1 })).toBe('none');
    expect(recoveryFor('failed', {})).toBe('stop');
    expect(recoveryFor('failing', {})).toBe('stop');
    expect(recoveryFor('replaced', {})).toBe('none');
  });

  it('fails the deploy with every failed rollout and points the service back at its last build', async () => {
    const ecs = fakeEcs({
      script: [
        {
          deployments: [{ taskDefinition: TD2, rolloutState: 'IN_PROGRESS', failedTasks: 2, createdAt: t1 }],
        },
      ],
      stopped: [
        {
          taskArn: 'arn:task/platform/t9',
          taskDefinitionArn: TD2,
          stoppedReason: 'OutOfMemoryError: Container killed due to memory usage',
          exitCode: 137,
          stoppedAt: t1,
        },
      ],
    });
    const rollout = {
      name: 'ais',
      service: 'svc',
      taskDefinition: TD2,
      previousTaskDefinition: TD1,
      desired: 1,
      logGroup: '/g',
    };
    await expect(
      awaitServiceRollouts(ecs.ctx, {
        cluster: 'platform',
        rollouts: [rollout, { ...rollout, name: 'idle', service: 'idle', desired: 0 }],
        intervalMs: 0,
      }),
    ).rejects.toThrow(/OutOfMemoryError.*\(exit code 137\)|exit code 137\): OutOfMemoryError/);
    expect(ecs.sent('UpdateServiceCommand')).toEqual([
      { cluster: 'platform', service: 'svc', taskDefinition: TD1 },
    ]);
  });

  it('refuses services on a platform that predates container compute, before creating anything', async () => {
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
    const platform: PlatformRuntimeConfig = {
      v: 1,
      target: 'aws',
      accountId: '1',
      region: 'us-east-1',
      domain: 'example.com',
      publicScheme: 'https',
      artifactsBucket: 'a',
      sitesBucket: 's',
      storageBucket: 'st',
      stateTable: 'platform',
      telemetryTable: 'platform-telemetry',
    };
    const manifest = parseManifest({ name: 'ships', services: { ais: { entry: 'src/ais.ts' } } });
    const deploy = (over: Partial<Parameters<typeof deployStage>[1]> = {}) =>
      deployStage(ctx, { manifest, stage: 'prod', deploymentId: 'd1', platform, artifacts: {}, ...over });
    await expect(deploy()).rejects.toThrow(/no container compute yet/);
    await expect(
      deploy({
        platform: {
          ...platform,
          containers: {
            cluster: 'c',
            subnets: [],
            securityGroups: [],
            repository: 'r',
            repositoryUri: 'u',
            executionRoleArn: 'e',
            schedulerRoleArn: 's',
          },
        },
      }),
    ).rejects.toThrow(/no services artifact/);
  });
});

describe('container policies', () => {
  it('lets the control plane manage services, builds and images, and pass only the container roles', () => {
    const doc = policies.controlPlanePolicy({
      region: 'us-east-1',
      accountId: '1',
      runtime: {
        artifactsBucket: 'a',
        sitesBucket: 's',
        storageBucket: 'st',
        containers: {
          cluster: 'platform',
          repository: 'platform-containers',
          executionRoleArn: 'arn:aws:iam::1:role/exec',
          schedulerRoleArn: 'arn:aws:iam::1:role/sched',
        },
      },
    });
    const bySid = Object.fromEntries(doc.Statement.map((s) => [s.Sid ?? '', s] as const));
    expect(bySid.ContainerServices?.Resource).toBe('arn:aws:ecs:us-east-1:1:service/platform/*');
    expect(bySid.ContainerTasks?.Action).toEqual(
      expect.arrayContaining([
        'ecs:RegisterTaskDefinition',
        'ecs:ListTaskDefinitionFamilies',
        'ecs:ListTagsForResource',
      ]),
    );
    expect(bySid.ContainerImages?.Resource).toBe('arn:aws:ecr:us-east-1:1:repository/platform-containers');
    expect(bySid.ContainerRoles?.Resource).toEqual(['arn:aws:iam::1:role/exec', 'arn:aws:iam::1:role/sched']);
  });

  it('lets the stop schedule only scale stage services', () => {
    const doc = policies.containerSchedulerPolicy({
      region: 'us-east-1',
      accountId: '1',
      cluster: 'platform',
    });
    expect(doc.Statement).toEqual([
      {
        Sid: 'ScaleStageServices',
        Effect: 'Allow',
        Action: 'ecs:UpdateService',
        Resource: 'arn:aws:ecs:us-east-1:1:service/platform/*--*',
      },
    ]);
  });
});

describe('emulator compat', () => {
  it('rounds nanosecond epoch timestamps to doubles the SDK can read', () => {
    expect(roundNumbers('{"createdAt":1794787458.178454563,"n":"x"}')).toBe(
      '{"createdAt":1794787458.1784546,"n":"x"}',
    );
    expect(roundNumbers('')).toBe('');
    expect(roundNumbers('<xml/>')).toBe('<xml/>');
  });
});
