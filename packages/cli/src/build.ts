import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import type { ArtifactFile, ResolvedManifest } from '@eric-minassian/platform-core';
import { build as esbuild, type Plugin } from 'esbuild';
import { cliVersion, loadProject } from './project.ts';
import { CliError, EXIT, step } from './util/output.ts';
import { dirExists, zipDirectory } from './util/zip.ts';

export const SDK_SERVER = '@eric-minassian/platform/server';
export const SDK_WORKER = '@eric-minassian/platform/worker';

export interface BuildOptions {
  cwd: string;
  /** Default `<app>/.plat/build`. */
  outDir?: string;
  /** Skip `web.build` (e.g. `plat dev`, which runs the dev server instead). */
  skipWebBuild?: boolean;
  /** Only build these parts. Default: everything the manifest declares. */
  only?: Array<'server' | 'worker' | 'static'>;
  /**
   * Replace module specifiers during bundling (absolute paths). Tests use it to
   * stand in for the SDK; nothing else should need it.
   */
  resolveOverrides?: Record<string, string>;
  minify?: boolean;
  quiet?: boolean;
}

export interface BuildResult {
  manifest: ResolvedManifest;
  /** Absolute paths of the produced artifacts. */
  files: Partial<Record<ArtifactFile, string>>;
}

/**
 * Builds an app into deployable artifacts:
 *  - `server.zip`  → `index.mjs` (+ map): the app's fetch handler wrapped by the SDK server
 *  - `worker.zip`  → `index.mjs` (+ map): `export const handler` for the worker Lambda
 *  - `static.zip`  → the built frontend
 *  - `manifest.json` → `{ manifest, resolved, build }`
 */
export async function buildApp(opts: BuildOptions): Promise<BuildResult> {
  const project = loadProject(opts.cwd);
  const { root, manifest, raw } = project;
  const outDir = resolve(opts.outDir ?? join(root, '.plat', 'build'));
  const want = (part: 'server' | 'worker' | 'static') => !opts.only || opts.only.includes(part);
  const log = opts.quiet ? () => {} : step;

  validateForBuild(root, manifest);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const files: BuildResult['files'] = {};
  const plugins = opts.resolveOverrides ? [overridePlugin(opts.resolveOverrides)] : [];
  const minify = opts.minify ?? true;

  if (manifest.web?.server && want('server')) {
    log('bundling server');
    const entry = resolve(root, manifest.web.server);
    const dir = await bundle({
      root,
      outDir: join(outDir, 'server'),
      contents: `import handler from ${JSON.stringify(entry)};\nimport { startServer } from ${JSON.stringify(SDK_SERVER)};\nawait startServer(handler);\n`,
      plugins,
      minify,
    });
    files['server.zip'] = writeZip(outDir, 'server.zip', zipDirectory(dir));
  }

  if (manifest.worker && want('worker')) {
    log('bundling worker');
    const dir = await bundleWorker(root, manifest, join(outDir, 'worker'), { plugins, minify });
    files['worker.zip'] = writeZip(outDir, 'worker.zip', zipDirectory(dir));
  }

  if (manifest.web?.static && want('static')) {
    if (manifest.web.build && !opts.skipWebBuild) {
      log(`building frontend: ${manifest.web.build}`);
      await runCommand(manifest.web.build, root);
    }
    const staticDir = resolve(root, manifest.web.static);
    if (!dirExists(staticDir)) {
      throw new CliError(`web.static directory ${manifest.web.static} does not exist`, {
        hint: manifest.web.build
          ? 'check that web.build writes to web.static'
          : 'add a web.build command or build the frontend first',
        exitCode: EXIT.usage,
      });
    }
    if (!existsSync(join(staticDir, 'index.html')) && manifest.web.spa) {
      throw new CliError(`${manifest.web.static}/index.html is missing but web.spa is true`, {
        exitCode: EXIT.usage,
      });
    }
    files['static.zip'] = writeZip(outDir, 'static.zip', zipDirectory(staticDir));
  }

  const manifestPath = join(outDir, 'manifest.json');
  writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        manifest: raw,
        resolved: manifest,
        build: {
          cli: cliVersion(),
          builtAt: new Date().toISOString(),
          files: Object.keys(files),
        },
      },
      null,
      2,
    )}\n`,
  );
  files['manifest.json'] = manifestPath;
  return { manifest, files };
}

/** Bundle just the worker into `outDir/index.mjs` (used by build and `plat dev`). */
export async function bundleWorker(
  root: string,
  manifest: ResolvedManifest,
  outDir: string,
  opts: { plugins?: Plugin[]; minify?: boolean } = {},
): Promise<string> {
  if (!manifest.worker) throw new Error('manifest has no worker');
  const entry = resolve(root, manifest.worker.entry);
  return bundle({
    root,
    outDir,
    contents: `import def from ${JSON.stringify(entry)};\nimport { createWorkerHandler } from ${JSON.stringify(SDK_WORKER)};\nexport const handler = createWorkerHandler(def);\n`,
    plugins: opts.plugins ?? [],
    minify: opts.minify ?? true,
  });
}

/** Zip of a bundled directory, for UpdateFunctionCode. */
export function zipBundle(dir: string): Uint8Array {
  return zipDirectory(dir);
}

export function validateForBuild(root: string, manifest: ResolvedManifest): void {
  const problems: string[] = [];
  if (manifest.auth.enabled && !manifest.web?.server)
    problems.push('auth needs web.server (sign-in routes run in the server)');
  if (manifest.web?.server && !existsSync(resolve(root, manifest.web.server))) {
    problems.push(`web.server entry ${manifest.web.server} does not exist`);
  }
  if (manifest.worker && !existsSync(resolve(root, manifest.worker.entry))) {
    problems.push(
      `worker entry ${manifest.worker.entry} does not exist (needed for ${describeWorkerNeeds(manifest)})`,
    );
  }
  if (problems.length)
    throw new CliError(`can't build ${manifest.name}:\n  - ${problems.join('\n  - ')}`, {
      exitCode: EXIT.usage,
    });
}

