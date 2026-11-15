import { type ChildProcess, spawn } from 'node:child_process';
import { resolve } from 'node:path';
import {
  EventBridgeClient,
  ListRulesCommand,
  ListTargetsByRuleCommand,
  PutTargetsCommand,
  RemoveTargetsCommand,
} from '@aws-sdk/client-eventbridge';
import {
  LambdaClient,
  ListEventSourceMappingsCommand,
  UpdateEventSourceMappingCommand,
} from '@aws-sdk/client-lambda';
import {
  CreateQueueCommand,
  DeleteMessageBatchCommand,
  GetQueueAttributesCommand,
  type Message,
  ReceiveMessageCommand,
  SetQueueAttributesCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { LOCAL_MAIL_URL_ENV, names, type ResolvedManifest } from '@ericminassian/platform-core';
import { SDK_WORKER } from '../build.ts';
import { resolveFromApp } from '../project.ts';
import { freePort, waitForPort } from '../util/net.ts';
import { tsxArgs } from './entries.ts';
import { emulatorClientConfig, type LocalStage, localEnv } from './local-stage.ts';
import { killTree } from './proc.ts';

/**
 * Local worker: the app's worker in a real Node process (see worker-host.ts
 * for why), fed by a dispatcher that does what Lambda's event sources would:
 * polls each SQS queue (batches, partial failures, retries via visibility
 * timeout, DLQ via the queue's redrive policy), receives EventBridge events
 * through a tap queue, and runs crons on demand.
 */
export interface InvokeResult {
  ok: boolean;
  result?: unknown;
  error?: { name: string; message: string; stack?: string };
}

export interface LocalWorker {
  port: number;
  child: ChildProcess;
  invoke(event: unknown): Promise<InvokeResult>;
  stop(): void;
}

export async function startLocalWorker(
  stage: LocalStage,
  manifest: ResolvedManifest,
  root: string,
  opts: {
    watch?: boolean;
    /** `PLATFORM_LOCAL_MAIL_URL`: the local inbox the SDK posts mail to. */
    mailUrl?: string;
  } = {},
): Promise<LocalWorker> {
  if (!manifest.worker) throw new Error('manifest has no worker');
  const port = await freePort();
  const env = localEnv(stage, manifest, {
    PLATFORM_WORKER_ENTRY: resolve(root, manifest.worker.entry),
    PLATFORM_SDK_WORKER: resolveFromApp(root, SDK_WORKER),
    PLATFORM_WORKER_PORT: String(port),
    PLATFORM_WORKER_TIMEOUT_MS: String(manifest.worker.timeoutSeconds * 1000),
    PLATFORM_WORKER_FUNCTION:
      stage.result.workerFunction?.name ?? names.workerFunction(manifest.name, stage.stage),
    PLATFORM_LOG_PRETTY: '1',
    ...(opts.mailUrl ? { [LOCAL_MAIL_URL_ENV]: opts.mailUrl } : {}),
  });
  const child = spawn(process.execPath, tsxArgs('worker-host', opts.watch !== false), {
    cwd: root,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForPort(port, '127.0.0.1', 60_000);
  return {
    port,
    child,
    async invoke(event) {
      // tsx watch restarts the host on edits; wait for it to come back.
      await waitForPort(port, '127.0.0.1', 30_000);
      const res = await fetch(`http://127.0.0.1:${port}/`, { method: 'POST', body: JSON.stringify(event) });
      return (await res.json()) as InvokeResult;
    },
    stop() {
      killTree(child);
    },
  };
}

export type DispatchLog = (
  kind: 'queue' | 'event' | 'cron',
  name: string,
  outcome: 'ok' | 'error',
  detail?: string,
) => void;

export interface Dispatcher {
  runCron(name: string): Promise<InvokeResult>;
  stop(): void;
}

export async function startWorkerDispatch(
  stage: LocalStage,
  manifest: ResolvedManifest,
  worker: Pick<LocalWorker, 'invoke'>,
  log: DispatchLog = () => {},
): Promise<Dispatcher> {
  const cfg = emulatorClientConfig(stage.conn);
  const sqs = new SQSClient(cfg);
  const lambda = new LambdaClient(cfg);
  const events = new EventBridgeClient(cfg);
  const functionName = stage.result.workerFunction?.name;
  let stopped = false;

  // The emulator's own event source mappings would hand messages to its sandboxed runtime; turn them off.
  if (functionName) {
    const esms = await lambda
      .send(new ListEventSourceMappingsCommand({ FunctionName: functionName }))
      .catch(() => undefined);
    for (const m of esms?.EventSourceMappings ?? []) {
      if (m.UUID && m.State !== 'Disabled') {
        await lambda
          .send(new UpdateEventSourceMappingCommand({ UUID: m.UUID, Enabled: false }))
          .catch(() => undefined);
      }
    }
  }

  const loops: Array<Promise<void>> = [];
  for (const [name, q] of Object.entries(stage.bindings.queues)) {
    const batchSize = manifest.queues[name]?.batchSize ?? 10;
    loops.push(
      pollQueue(
        sqs,
        q.url,
        batchSize,
        () => stopped,
        async (messages) => {
          const r = await worker.invoke(sqsEvent(messages, q.arn, stage.conn.region));
          const failed = new Set(
            r.ok
              ? (
                  (r.result as { batchItemFailures?: Array<{ itemIdentifier: string }> } | null)
                    ?.batchItemFailures ?? []
                ).map((f) => f.itemIdentifier)
              : messages.map((m) => m.MessageId!),
          );
          log(
            'queue',
            name,
            failed.size ? 'error' : 'ok',
            r.ok ? (failed.size ? `${failed.size} failed` : undefined) : r.error?.message,
          );
          return messages.filter((m) => !failed.has(m.MessageId!));
        },
      ),
    );
  }

  if (functionName && stage.bindings.bus) {
    const tapUrl = await tapEventRules(sqs, events, stage, functionName);
    if (tapUrl) {
      loops.push(
        pollQueue(
          sqs,
          tapUrl,
          1,
          () => stopped,
          async (messages) => {
            const done: Message[] = [];
            for (const m of messages) {
              const event = JSON.parse(m.Body ?? '{}') as { 'detail-type'?: string };
              const attempts = Number(m.Attributes?.ApproximateReceiveCount ?? '1');
              const r = await worker.invoke(event);
              log('event', event['detail-type'] ?? '?', r.ok ? 'ok' : 'error', r.error?.message);
              // Lambda async invokes retry twice, then drop: same here.
              if (r.ok || attempts >= 3) done.push(m);
            }
            return done;
          },
          5,
        ),
      );
    }
  }

  return {
    async runCron(name) {
      const r = await worker.invoke({ __platform: 'cron', name });
      log('cron', name, r.ok ? 'ok' : 'error', r.error?.message);
      return r;
    },
    stop() {
      stopped = true;
      sqs.destroy();
      lambda.destroy();
      events.destroy();
    },
  };
}

/** Lambda's SQS event shape. */
export function sqsEvent(messages: Message[], queueArn: string, region: string) {
  return {
    Records: messages.map((m) => ({
      messageId: m.MessageId,
      receiptHandle: m.ReceiptHandle,
      body: m.Body ?? '',
      attributes: m.Attributes ?? {},
      messageAttributes: Object.fromEntries(
        Object.entries(m.MessageAttributes ?? {}).map(([k, v]) => [
          k,
          {
            stringValue: v.StringValue,
            binaryValue: v.BinaryValue,
            dataType: v.DataType,
            stringListValues: [],
            binaryListValues: [],
          },
        ]),
      ),
      md5OfBody: m.MD5OfBody,
      eventSource: 'aws:sqs',
      eventSourceARN: queueArn,
      awsRegion: region,
    })),
  };
}

/**
 * Re-point the stage's EventBridge rules from the (sandboxed) emulator Lambda
 * to a tap queue the dispatcher polls. Returns the tap queue URL.
 */
async function tapEventRules(
  sqs: SQSClient,
  events: EventBridgeClient,
  stage: LocalStage,
  functionName: string,
): Promise<string | null> {
  const bus = stage.bindings.bus!.name;
  const rules =
    (await events.send(new ListRulesCommand({ EventBusName: bus })).catch(() => undefined))?.Rules ?? [];
  if (rules.length === 0) return null;
  const tapName = `${names.base(stage.bindings.app, stage.stage)}--plat-dev-events`;
  const tapUrl = (await sqs.send(new CreateQueueCommand({ QueueName: tapName }))).QueueUrl!;
  const tapArn = (
    await sqs.send(new GetQueueAttributesCommand({ QueueUrl: tapUrl, AttributeNames: ['QueueArn'] }))
  ).Attributes!.QueueArn!;
  await sqs.send(
    new SetQueueAttributesCommand({
      QueueUrl: tapUrl,
      Attributes: {
        Policy: JSON.stringify({
          Version: '2012-10-17',
          Statement: [
            {
              Effect: 'Allow',
              Principal: { Service: 'events.amazonaws.com' },
              Action: 'sqs:SendMessage',
              Resource: tapArn,
            },
          ],
        }),
      },
    }),
  );
  for (const rule of rules) {
    if (!rule.Name) continue;
    const targets =
      (await events.send(new ListTargetsByRuleCommand({ Rule: rule.Name, EventBusName: bus }))).Targets ?? [];
    const lambdaTargets = targets.filter((t) => t.Arn?.includes(`:function:${functionName}`));
    if (lambdaTargets.length === 0) continue;
    await events.send(
      new RemoveTargetsCommand({ Rule: rule.Name, EventBusName: bus, Ids: lambdaTargets.map((t) => t.Id!) }),
    );
    await events.send(
      new PutTargetsCommand({
        Rule: rule.Name,
        EventBusName: bus,
        Targets: [{ Id: 'plat-dev-tap', Arn: tapArn }],
      }),
    );
  }
  return tapUrl;
}

/** Long-poll a queue; `handle` returns the messages to delete. */
async function pollQueue(
  sqs: SQSClient,
  url: string,
  batchSize: number,
  stopped: () => boolean,
  handle: (messages: Message[]) => Promise<Message[]>,
  waitSeconds = 5,
): Promise<void> {
  while (!stopped()) {
    let messages: Message[] = [];
    try {
      messages =
        (
          await sqs.send(
            new ReceiveMessageCommand({
              QueueUrl: url,
              MaxNumberOfMessages: batchSize,
              WaitTimeSeconds: waitSeconds,
              MessageSystemAttributeNames: ['All'],
              MessageAttributeNames: ['All'],
            }),
          )
        ).Messages ?? [];
    } catch {
      if (stopped()) return;
      await new Promise((r) => setTimeout(r, 1_000));
      continue;
    }
    if (messages.length === 0) continue;
    try {
      const done = await handle(messages);
      if (done.length) {
        await sqs.send(
          new DeleteMessageBatchCommand({
            QueueUrl: url,
            Entries: done.map((m, i) => ({ Id: String(i), ReceiptHandle: m.ReceiptHandle! })),
          }),
        );
      }
    } catch {
      // Leave the messages; they become visible again after the visibility timeout.
    }
  }
}
