import { type ChildProcess, execFile } from 'node:child_process';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import {
  APPSYNC_SUBPROTOCOL,
  channelPath,
  REALTIME_PATH,
  type RealtimeClientConfig,
  type ResolvedManifest,
} from '@ericminassian/platform-core';
import { findEmulatorBinary } from '@ericminassian/platform-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnWebServer } from '../src/dev/index.ts';
import { emulatorClientConfig, type LocalStage, localEnv, startLocalStage } from '../src/dev/local-stage.ts';
import { localRouteRecord, startLocalRouter } from '../src/dev/router.ts';
import {
  type Dispatcher,
  type LocalWorker,
  startLocalWorker,
  startWorkerDispatch,
} from '../src/dev/worker.ts';
import { loadProject } from '../src/project.ts';
import { waitForPort } from '../src/util/net.ts';
import { FIXTURES } from './helpers.ts';

// End to end through the real engine + SDK on the AWS Emulator: what `plat dev`
// and `plat test` do, minus the router and the frontend dev server.
const root = join(FIXTURES, 'basic-app');
const { manifest } = await loadProject(root);

describe.skipIf(!findEmulatorBinary())('local stage on the AWS Emulator', () => {
  let stage: LocalStage;
  let server: ChildProcess | undefined;
  let worker: LocalWorker | undefined;
  let dispatcher: Dispatcher | undefined;
  let workerOutput = '';

  beforeAll(async () => {
    stage = await startLocalStage({ root, manifest, stage: 'test', port: 3999 });
    worker = await startLocalWorker(stage, manifest, root, { watch: false });
    worker.child.stdout?.on('data', (c) => (workerOutput += c));
    worker.child.stderr?.on('data', (c) => (workerOutput += c));
    dispatcher = await startWorkerDispatch(stage, manifest, worker);
  });

  afterAll(async () => {
    dispatcher?.stop();
    worker?.stop();
    server?.kill('SIGTERM');
    await stage?.stop();
  });

  it('provisions the stage and returns bindings', () => {
    expect(stage.bindings.app).toBe('basic-app');
    expect(stage.bindings.stage).toBe('test');
    expect(stage.bindings.table).toBeTruthy();
    expect(Object.keys(stage.bindings.queues)).toEqual(['jobs']);
    expect(stage.result.workerFunction?.name).toBeTruthy();
  });

  it('runs a cron in the local worker', async () => {
    const r = await dispatcher!.runCron('tick');
    expect(r.error).toBeUndefined();
    expect(r.ok).toBe(true);
  });

  it('delivers queue messages from the emulator to the worker', async () => {
    const sqs = new SQSClient(emulatorClientConfig(stage.conn));
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: stage.bindings.queues.jobs!.url,
        MessageBody: JSON.stringify({ n: 42 }),
      }),
    );
    const deadline = Date.now() + 30_000;
    while (!workerOutput.includes('hello from basic-app') && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 200));
    expect(workerOutput).toContain('hello from basic-app');
  });

  it('serves the app through the SDK server wrapper', async () => {
    const spawned = await spawnWebServer(stage, manifest, root, { watch: false });
    server = spawned.child;
    let output = '';
    server.stdout?.on('data', (c) => (output += c));
    server.stderr?.on('data', (c) => (output += c));
    await waitForPort(spawned.port, '127.0.0.1', 30_000).catch((err) => {
      throw new Error(`${(err as Error).message}\n${output}`);
    });
    const res = await fetch(`http://127.0.0.1:${spawned.port}/hello`);
    expect(await res.text()).toBe('hello from basic-app /hello');
    const health = await fetch(`http://127.0.0.1:${spawned.port}/__platform/health`);
    expect(health.status).toBe(200);
  });
});

// Realtime the way a browser meets it under `plat dev`: the config and the
// WebSocket through the local router, events published by the SDK with the
// stage's IAM credentials into the emulator's Event API.
describe.skipIf(!findEmulatorBinary())('local realtime on the AWS Emulator', () => {
  const realtimeManifest: ResolvedManifest = {
    ...manifest,
    realtime: { subscribe: 'public', channels: ['board', 'boards/*'] },
  };
  let stage: LocalStage;
  let router: Server;
  let base: string;

  beforeAll(async () => {
    stage = await startLocalStage({ root, manifest: realtimeManifest, stage: 'test', port: 3998 });
    const realtime = stage.realtime!;
    const record = localRouteRecord({
      app: realtimeManifest.name,
      stage: 'test',
      deploymentId: stage.deploymentId,
      hasServer: false,
      hasStatic: true,
      serverRoutes: ['/api/'],
      spa: true,
      realtime: { namespace: realtime.config.namespace, subscribe: realtime.config.subscribe },
    });
    router = await startLocalRouter({ port: 0, state: () => ({ record, staticDir: root, realtime }) });
    base = `127.0.0.1:${(router.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    router?.close();
    await stage?.stop();
  });

  /** One publish through the SDK, in a process with the stage's environment, like the server. */
  const publish = (channel: string, event: unknown) =>
    promisify(execFile)(
      process.execPath,
      [join(FIXTURES, 'realtime-publish.ts'), channel, JSON.stringify(event)],
      { env: localEnv(stage, realtimeManifest), cwd: root },
    );

  it('serves the stage’s config at the realtime path', async () => {
    const config = (await (await fetch(`http://${base}${REALTIME_PATH}`)).json()) as RealtimeClientConfig;
    expect(config).toEqual(stage.realtime!.config);
    expect(config.namespace).toBe(stage.bindings.realtime?.namespace);
    expect(config.subscribe).toBe('public');
    expect(config.apiKey).toBeTruthy();
  });

  it('delivers an event published by the SDK to a WebSocket subscribed through the router', async () => {
    const config = stage.realtime!.config;
    const auth = { host: config.host, 'x-api-key': config.apiKey! };
    const header = Buffer.from(JSON.stringify(auth)).toString('base64url');
    const ws = new WebSocket(`ws://${base}${REALTIME_PATH}`, [APPSYNC_SUBPROTOCOL, `header-${header}`]);
    const received = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no event within 20 s')), 20_000);
      ws.addEventListener('error', () => reject(new Error('WebSocket error')));
      ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'connection_init' })));
      ws.addEventListener('message', (m) => {
        const msg = JSON.parse(String(m.data)) as { type: string; event?: string };
        if (msg.type === 'connection_ack')
          ws.send(
            JSON.stringify({
              type: 'subscribe',
              id: 's1',
              channel: channelPath(config.namespace, 'boards/*'),
              authorization: auth,
            }),
          );
        else if (msg.type === 'subscribe_success')
          publish('boards/b1', { stroke: 1 }).catch((err: Error) => reject(err));
        else if (msg.type === 'data') {
          clearTimeout(timer);
          // AppSync carries each event as one JSON string.
          resolve(JSON.parse(msg.event!));
        } else if (msg.type.endsWith('error')) reject(new Error(String(m.data)));
      });
    });
    try {
      expect(await received).toEqual({ stroke: 1 });
    } finally {
      ws.close();
    }
  });
});
