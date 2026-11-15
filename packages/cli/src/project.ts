import { existsSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  APP_CONFIG_FILE,
  ManifestError,
  parseManifest,
  type ResolvedManifest,
} from '@ericminassian/platform-core';
import { build as esbuild } from 'esbuild';
import { buildFailureList } from './util/esbuild.ts';
import { CliError, EXIT } from './util/output.ts';

/** Apps configured with JSON before `plat.config.ts`; only detected to say how to move. */
const LEGACY_MANIFEST_FILE = 'platform.json';

export interface Project {
  /** Directory containing plat.config.ts. */
  root: string;
  /** The config's default export as JSON: exactly what is validated, built and deployed. */
  raw: Record<string, unknown>;
  manifest: ResolvedManifest;
}

/** Walk up from `cwd` to the nearest directory containing `name`. */
function findUp(cwd: string, name: string): string | null {
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, name))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Walk up from `cwd` to the nearest plat.config.ts. */
export function findProjectRoot(cwd: string): string | null {
  return findUp(cwd, APP_CONFIG_FILE);
}

export async function loadProject(cwd: string): Promise<Project> {
  const root = findProjectRoot(cwd);
  if (!root) {
    const legacy = findUp(cwd, LEGACY_MANIFEST_FILE);
    throw new CliError(`no ${APP_CONFIG_FILE} found in ${cwd} or its parents`, {
      hint: legacy
        ? `${join(legacy, LEGACY_MANIFEST_FILE)} is no longer read: move its fields into ${APP_CONFIG_FILE} as \`export default defineApp({ ... })\` from '@ericminassian/platform/config'`
        : 'run this inside an app, or create one with `plat init <dir> --name <app>`',
      exitCode: EXIT.usage,
    });
  }
  const exported = await importConfig(root);
  if (exported === null || typeof exported !== 'object' || Array.isArray(exported)) {
    throw new CliError(`${APP_CONFIG_FILE} must default-export the app config`, {
      hint: "export default defineApp({ name: '...' }) from '@ericminassian/platform/config'",
      exitCode: EXIT.usage,
    });
  }
  // The platform receives JSON, so validate (and later deploy) the JSON form.
  const raw = JSON.parse(JSON.stringify(exported)) as Record<string, unknown>;
  try {
    return { root, raw, manifest: parseManifest(raw) };
  } catch (err) {
    if (err instanceof ManifestError) throw new CliError(err.message, { exitCode: EXIT.usage });
    throw err;
  }
}

/**
 * Bundles the config (its relative imports included, packages left external)
 * into `.plat/` and imports that, like Vite does for vite.config.ts. This
 * works whatever the app's package `type` is, and a fresh file name means a
 * changed config is always re-read.
 */
async function importConfig(root: string): Promise<unknown> {
  const outfile = join(root, '.plat', `config-${process.pid}-${Date.now()}.mjs`);
  try {
    await esbuild({
      entryPoints: [join(root, APP_CONFIG_FILE)],
      outfile,
      bundle: true,
      packages: 'external',
      platform: 'node',
      format: 'esm',
      target: 'node24',
      sourcemap: 'inline',
      logLevel: 'silent',
      absWorkingDir: root,
    });
  } catch (err) {
    throw new CliError(`could not compile ${APP_CONFIG_FILE}:${buildFailureList(err)}`, {
      exitCode: EXIT.usage,
    });
  }
  try {
    const mod = (await import(pathToFileURL(outfile).href)) as { default?: unknown };
    return mod.default;
  } catch (err) {
    throw new CliError(`${APP_CONFIG_FILE} threw while loading: ${(err as Error).message}`, {
      exitCode: EXIT.usage,
    });
  } finally {
    rmSync(outfile, { force: true });
  }
}

/** App name from `--app`, else the nearest plat.config.ts. */
export async function resolveAppName(opt: string | undefined, cwd = process.cwd()): Promise<string> {
  if (opt) return opt;
  if (!findProjectRoot(cwd)) {
    throw new CliError('no app given', {
      hint: 'pass --app <name> or run inside an app directory',
      exitCode: EXIT.usage,
    });
  }
  return (await loadProject(cwd)).manifest.name;
}

export function cliVersion(): string {
  return (cliPackageJson().version as string | undefined) ?? '0.0.0';
}

export function cliPackageRoot(): string {
  return fileURLToPath(new URL('..', import.meta.url));
}

function cliPackageJson(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(cliPackageRoot(), 'package.json'), 'utf8'));
}

/**
 * Resolve a module the way the *app* would (its own node_modules first), so
 * the server wrapper and app code share one copy of the SDK. Falls back to the
 * CLI's own dependency.
 */
export function resolveFromApp(appRoot: string, specifier: string): string {
  try {
    return createRequire(join(appRoot, 'package.json')).resolve(specifier);
  } catch {
    return createRequire(import.meta.url).resolve(specifier);
  }
}
