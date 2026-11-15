import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ManifestError, parseManifest, type ResolvedManifest } from '@eric-minassian/platform-core';
import { CliError, EXIT } from './util/output.ts';

export const MANIFEST_FILE = 'platform.json';

export interface Project {
  /** Directory containing platform.json. */
  root: string;
  /** platform.json as written. */
  raw: Record<string, unknown>;
  manifest: ResolvedManifest;
}

/** Walk up from `cwd` to the nearest platform.json. */
export function findProjectRoot(cwd: string): string | null {
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, MANIFEST_FILE))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function loadProject(cwd: string): Project {
  const root = findProjectRoot(cwd);
  if (!root) {
    throw new CliError(`no ${MANIFEST_FILE} found in ${cwd} or its parents`, {
      hint: 'run this inside an app, or create one with `plat init <dir> --name <app>`',
      exitCode: EXIT.usage,
    });
  }
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(join(root, MANIFEST_FILE), 'utf8'));
  } catch (err) {
    throw new CliError(`${MANIFEST_FILE} is not valid JSON: ${(err as Error).message}`, {
      exitCode: EXIT.usage,
    });
  }
  try {
    return { root, raw, manifest: parseManifest(raw) };
  } catch (err) {
    if (err instanceof ManifestError) throw new CliError(err.message, { exitCode: EXIT.usage });
    throw err;
  }
}

/** App name from `--app`, else the nearest platform.json. */
export function resolveAppName(opt: string | undefined, cwd = process.cwd()): string {
  if (opt) return opt;
  const root = findProjectRoot(cwd);
  if (!root) {
    throw new CliError('no app given', {
      hint: 'pass --app <name> or run inside an app directory',
      exitCode: EXIT.usage,
    });
  }
  return loadProject(root).manifest.name;
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
