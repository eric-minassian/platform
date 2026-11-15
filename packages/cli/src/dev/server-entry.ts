// Entry for the local web server under `plat dev` (run with `tsx watch`, so
// edits to the app restart it). Loads the app's fetch handler and starts it
// with the SDK server wrapper — the same wrapper the Web Function runs — using
// the app's own copy of the SDK so app code and wrapper share state.
import { pathToFileURL } from 'node:url';

const entry = process.env.PLATFORM_ENTRY;
const sdkServer = process.env.PLATFORM_SDK_SERVER ?? '@eric-minassian/platform/server';
if (!entry) {
  console.error('PLATFORM_ENTRY is not set (this file is started by `plat dev`)');
  process.exit(1);
}

const mod = (await import(pathToFileURL(entry).href)) as { default?: unknown };
if (!mod.default) {
  console.error(`${entry} has no default export; export your app (e.g. \`export default app\`)`);
  process.exit(1);
}
const sdkUrl = sdkServer.startsWith('/') ? pathToFileURL(sdkServer).href : sdkServer;
const { startServer } = (await import(sdkUrl)) as typeof import('@eric-minassian/platform/server');
await startServer(mod.default as Parameters<typeof startServer>[0]);
