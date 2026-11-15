import { type ChildProcess, execFile } from 'node:child_process';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import {
  APPSYNC_SUBPROTOCOL,
  type CapturedEmail,
  channelPath,
  EMAIL_INBOX_PATH,
  REALTIME_PATH,
  type RealtimeClientConfig,
  type ResolvedManifest,
} from '@ericminassian/platform-core';
import { findEmulatorBinary } from '@ericminassian/platform-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnWebServer } from '../src/dev/index.ts';
import { emulatorClientConfig, type LocalStage, localEnv, startLocalStage } from '../src/dev/local-stage.ts';
import { createInbox, localMailUrl } from '../src/dev/mail.ts';
import { type LocalRouterState, localRouteRecord, startLocalRouter } from '../src/dev/router.ts';
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

// Mail the way `plat dev` handles it: the app's server sends with the SDK on a
// stage whose bindings say `local`, the send counts against the stage's limit
// in the emulator's telemetry table, and the message lands in the inbox the
// local router serves. Nothing reaches SES.
describe.skipIf(!findEmulatorBinary())('local email on the AWS Emulator', () => {
  const emailManifest: ResolvedManifest = {
    ...manifest,
    // The fixture server sends what it's given; paths resolve from the app's root.
    web: { ...manifest.web!, server: '../email-server.ts' },
    email: { name: 'Basic', dailyLimit: 2 },
  };
  let stage: LocalStage;
  let router: Server;
  let server: ChildProcess | undefined;
  let base: string;
  const inbox = createInbox({ app: emailManifest.name });
  const state: LocalRouterState = {
    record: localRouteRecord({
      app: emailManifest.name,
      stage: 'test',
      deploymentId: 'd-email',
      hasServer: true,
      hasStatic: true,
      serverRoutes: ['/api/'],
      spa: true,
    }),
    staticDir: root,
  };

  beforeAll(async () => {
    stage = await startLocalStage({ root, manifest: emailManifest, stage: 'test', port: 3997 });
    router = await startLocalRouter({ port: 0, state: () => state, inbox });
    const port = (router.address() as AddressInfo).port;
    base = `http://127.0.0.1:${port}`;
    const spawned = await spawnWebServer(stage, emailManifest, root, {
      watch: false,
      mailUrl: localMailUrl(base),
    });
    server = spawned.child;
    let output = '';
    server.stdout?.on('data', (c) => (output += c));
    server.stderr?.on('data', (c) => (output += c));
    await waitForPort(spawned.port, '127.0.0.1', 30_000).catch((err) => {
      throw new Error(`${(err as Error).message}\n${output}`);
    });
    state.server = { host: '127.0.0.1', port: spawned.port };
  });

  afterAll(async () => {
    inbox.close();
    server?.kill('SIGTERM');
    router?.close();
    await stage?.stop();
  });

  const send = async (message: object) => {
    const res = await fetch(`${base}/api/send`, { method: 'POST', body: JSON.stringify(message) });
    return { status: res.status, body: (await res.json()) as { id?: string; reason?: string } };
  };

  it('binds the stage to its tenant in local mode', () => {
    expect(stage.bindings.email).toMatchObject({
      mode: 'local',
      name: 'Basic',
      tenant: 'basic-app--test',
      dailyLimit: 2,
      usageTable: stage.platform.telemetryTable,
    });
    expect(stage.bindings.email?.from).toMatch(/^basic-app--test@mail\./);
  });

  it('shows what the server sends in the inbox, and counts it against the daily limit', async () => {
    const sent = await send({
      to: ['alice@example.com'],
      subject: 'Welcome to Basic',
      text: 'Hello Alice',
      html: '<p>Hello <b>Alice</b></p>',
    });
    expect(sent.status).toBe(200);

    const list = (await (await fetch(`${base}${EMAIL_INBOX_PATH}/messages`)).json()) as {
      messages: CapturedEmail[];
    };
    expect(list.messages).toEqual([
      {
        id: sent.body.id,
        at: expect.any(String) as unknown,
        app: 'basic-app',
        stage: 'test',
        from: `"Basic" <${stage.bindings.email!.from}>`,
        // A reserved test domain: deployed stages would skip it, the inbox shows it.
        to: ['alice@example.com'],
        replyTo: [],
        subject: 'Welcome to Basic',
        text: 'Hello Alice',
        html: '<p>Hello <b>Alice</b></p>',
      },
    ]);
    const page = await (await fetch(`${base}${EMAIL_INBOX_PATH}`)).text();
    expect(page).toContain('Welcome to Basic');
    const body = await (await fetch(`${base}${EMAIL_INBOX_PATH}/${sent.body.id}/html`)).text();
    expect(body).toContain('<p>Hello <b>Alice</b></p>');

    // The limit is 2 recipients a day: one is left, so two more are refused and nothing arrives.
    const refused = await send({ to: ['b@example.com', 'c@example.com'], subject: 'Two', text: 'x' });
    expect(refused).toMatchObject({ status: 409, body: { reason: 'daily-limit' } });
    expect((await send({ to: 'b@example.com', subject: 'One more', text: 'x' })).status).toBe(200);
    expect(inbox.messages().map((m) => m.subject)).toEqual(['One more', 'Welcome to Basic']);
  });
});
