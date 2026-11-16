/**
 * Test helpers for apps and the SDK itself.
 *
 *   import { useTestBindings, captureTelemetry } from '@ericminassian/platform/testing';
 *
 * For tests against real (emulated) resources use `plat test`, which starts
 * the AWS Emulator, provisions the app and sets PLATFORM_BINDINGS for vitest.
 */
import {
  type Bindings,
  type CapturedEmail,
  type DeadLetter,
  EMAIL_INBOX_PATH,
  type JobPayload,
  LOCAL_MAIL_URL_ENV,
  newId,
  type TelemetryEvent,
  VIEWER_ADDRESS_HEADER,
  VIEWER_COUNTRY_HEADER,
} from '@ericminassian/platform-core';
import { clientInfoFromHeaders } from './client-info.ts';
import { setBindings } from './runtime/bindings.ts';
import { resetClients, type SendClient, setClient } from './runtime/clients.ts';
import { setEmailCapture } from './runtime/email.ts';
import { setRealtimeTransport } from './runtime/realtime.ts';
import { clearSecretsCache } from './runtime/secrets.ts';
import { setTelemetrySink, uninstallInstrumentation } from './runtime/telemetry.ts';

export type { CapturedEmail } from '@ericminassian/platform-core';
export type { SendClient } from './runtime/clients.ts';
export { createPlatformFetch } from './runtime/server.ts';
export { createWorkerHandler } from './runtime/worker.ts';

/** Complete bindings with sensible test defaults. */
export function testBindings(overrides: Partial<Bindings> = {}): Bindings {
  return {
    v: 2,
    app: 'test-app',
    stage: 'test',
    host: 'test-app.localhost',
    url: 'http://test-app.localhost:3000',
    revision: 'dtest',
    region: 'us-east-1',
    account: '000000000000',
    secrets: {
      path: '/platform/apps/test-app/test/secrets/',
      sharedPath: '/platform/apps/test-app/_shared/secrets/',
      names: [],
    },
    stageKey: 'dGVzdC1vbmx5LXN0YWdlLWtleS1ub3QtYS1zZWNyZXQ',
    worker: 'test-app--test--worker',
    jobs: {
      queues: [],
      fns: {},
      attempts: {},
      dead: 'https://sqs.us-east-1.amazonaws.com/000000000000/test-app--test--jobs--dead',
      group: 'test-app--test',
      role: 'arn:aws:iam::000000000000:role/platform/apps/test-app--test',
    },
    ...overrides,
  };
}

/**
 * A queue message as the worker receives it, for feeding `createWorkerHandler`
 * in tests: `await handler(queueJob('emails', body), {})`. `attempt` is which
 * delivery it is (default 1).
 */
export function queueJob(queue: string, body: unknown, attempt = 1): JobPayload {
  return { __platform: 'job', kind: 'queue', name: queue, id: newId('m'), attempt, sentAt: Date.now(), body };
}

/** What jobs code started instead of reaching AWS: see `captureJobs`. */
export interface CapturedJobs {
  /** Jobs run now (queue sends, `Jobs.invoke`), with the function they went to. */
  sent: Array<{ function: string; job: unknown }>;
  /** Retries and delayed sends, with when they run. */
  scheduled: Array<{ job: JobPayload; at: Date }>;
  /** Jobs that failed their last attempt. */
  dead: DeadLetter[];
}

/**
 * Records queue sends, retries, delayed sends and dead letters in memory
 * instead of invoking Lambda, creating schedules or writing to SQS. A worker
 * handler's failed run shows up in `scheduled` (attempts left) or `dead`.
 */
export function captureJobs(): CapturedJobs {
  const captured: CapturedJobs = { sent: [], scheduled: [], dead: [] };
  const decode = (bytes: unknown) => JSON.parse(new TextDecoder().decode(bytes as Uint8Array)) as unknown;
  mockClient('lambda', (cmd) => {
    captured.sent.push({ function: String(cmd.input.FunctionName), job: decode(cmd.input.Payload) });
    return { StatusCode: 202 };
  });
  mockClient('scheduler', (cmd) => {
    const target = cmd.input.Target as { Input: string };
    const at = /^at\((.+)\)$/.exec(String(cmd.input.ScheduleExpression))?.[1];
    captured.scheduled.push({ job: JSON.parse(target.Input) as JobPayload, at: new Date(`${at}Z`) });
    return {};
  });
  mockClient('sqs', (cmd) => {
    if (cmd.constructor.name === 'SendMessageCommand')
      captured.dead.push(JSON.parse(String(cmd.input.MessageBody)) as DeadLetter);
    return {};
  });
  return captured;
}

