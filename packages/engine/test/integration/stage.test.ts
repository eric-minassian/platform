import { DescribeLogStreamsCommand, GetLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { DescribeTableCommand, DescribeTimeToLiveCommand } from '@aws-sdk/client-dynamodb';
import { PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { GetRoleCommand } from '@aws-sdk/client-iam';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import {
  names,
  newDeploymentId,
  type PlatformRuntimeConfig,
  parseManifest,
} from '@eric-minassian/platform-core';
import { strToU8, zipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createEngine,
  type EmulatorConnection,
  type Engine,
  type EngineLogEntry,
  engineContext,
  ensureLocalPlatform,
  findEmulatorBinary,
  startEmulator,
} from '../../src/index.ts';

const WORKER = `
export const handler = async (event) => {
  if (Array.isArray(event.Records)) {
    for (const r of event.Records) console.log('PLATFORM_TEST queue ' + r.body);
    return { batchItemFailures: [] };
  }
  if (event['detail-type']) {
    console.log('PLATFORM_TEST event ' + event['detail-type'] + ' ' + JSON.stringify(event.detail));
    return;
  }
  console.log('PLATFORM_TEST direct ' + JSON.stringify(event));
  return { ok: true };
};
`;

const manifest = parseManifest({
  name: 'itest',
  db: true,
  auth: true,
  queues: { jobs: { batchSize: 5 } },
  events: ['thing.happened'],
  crons: { tick: '*/5 * * * *' },
  storage: ['files'],
  secrets: ['API_KEY'],
  env: { GREETING: 'hi' },
});
const stage = 'itest1';

describe.skipIf(!findEmulatorBinary() && !process.env.PLAT_EMULATOR_ENDPOINT)(
  'deployStage on the AWS Emulator',
  () => {
    let conn: EmulatorConnection;
    let engine: Engine;
    let platform: PlatformRuntimeConfig;
    const logs: EngineLogEntry[] = [];

    beforeAll(async () => {
      conn = await startEmulator({ idleTimeoutSeconds: 600 });
      engine = createEngine({
        region: conn.region,
        emulator: { endpoint: conn.endpoint, caFile: conn.caFile, credentials: conn.credentials },
        log: (e) => logs.push(e),
      });
      platform = await ensureLocalPlatform(engine, { port: 3000, jwksBaseUrl: conn.endpoint });
    });

    afterAll(async () => {
      await conn?.stop();
    });

    async function workerLines(): Promise<string[]> {
      const ctx = engineContext(engine);
      const out: string[] = [];
      for (const group of [
        names.logGroup('itest', stage, 'worker'),
        `/aws/lambda/${names.workerFunction('itest', stage)}`,
      ]) {
        const streams = await ctx.clients.logs
          .send(new DescribeLogStreamsCommand({ logGroupName: group }))
          .catch(() => ({ logStreams: [] }));
        for (const s of streams.logStreams ?? []) {
          const ev = await ctx.clients.logs.send(
            new GetLogEventsCommand({
              logGroupName: group,
              logStreamName: s.logStreamName,
              startFromHead: true,
            }),
          );
          for (const e of ev.events ?? []) if (e.message?.includes('PLATFORM_TEST')) out.push(e.message);
        }
      }
      return out;
    }

    async function waitForLine(match: string, timeoutMs = 60_000): Promise<string> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const line = (await workerLines()).find((l) => l.includes(match));
        if (line) return line;
        if (Date.now() > deadline) throw new Error(`no worker log line matching "${match}"`);
        await new Promise((r) => setTimeout(r, 1_000));
      }
    }

    async function deploy() {
      const deploymentId = newDeploymentId();
      const zip = zipSync({ 'index.mjs': strToU8(WORKER) });
      const worker = await engine.putArtifact(
        platform,
        names.artifactKey('itest', stage, deploymentId, 'worker.zip'),
        zip,
      );
      const staticZip = zipSync({
        'index.html': strToU8('<h1>hi</h1>'),
        'assets/app-AbC12345.js': strToU8('1'),
      });
      const stat = await engine.putArtifact(
        platform,
        names.artifactKey('itest', stage, deploymentId, 'static.zip'),
        staticZip,
      );
      return engine.deployStage({
        manifest,
        stage,
        deploymentId,
        platform,
        artifacts: { worker, static: stat },
        webMode: 'external',
      });
    }

    it('provisions a stage and wires its triggers', async () => {
      const result = await deploy();
      expect(result.host).toBe('itest--itest1.localhost');
      expect(result.url).toBe('http://itest--itest1.localhost:3000');
      expect(result.bindings.table).toBe('itest--itest1');
      expect(Object.keys(result.bindings.queues)).toEqual(['jobs']);
      expect(result.bindings.auth?.mode).toBe('local');
      expect(result.bindings.auth?.jwksUri).toBe(
        `${conn.endpoint}/${platform.userPoolId}/.well-known/jwks.json`,
      );
      expect(result.bindings.storage).toEqual({
        bucket: platform.storageBucket,
        prefix: 'itest/itest1/',
        stores: ['files'],
      });
      expect(result.bindings.worker).toBe('itest--itest1--worker');
      expect(result.route).toBeUndefined(); // external web mode: no route flip

      const ctx = engineContext(engine);
      const table = await ctx.clients.dynamodb.send(new DescribeTableCommand({ TableName: 'itest--itest1' }));
      expect((table.Table?.GlobalSecondaryIndexes ?? []).map((g) => g.IndexName).sort()).toEqual([
        'gsi1',
        'gsi2',
        'gsi3',
      ]);
      const ttl = await ctx.clients.dynamodb.send(
        new DescribeTimeToLiveCommand({ TableName: 'itest--itest1' }),
      );
      expect(ttl.TimeToLiveDescription?.AttributeName).toBe('_ttl');

      const role = await ctx.clients.iam.send(new GetRoleCommand({ RoleName: 'itest--itest1' }));
      expect(role.Role?.Path).toBe('/platform/apps/');
    });

    it('delivers queue messages to the worker', async () => {
      const ctx = engineContext(engine);
      const queueUrl = (await engine.listStageResources('itest', stage)).find(
        (r) => r.name === 'itest--itest1--jobs',
      );
      expect(queueUrl).toBeDefined();
      const deployed = await deploy();
      await ctx.clients.sqs.send(
        new SendMessageCommand({ QueueUrl: deployed.bindings.queues.jobs!.url, MessageBody: '{"n":42}' }),
      );
      const line = await waitForLine('queue {"n":42}');
      expect(line).toContain('PLATFORM_TEST queue');
    });

    it('delivers published events to the worker', async () => {
      const ctx = engineContext(engine);
      await ctx.clients.events.send(
        new PutEventsCommand({
          Entries: [
            {
              EventBusName: names.eventBus('itest', stage),
              Source: 'platform.itest',
              DetailType: 'thing.happened',
              Detail: JSON.stringify({ data: { id: 7 }, trace: 't1' }),
            },
          ],
        }),
      );
      const line = await waitForLine('event thing.happened');
      expect(line).toContain('"id":7');
    });

    it('redeploys idempotently and keeps the last static deployments', async () => {
      const before = await engine.listStageResources('itest', stage);
      const again = await deploy();
      const after = await engine.listStageResources('itest', stage);
      expect(after.map((r) => `${r.type}:${r.name}`).sort()).toEqual(
        before.map((r) => `${r.type}:${r.name}`).sort(),
      );
      expect(again.bindings.revision).not.toBe('');
    });

    it('destroys everything for the stage', async () => {
      await engine.destroyStage({ app: 'itest', stage, platform });
      const left = await engine.listStageResources('itest', stage);
      expect(left).toEqual([]);
    });
  },
);
