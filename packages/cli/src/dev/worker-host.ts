// Local worker host for `plat dev` / `plat test`. The AWS Emulator's Lambda
// runtime is an embedded JS sandbox without node:http/https/net/async_hooks,
// so a worker that talks to AWS (through the SDK) can't run inside it. This
// process runs the worker in real Node instead: it builds the same handler the
// Lambda would (`createWorkerHandler(def)` from the app's SDK) and accepts
// Lambda-shaped events over a loopback HTTP endpoint. The CLI feeds it SQS
// messages, EventBridge events and crons from the emulator.
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

const entry = process.env.PLATFORM_WORKER_ENTRY;
const sdkWorker = process.env.PLATFORM_SDK_WORKER ?? '@ericminassian/platform/worker';
const port = Number(process.env.PLATFORM_WORKER_PORT);
const timeoutMs = Number(process.env.PLATFORM_WORKER_TIMEOUT_MS ?? 60_000);
const functionName = process.env.PLATFORM_WORKER_FUNCTION ?? 'local-worker';
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
const handler = createWorkerHandler(mod.default as Parameters<typeof createWorkerHandler>[0]);

createServer((req, res) => {
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    const started = Date.now();
    const context = {
      awsRequestId: randomUUID(),
      functionName,
      functionVersion: '$LATEST',
      invokedFunctionArn: `arn:aws:lambda:${process.env.AWS_REGION ?? 'us-east-1'}:000000000000:function:${functionName}`,
      memoryLimitInMB: '512',
      logGroupName: `/aws/lambda/${functionName}`,
      logStreamName: 'local',
      callbackWaitsForEmptyEventLoop: false,
      getRemainingTimeInMillis: () => Math.max(0, started + timeoutMs - Date.now()),
    };
    let reply: unknown;
    try {
      reply = { ok: true, result: (await handler(JSON.parse(body || '{}'), context)) ?? null };
    } catch (err) {
      const e = err as Error;
      reply = {
        ok: false,
        error: { name: e?.name ?? 'Error', message: e?.message ?? String(err), stack: e?.stack },
      };
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reply));
  });
}).listen(port, '127.0.0.1');
