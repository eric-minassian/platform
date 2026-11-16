// Entry for a long-running service under `plat dev` (run with `tsx watch`, so
// edits to the app restart it). Loads the app's service module and runs it
// with the SDK's service runtime, the one its container runs, using the app's
// own copy of the SDK so app code and runtime share state.
//
// tsx watch restarts the process on edits but not when it exits by itself,
// which `plat dev` handles as ECS would, by starting it again. These lines,
// prefixed with PLATFORM_DEV_SERVICE_TOKEN, tell it when the process started
// and when it exited with a failure: runService exits 0 only when told to stop.
import { writeSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const entry = process.env.PLATFORM_SERVICE_ENTRY;
const sdkService = process.env.PLATFORM_SDK_SERVICE ?? '@ericminassian/platform/service';
const token = process.env.PLATFORM_DEV_SERVICE_TOKEN;

if (token) {
  // writeSync: an async write to a pipe may never happen once the process exits.
  writeSync(1, `${token} start\n`);
  process.on('exit', (code) => {
    if (code !== 0) writeSync(1, `${token} exit ${code}\n`);
  });
}
if (!entry) {
  console.error('PLATFORM_SERVICE_ENTRY is not set (this file is started by `plat dev`)');
  process.exit(1);
}

const mod = (await import(pathToFileURL(entry).href)) as { default?: unknown };
if (!mod.default) {
  console.error(
    `${entry} has no default export; export your service (\`export default defineService({...})\`)`,
  );
  process.exit(1);
}
const sdkUrl = sdkService.startsWith('/') ? pathToFileURL(sdkService).href : sdkService;
const { runService } = (await import(sdkUrl)) as typeof import('@ericminassian/platform/service');
await runService(mod.default as Parameters<typeof runService>[0]);
