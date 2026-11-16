import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import {
  EventBridgeClient,
  ListRulesCommand,
  ListTargetsByRuleCommand,
  PutTargetsCommand,
  RemoveTargetsCommand,
} from '@aws-sdk/client-eventbridge';
import {
  CreateQueueCommand,
  DeleteMessageBatchCommand,
  GetQueueAttributesCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  SetQueueAttributesCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import {
  type HandlerKind,
  handlerFunctionName,
  handlerSettings,
  type JobPayload,
  LOCAL_MAIL_URL_ENV,
  names,
  type ResolvedManifest,
  toJob,
} from '@ericminassian/platform-core';
import { SDK_WORKER } from '../build.ts';
import { resolveFromApp } from '../project.ts';
import { freePort, waitForPort } from '../util/net.ts';
import { tsxArgs } from './entries.ts';
import { emulatorClientConfig, type LocalStage, localEnv } from './local-stage.ts';
import { killTree } from './proc.ts';

/**
 * Local worker: the app's worker in a real Node process (see worker-host.ts
 * for why), fed by a dispatcher that does what Lambda and Scheduler would for
 * a deployed stage (`startWorkerDispatch`). One process runs every handler,
 * each invoked as the function it runs in when deployed (its name, timeout
 * and memory).
 */
export interface InvokeResult {
  ok: boolean;
  result?: unknown;
  error?: { name: string; message: string; stack?: string };
}

/** A queue, event or cron handler; anything else is invoked as the worker's own function. */
export interface HandlerRef {
  kind: HandlerKind;
  name: string;
}

export interface LocalWorker {
  port: number;
  child: ChildProcess;
  invoke(event: unknown, handler?: HandlerRef): Promise<InvokeResult>;
  stop(): void;
}

/** Headers that tell worker-host.ts which function an invocation stands for. */
const INVOKE_HEADERS = {
  function: 'x-platform-function',
  timeoutMs: 'x-platform-timeout-ms',
  memoryMb: 'x-platform-memory-mb',
} as const;

export async function startLocalWorker(
  stage: LocalStage,
  manifest: ResolvedManifest,
  root: string,
  opts: {
    watch?: boolean;
    /** `PLATFORM_LOCAL_MAIL_URL`: the local inbox the SDK posts mail to. */
    mailUrl?: string;
    /** `PLATFORM_LOCAL_WORKER_URL`: the dispatcher, where the worker's retries and sends go. */
    jobsUrl?: string;
  } = {},
): Promise<LocalWorker> {
  if (!manifest.worker) throw new Error('manifest has no worker');
  const port = await freePort();
  const env = localEnv(stage, manifest, {
    PLATFORM_WORKER_ENTRY: resolve(root, manifest.worker.entry),
    PLATFORM_SDK_WORKER: resolveFromApp(root, SDK_WORKER),
    PLATFORM_WORKER_PORT: String(port),
    PLATFORM_WORKER_TIMEOUT_MS: String(manifest.worker.timeoutSeconds * 1000),
    PLATFORM_WORKER_MEMORY_MB: String(manifest.worker.memoryMb),
    PLATFORM_WORKER_FUNCTION:
      stage.result.workerFunction?.name ?? names.workerFunction(manifest.name, stage.stage),
    PLATFORM_LOG_PRETTY: '1',
    ...(opts.mailUrl ? { [LOCAL_MAIL_URL_ENV]: opts.mailUrl } : {}),
    ...(opts.jobsUrl ? { PLATFORM_LOCAL_WORKER_URL: opts.jobsUrl } : {}),
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
    async invoke(event, handler) {
      // tsx watch restarts the host on edits; wait for it to come back.
      await waitForPort(port, '127.0.0.1', 30_000);
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        method: 'POST',
        body: JSON.stringify(event),
        headers: handler ? invokeHeaders(stage, manifest, handler) : {},
      });
      return (await res.json()) as InvokeResult;
    },
    stop() {
      killTree(child);
    },
  };
}

function invokeHeaders(stage: LocalStage, manifest: ResolvedManifest, handler: HandlerRef) {
  const settings = handlerSettings(manifest, handler.kind, handler.name);
  return {
    [INVOKE_HEADERS.function]: handlerFunctionName(
      manifest.name,
      stage.stage,
      manifest,
      handler.kind,
      handler.name,
    ),
    [INVOKE_HEADERS.timeoutMs]: String(settings.timeoutSeconds * 1000),
    [INVOKE_HEADERS.memoryMb]: String(settings.memoryMb),
  };
}

export type DispatchLog = (
  kind: 'queue' | 'event' | 'cron' | 'invoke',
  name: string,
  outcome: 'ok' | 'error',
  detail?: string,
) => void;

export interface Dispatcher {
  /**
   * Where the SDK hands jobs and invokes (`PLATFORM_LOCAL_WORKER_URL`): the
   * server, services and the worker itself (retries) post here.
   */
  url: string;
  runCron(name: string): Promise<InvokeResult>;
  /** Jobs waiting for their time: retries and delayed sends. */
  pending(): number;
  stop(): void;
}

