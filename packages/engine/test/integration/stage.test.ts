import {
  DescribeLogGroupsCommand,
  DescribeLogStreamsCommand,
  GetLogEventsCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import { DescribeTableCommand, DescribeTimeToLiveCommand } from '@aws-sdk/client-dynamodb';
import { ListTargetsByRuleCommand, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { GetRoleCommand, GetRolePolicyCommand } from '@aws-sdk/client-iam';
import {
  GetFunctionConfigurationCommand,
  GetFunctionEventInvokeConfigCommand,
  InvokeCommand,
} from '@aws-sdk/client-lambda';
import { GetScheduleCommand } from '@aws-sdk/client-scheduler';
import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import { GetParameterCommand } from '@aws-sdk/client-ssm';
import {
  names,
  newDeploymentId,
  type PlatformRuntimeConfig,
  parseManifest,
  type ResolvedManifest,
  readDeadLetter,
} from '@ericminassian/platform-core';
import { strToU8, zipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listEventSourceMappings, listPermissionIds } from '../../src/drivers/lambda.ts';
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
  if (event.__platform === 'job') {
    console.log('PLATFORM_TEST job ' + event.kind + ' ' + JSON.stringify(event.body));
    return;
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
  queues: { jobs: { maxAttempts: 2 } },
  events: ['thing.happened'],
  crons: { tick: '*/5 * * * *' },
  storage: ['files'],
  secrets: ['API_KEY'],
  env: { GREETING: 'hi' },
});
const stage = 'itest1';

/** The same app, with a queue, an event and a cron that each set their own memory or timeout. */
const ownFunctions = parseManifest({
  name: 'itest',
  db: true,
  auth: true,
  queues: { jobs: { memoryMb: 256, timeoutSeconds: 20 } },
  events: { 'thing.happened': { memoryMb: 256 } },
  crons: { tick: { schedule: '*/5 * * * *', timeoutSeconds: 30 } },
  storage: ['files'],
  secrets: ['API_KEY'],
  env: { GREETING: 'hi' },
});
const handlerFunctions = {
  queue: names.handlerFunction('itest', stage, 'queue', 'jobs'),
  event: names.handlerFunction('itest', stage, 'event', 'thing.happened'),
  cron: names.handlerFunction('itest', stage, 'cron', 'tick'),
};

describe.skipIf(!findEmulatorBinary() && !process.env.PLAT_EMULATOR_ENDPOINT)(
  'deployStage on the AWS Emulator',
  () => {
    let conn: EmulatorConnection;
    let engine: Engine;
    let platform: PlatformRuntimeConfig;
    let stageKey: string | undefined;
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
      // Lambda's default groups too, in case the emulator writes there.
      const defaults = await ctx.clients.logs.send(
        new DescribeLogGroupsCommand({ logGroupNamePrefix: `/aws/lambda/${names.base('itest', stage)}--` }),
      );
      for (const group of [
        names.logGroup('itest', stage, 'worker'),
        ...(defaults.logGroups ?? []).map((g) => g.logGroupName!),
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

    async function deploy(m: ResolvedManifest = manifest) {
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
        manifest: m,
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
      const jobs = result.bindings.jobs!;
      expect([jobs.queues, jobs.fns, jobs.attempts, jobs.group]).toEqual([
        ['jobs'],
        {},
        { 'queue:jobs': 2 },
        'itest--itest1',
      ]);
      expect(jobs.dead).toMatch(/itest--itest1--jobs--dead$/);
      expect(jobs.role).toMatch(/:role\/platform\/apps\/itest--itest1$/);
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
      expect(result.bindings.stageKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
      stageKey = result.bindings.stageKey;
      expect(result.route).toBeUndefined(); // external web mode: no route flip

      const ctx = engineContext(engine);
      const table = await ctx.clients.dynamodb.send(new DescribeTableCommand({ TableName: 'itest--itest1' }));
      expect((table.Table?.GlobalSecondaryIndexes ?? []).map((g) => g.IndexName!).toSorted()).toEqual([
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

    it('runs queue messages invoked the way the SDK sends them', async () => {
      const ctx = engineContext(engine);
      const resources = await engine.listStageResources('itest', stage);
      expect(resources.filter((r) => r.type === 'queue').map((r) => r.name)).toEqual([
        names.deadLetters('itest', stage),
      ]);
      await ctx.clients.lambda.send(
        new InvokeCommand({
          FunctionName: names.workerFunction('itest', stage),
          InvocationType: 'Event',
          Payload: new TextEncoder().encode(
            JSON.stringify({
              __platform: 'job',
              kind: 'queue',
              name: 'jobs',
              id: 'm1',
              attempt: 1,
              sentAt: 1,
              body: { n: 42 },
            }),
          ),
        }),
      );
      expect(await waitForLine('job queue {"n":42}')).toContain('PLATFORM_TEST job');
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
      expect(after.map((r) => `${r.type}:${r.name}`).toSorted()).toEqual(
        before.map((r) => `${r.type}:${r.name}`).toSorted(),
      );
      expect(again.bindings.revision).not.toBe('');
      expect(again.bindings.stageKey).toBe(stageKey);
    });

    /** Where each trigger points now. */
    async function triggers() {
      const ctx = engineContext(engine);
      // Mappings being deleted aren't listed.
      const mappings = async (fn: string) =>
        (await listEventSourceMappings(ctx, fn)).map((m) => m.sourceArn.split(':').pop());
      const grants = async (fn: string) =>
        (await listPermissionIds(ctx, fn)).filter((sid) => sid.startsWith('events-'));
      const rule = await ctx.clients.events.send(
        new ListTargetsByRuleCommand({
          Rule: names.eventRule('itest', stage, 'thing.happened'),
          EventBusName: names.eventBus('itest', stage),
        }),
      );
      const schedule = await ctx.clients.scheduler.send(
        new GetScheduleCommand({ GroupName: names.scheduleGroup('itest', stage), Name: 'tick' }),
      );
      const worker = names.workerFunction('itest', stage);
      const failures = await ctx.clients.lambda.send(
        new GetFunctionEventInvokeConfigCommand({ FunctionName: worker }),
      );
      const dead = names.deadLetters('itest', stage);
      return {
        workerMappings: await mappings(worker),
        queueFunctionMappings: await mappings(handlerFunctions.queue),
        workerGrants: await grants(worker),
        eventFunctionGrants: await grants(handlerFunctions.event),
        ruleTargets: rule.Targets?.map((t) => t.Arn!.split(':').pop()),
        scheduleTarget: schedule.Target?.Arn?.split(':').pop(),
        // Everything that gives up on a job sends it to the stage's dead-letter queue.
        deadLetters: [
          failures.DestinationConfig?.OnFailure?.Destination,
          rule.Targets?.[0]?.DeadLetterConfig?.Arn,
          schedule.Target?.DeadLetterConfig?.Arn,
        ].map((arn) => arn?.split(':').pop() === dead),
      };
    }

    it('runs handlers with their own memory or timeout in functions of their own', async () => {
      const ctx = engineContext(engine);
      const deployed = await deploy(ownFunctions);
      expect(deployed.workerFunction?.name).toBe(names.workerFunction('itest', stage));

      const functions = (await engine.listStageResources('itest', stage))
        .filter((r) => r.type === 'function')
        .map((r) => r.name)
        .toSorted();
      expect(functions).toEqual(
        [...Object.values(handlerFunctions), names.workerFunction('itest', stage)].toSorted(),
      );
      const config = await ctx.clients.lambda.send(
        new GetFunctionConfigurationCommand({ FunctionName: handlerFunctions.queue }),
      );
      expect([config.MemorySize, config.Timeout]).toEqual([256, 20]);
      expect(config.LoggingConfig?.LogGroup).toBe(names.logGroup('itest', stage, 'worker'));
      const cron = await ctx.clients.lambda.send(
        new GetFunctionConfigurationCommand({ FunctionName: handlerFunctions.cron }),
      );
      // The setting a handler doesn't set is the worker's (default 512 MB).
      expect([cron.MemorySize, cron.Timeout]).toEqual([512, 30]);

      expect(await triggers()).toEqual({
        workerMappings: [],
        queueFunctionMappings: [],
        workerGrants: [],
        eventFunctionGrants: ['events-itest--itest1--thing_happened'],
        ruleTargets: [handlerFunctions.event],
        scheduleTarget: handlerFunctions.cron,
        deadLetters: [true, true, true],
      });
      expect(deployed.bindings.jobs?.fns).toEqual({
        'queue:jobs': handlerFunctions.queue,
        'event:thing.happened': handlerFunctions.event,
        'cron:tick': handlerFunctions.cron,
      });

      const role = await ctx.clients.iam.send(
        new GetRolePolicyCommand({ RoleName: names.role('itest', stage), PolicyName: 'runtime' }),
      );
      expect(decodeURIComponent(role.PolicyDocument!)).toContain(`function:${handlerFunctions.queue}"`);
    });

    it('moves them back to the worker when their settings go, and removes their functions', async () => {
      await deploy();
      const functions = (await engine.listStageResources('itest', stage)).filter(
        (r) => r.type === 'function',
      );
      expect(functions.map((r) => r.name)).toEqual([names.workerFunction('itest', stage)]);
      const worker = names.workerFunction('itest', stage);
      expect(await triggers()).toEqual({
        workerMappings: [],
        queueFunctionMappings: [],
        workerGrants: ['events-itest--itest1--thing_happened'],
        eventFunctionGrants: [],
        ruleTargets: [worker],
        scheduleTarget: worker,
        deadLetters: [true, true, true],
      });
    });

    it('drains a queue from before 0.4.0 and moves its dead letters into the stage’s', async () => {
      const ctx = engineContext(engine);
      const legacy = (
        await ctx.clients.sqs.send(
          new CreateQueueCommand({ QueueName: names.legacyQueue('itest', stage, 'jobs') }),
        )
      ).QueueUrl!;
      const legacyDlq = (
        await ctx.clients.sqs.send(
          new CreateQueueCommand({ QueueName: names.legacyDeadLetterQueue('itest', stage, 'jobs') }),
        )
      ).QueueUrl!;
      await ctx.clients.sqs.send(new SendMessageCommand({ QueueUrl: legacy, MessageBody: '{"n":44}' }));
      await ctx.clients.sqs.send(new SendMessageCommand({ QueueUrl: legacyDlq, MessageBody: '{"n":45}' }));

      const deployed = await deploy();
      // The queue still held a message, so its mapping drains it into the worker.
      expect(await triggers()).toMatchObject({ workerMappings: [names.legacyQueue('itest', stage, 'jobs')] });
      expect(await waitForLine('queue {"n":44}')).toContain('PLATFORM_TEST queue');
      const moved = await ctx.clients.sqs.send(
        new ReceiveMessageCommand({ QueueUrl: deployed.bindings.jobs!.dead, WaitTimeSeconds: 2 }),
      );
      expect(readDeadLetter(moved.Messages![0]!.Body!)).toMatchObject({
        kind: 'queue',
        name: 'jobs',
        redrive: { body: { n: 45 } },
      });
      const gone = await ctx.clients.sqs
        .send(new GetQueueUrlCommand({ QueueName: names.legacyDeadLetterQueue('itest', stage, 'jobs') }))
        .then(
          () => undefined,
          (e: unknown) => (e as Error).name,
        );
      expect(gone).toMatch(/NonExistentQueue|QueueDoesNotExist/);

      // Once drained, the next deploy deletes it and its mapping.
      for (let i = 0; i < 30; i++) {
        const left = await ctx.clients.sqs.send(
          new GetQueueAttributesCommand({
            QueueUrl: legacy,
            AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
          }),
        );
        if (
          Number(left.Attributes?.ApproximateNumberOfMessages) +
            Number(left.Attributes?.ApproximateNumberOfMessagesNotVisible) ===
          0
        )
          break;
        await new Promise((r) => setTimeout(r, 1_000));
      }
      await deploy();
      expect(await triggers()).toMatchObject({ workerMappings: [] });
      const queues = (await engine.listStageResources('itest', stage)).filter((r) => r.type === 'queue');
      expect(queues.map((r) => r.name)).toEqual([names.deadLetters('itest', stage)]);
    });

    it('destroys everything for the stage, handlers’ own functions included', async () => {
      await deploy(ownFunctions);
      await engine.destroyStage({ app: 'itest', stage, platform });
      const left = await engine.listStageResources('itest', stage);
      expect(left).toEqual([]);
      await expect(
        engineContext(engine).clients.ssm.send(
          new GetParameterCommand({ Name: names.stageKeyParameter('itest', stage) }),
        ),
      ).rejects.toMatchObject({ name: 'ParameterNotFound' });
    });
  },
);