function describeWorkerNeeds(m: ResolvedManifest): string {
  const parts = [
    ...Object.keys(m.queues).map((q) => `queue ${q}`),
    ...m.events.map((e) => `event ${e}`),
    ...Object.keys(m.crons).map((c) => `cron ${c}`),
  ];
  return parts.join(', ') || 'worker';
}

async function bundle(o: {
  root: string;
  outDir: string;
  contents: string;
  plugins: Plugin[];
  minify: boolean;
}): Promise<string> {
  mkdirSync(o.outDir, { recursive: true });
  try {
    await esbuild({
      stdin: { contents: o.contents, resolveDir: o.root, sourcefile: 'platform-entry.ts', loader: 'ts' },
      outfile: join(o.outDir, 'index.mjs'),
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node24',
      minify: o.minify,
      sourcemap: 'external',
      sourcesContent: false,
      legalComments: 'none',
      logLevel: 'silent',
      // ESM bundles of CJS dependencies still call require(). process.getBuiltinModule
      // (not a static `import 'node:module'`) keeps the bundle loadable in runtimes
      // without node:module, such as the AWS Emulator's Lambda sandbox.
      banner: {
        js: "const require = globalThis.process?.getBuiltinModule?.('module')?.createRequire(import.meta.url);",
      },
      plugins: o.plugins,
      absWorkingDir: o.root,
    });
  } catch (err) {
    const errors = (
      err as { errors?: Array<{ text: string; location?: { file: string; line: number } | null }> }
    ).errors;
    const detail = errors
      ?.map((e) => (e.location ? `${e.location.file}:${e.location.line}: ${e.text}` : e.text))
      .join('\n  - ');
    throw new CliError(`bundling failed${detail ? `:\n  - ${detail}` : `: ${(err as Error).message}`}`);
  }
  return o.outDir;
}

function overridePlugin(map: Record<string, string>): Plugin {
  const keys = Object.keys(map);
  const filter = new RegExp(`^(${keys.map((k) => k.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('|')})$`);
  return {
    name: 'plat-resolve-overrides',
    setup(b) {
      b.onResolve({ filter }, (args) => ({ path: map[args.path]! }));
    },
  };
}

function writeZip(outDir: string, name: string, data: Uint8Array): string {
  const p = join(outDir, name);
  writeFileSync(p, data);
  return p;
}

/** Run a manifest shell command with the app's `node_modules/.bin` on PATH. */
export function runCommand(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      stdio: ['ignore', 'inherit', 'inherit'],
      env: withLocalBin(cwd, env),
    });
    child.once('exit', (code) =>
      code === 0 ? resolvePromise() : reject(new CliError(`\`${command}\` exited with code ${code}`)),
    );
    child.once('error', reject);
  });
}

export function withLocalBin(cwd: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...env, PATH: [join(cwd, 'node_modules', '.bin'), env.PATH ?? ''].join(delimiter) };
}

export function readBuildManifest(outDir: string): unknown {
  return JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf8'));
}