/** Install bindings for the current test process (returns them). */
export function useTestBindings(overrides: Partial<Bindings> = {}): Bindings {
  const b = testBindings(overrides);
  setBindings(b);
  return b;
}

/**
 * The headers the edge adds for a client at `ip` (IPv4 or IPv6), so
 * `clientInfo` sees it: `new Request(url, { headers: clientHeaders('203.0.113.7') })`.
 */
export function clientHeaders(ip: string, options: { country?: string } = {}): Record<string, string> {
  const headers: Record<string, string> = {
    [VIEWER_ADDRESS_HEADER]: `${ip}:50000`,
    ...(options.country ? { [VIEWER_COUNTRY_HEADER]: options.country } : {}),
  };
  if (!clientInfoFromHeaders(headers)) throw new Error(`clientHeaders: ${ip} is not an IP address`);
  return headers;
}

/** Replace an AWS client with a fake `{ send(command) }`. */
export function mockClient(
  name: 'ddb' | 'sqs' | 'events' | 's3' | 'ssm' | 'lambda' | 'scheduler' | 'cognito' | 'sesv2',
  send: (command: { constructor: { name: string }; input: Record<string, unknown> }) => unknown,
): SendClient {
  const fake: SendClient = {
    send: async (command) =>
      send(command as { constructor: { name: string }; input: Record<string, unknown> }),
  };
  setClient(name, fake);
  return fake;
}

/** Collect telemetry events instead of writing them to stdout. Call `stop()` to restore. */
export function captureTelemetry(): { events: TelemetryEvent[]; stop(): void } {
  const events: TelemetryEvent[] = [];
  setTelemetrySink((e) => events.push(e));
  return { events, stop: () => setTelemetrySink(null) };
}

/** An event the `Realtime` service sent, as subscribers would receive it (after a JSON round trip). */
export interface CapturedRealtimeEvent {
  channel: string;
  event: unknown;
}

/**
 * Record what `Realtime` publishes instead of sending it to AppSync. Channels
 * are still checked against the bindings' `realtime` (see `testBindings`).
 * Call `stop()` to restore.
 */
export function captureRealtime(): { published: CapturedRealtimeEvent[]; stop(): void } {
  const published: CapturedRealtimeEvent[] = [];
  setRealtimeTransport(async (r, path, events) => {
    const channel = path.slice(r.namespace.length + 2);
    for (const e of events) published.push({ channel, event: JSON.parse(e) });
  });
  return { published, stop: () => setRealtimeTransport(undefined) };
}

/**
 * Record what `Email.send` sends instead of delivering it: no SES, no local
 * inbox and no daily count (`Platform.layerMemory({ email })` tests the limit).
 * Messages are still checked, and the bindings need `email`, as deployed.
 * Call `stop()` to restore.
 */
export function captureEmails(): { sent: CapturedEmail[]; stop(): void } {
  const sent: CapturedEmail[] = [];
  setEmailCapture((mail) => void sent.push(mail));
  return { sent, stop: () => setEmailCapture(undefined) };
}

/** The `plat test` / `plat dev` inbox's message list (`GET` on `PLATFORM_LOCAL_MAIL_URL`). */
export interface LocalInboxList {
  /** Newest first. */
  messages: CapturedEmail[];
}

function localMailUrl(): string {
  const url = process.env[LOCAL_MAIL_URL_ENV];
  if (!url)
    throw new Error(
      `${LOCAL_MAIL_URL_ENV} is not set: the local inbox (${EMAIL_INBOX_PATH}) exists under \`plat test\` and \`plat dev\`.`,
    );
  return url;
}

/** What `Email.send` delivered under `plat test` (or `plat dev`), newest first. */
export async function localInbox(): Promise<CapturedEmail[]> {
  const url = localMailUrl();
  const res = await fetch(url);
  if (!res.ok) throw new Error(`the local inbox at ${url} answered ${res.status}`);
  return ((await res.json()) as LocalInboxList).messages;
}

/**
 * The newest message in the local inbox that `match` accepts, waiting for one
 * to arrive (mail sent by the worker gets there a moment after the request).
 */
export async function waitForEmail(
  match: (mail: CapturedEmail) => boolean,
  options: { readonly timeoutMs?: number } = {},
): Promise<CapturedEmail> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = (await localInbox()).find(match);
    if (found) return found;
    if (Date.now() >= deadline)
      throw new Error(`no matching message reached the local inbox within ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Reset all SDK module state (bindings, clients, caches, telemetry sink, realtime and email capture). */
export function resetPlatform(): void {
  setBindings(undefined);
  setRealtimeTransport(undefined);
  setEmailCapture(undefined);
  resetClients();
  clearSecretsCache();
  setTelemetrySink(null);
  uninstallInstrumentation();
}
