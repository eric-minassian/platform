// Local worker host for `plat dev` / `plat test`. The AWS Emulator's Lambda
// runtime is an embedded JS sandbox without node:http/https/net/async_hooks,
// so a worker that talks to AWS (through the SDK) can't run inside it. This
// process runs the worker in real Node instead: it builds the same handler the
// Lambda would (`createWorkerHandler(def)` from the app's SDK) and accepts
// Lambda-shaped events over a loopback HTTP endpoint. The CLI feeds it SQS
// messages, EventBridge events and crons from the emulator.
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import { pathToFileURL } from 'node:url';

const entry = process.env.PLATFORM_WORKER_ENTRY;
const sdkWorker = process.env.PLATFORM_SDK_WORKER ?? '@ericminassian/platform/worker';
const port = Number(process.env.PLATFORM_WORKER_PORT);
// The worker's own function; a handler with its own settings is invoked with them in headers
// (`INVOKE_HEADERS` in worker.ts).
const workerFunction = {
  name: process.env.PLATFORM_WORKER_FUNCTION ?? 'local-worker',
  timeoutMs: Number(process.env.PLATFORM_WORKER_TIMEOUT_MS ?? 60_000),
  memoryMb: process.env.PLATFORM_WORKER_MEMORY_MB ?? '512',
};
if (!entry || !port) {
  console.error('PLATFORM_WORKER_ENTRY / PLATFORM_WORKER_PORT not set (this file is started by `plat dev`)');
  process.exit(1);
}

const mod = (await import(pathToFileURL(entry).href)) as { default?: unknown };
if (!mod.default) {
  console.error(
    `${entry} has no default export; export your worker (\`export default defineWorker({...})\`)`,
  );
  process.exit(1);
}
const sdkUrl = sdkWorker.startsWith('/') ? pathToFileURL(sdkWorker).href : sdkWorker;
const { createWorkerHandler } = (await import(sdkUrl)) as typeof import('@ericminassian/platform/worker');
const handler = createWorkerHandler(mod.default);

/** The JSON reply for one invocation; never rejects, failures become `{ ok: false, error }`. */
async function invoke(body: string, fn: typeof workerFunction): Promise<string> {
  const started = Date.now();
  const context = {
    awsRequestId: randomUUID(),
    functionName: fn.name,
    functionVersion: '$LATEST',
    invokedFunctionArn: `arn:aws:lambda:${process.env.AWS_REGION ?? 'us-east-1'}:000000000000:function:${fn.name}`,
    memoryLimitInMB: fn.memoryMb,
    logGroupName: `/aws/lambda/${fn.name}`,
    logStreamName: 'local',
    callbackWaitsForEmptyEventLoop: false,
    getRemainingTimeInMillis: () => Math.max(0, started + fn.timeoutMs - Date.now()),
  };
  try {
    return JSON.stringify({ ok: true, result: (await handler(JSON.parse(body || '{}'), context)) ?? null });
  } catch (err) {
    const e = err as Error;
    return JSON.stringify({
      ok: false,
      error: { name: e?.name ?? 'Error', message: e?.message ?? String(err), stack: e?.stack },
    });
  }
}

const header = (req: IncomingMessage, name: string) => {
  const value = req.headers[name];
  return typeof value === 'string' ? value : undefined;
};

createServer((req, res) => {
  const timeoutMs = header(req, 'x-platform-timeout-ms');
  const fn = {
    name: header(req, 'x-platform-function') ?? workerFunction.name,
    timeoutMs: timeoutMs ? Number(timeoutMs) : workerFunction.timeoutMs,
    memoryMb: header(req, 'x-platform-memory-mb') ?? workerFunction.memoryMb,
  };
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    void invoke(body, fn).then((reply) =>
      res.writeHead(200, { 'content-type': 'application/json' }).end(reply),
    );
  });
}).listen(port, '127.0.0.1');