/** What the SDK sets on a job due later (`LOCAL_DELIVER_AT_HEADER` in its runtime/jobs.ts). */
const DELIVER_AT_HEADER = 'x-platform-deliver-at';

/** `setTimeout` takes at most ~24.8 days; longer waits are chained. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * Does what Lambda and Scheduler do for a deployed stage: runs each job the
 * SDK hands over (now, or once its time comes), runs EventBridge events
 * through a tap queue, and fires crons on demand. Waiting jobs live here, not
 * in the worker process, so they survive its restarts on edits (not `plat
 * dev`'s own). A job whose run crashed goes to the dead-letter queue the way
 * Lambda's on-failure destination would put it there.
 */
export async function startWorkerDispatch(
  stage: LocalStage,
  manifest: ResolvedManifest,
  worker: Pick<LocalWorker, 'invoke'>,
  log: DispatchLog = () => {},
  opts: { port?: number } = {},
): Promise<Dispatcher> {
  const cfg = emulatorClientConfig(stage.conn);
  const sqs = new SQSClient(cfg);
  const events = new EventBridgeClient(cfg);
  const functionName = stage.result.workerFunction?.name;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let stopped = false;

  const crashed = async (job: JobPayload, error: InvokeResult['error']) => {
    const dead = stage.bindings.jobs?.dead;
    if (!dead) return;
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: dead,
        MessageBody: JSON.stringify({
          version: '1.0',
          timestamp: new Date().toISOString(),
          requestContext: { condition: 'RetriesExhausted', approximateInvokeCount: 1 },
          requestPayload: job,
          responsePayload: { errorType: error?.name ?? 'Error', errorMessage: error?.message ?? 'crashed' },
        }),
      }),
    );
  };

  const run = async (job: JobPayload) => {
    if (!manifest.worker) return;
    const r = await worker.invoke(job, { kind: job.kind, name: job.name });
    log(job.kind, job.name, r.ok ? 'ok' : 'error', r.error?.message);
    if (!r.ok) await crashed(job, r.error);
  };

  const runAt = (job: JobPayload, at: number) => {
    const timer = setTimeout(
      () => {
        timers.delete(timer);
        if (stopped) return;
        if (at > Date.now()) runAt(job, at);
        else void run(job).catch((err: unknown) => log(job.kind, job.name, 'error', (err as Error).message));
      },
      Math.max(0, Math.min(at - Date.now(), MAX_TIMER_MS)),
    );
    timers.add(timer);
  };

  const intake = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let payload: unknown;
      try {
        payload = JSON.parse(body || '{}');
      } catch {
        res.writeHead(400).end();
        return;
      }
      const job = toJob(payload, randomUUID(), Date.now());
      if (job) {
        // Like an async invoke: accepted now, run on its own.
        res.writeHead(202).end();
        const at = Number(req.headers[DELIVER_AT_HEADER] ?? 0);
        runAt(job, Math.max(at, Date.now()));
        return;
      }
      // A direct invoke (`invokeJob`, the control plane's `call`): answered with the worker's reply.
      void (async () => {
        const r = await worker.invoke(payload);
        log('invoke', (payload as { name?: string }).name ?? '?', r.ok ? 'ok' : 'error', r.error?.message);
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(r));
      })();
    });
  });
  const port = opts.port ?? (await freePort());
  await new Promise<void>((listening) => intake.listen(port, '127.0.0.1', listening));

  if (functionName && stage.bindings.bus) {
    const tapUrl = await tapEventRules(sqs, events, stage);
    if (tapUrl) {
      void pollQueue(
        sqs,
        tapUrl,
        1,
        () => stopped,
        async (messages) => {
          for (const m of messages) {
            const job = toJob(JSON.parse(m.Body ?? '{}'), m.MessageId ?? randomUUID(), Date.now());
            if (job) await run(job);
          }
          return messages;
        },
        5,
      );
    }
  }

  return {
    url: `http://127.0.0.1:${port}/`,
    async runCron(name) {
      const r = await worker.invoke({ __platform: 'cron', name }, { kind: 'cron', name });
      log('cron', name, r.ok ? 'ok' : 'error', r.error?.message);
      return r;
    },
    pending: () => timers.size,
    stop() {
      stopped = true;
      for (const t of timers) clearTimeout(t);
      timers.clear();
      intake.close();
      sqs.destroy();
      events.destroy();
    },
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
): Promise<string | null> {
  const bus = stage.bindings.bus!.name;
  const rules =
    (await events.send(new ListRulesCommand({ EventBusName: bus })).catch(() => undefined))?.Rules ?? [];
  if (rules.length === 0) return null;
  const tapName = names.devEventTap(stage.bindings.app, stage.stage);
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
    // Every function under the stage's base is the worker's or a handler's own.
    const base = names.base(stage.bindings.app, stage.stage);
    const lambdaTargets = targets.filter((t) => t.Arn?.includes(`:function:${base}--`));
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
