import type { ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { findEmulatorBinary } from '@ericminassian/platform-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnWebServer } from '../src/dev/index.ts';
import { emulatorClientConfig, type LocalStage, startLocalStage } from '../src/dev/local-stage.ts';
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
const { manifest } = loadProject(root);

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
