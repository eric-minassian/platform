import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { validateAppName } from '@ericminassian/platform-core';
import { cliPackageRoot, cliVersion } from './project.ts';
import { CliError, EXIT } from './util/output.ts';

/** The app name used throughout `templates/app`; replaced on `plat init`. */
export const TEMPLATE_APP_NAME = 'template-app';
export const TEMPLATE_PACKAGE_NAME = 'platform-app-template';
/** Written into new apps so CI's corepack uses the same pnpm as the platform. */
export const PACKAGE_MANAGER = 'pnpm@12.11.2';

const SKIP = new Set(['node_modules', '.plat', 'dist', 'coverage', '.turbo']);
const TEXT_EXT = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.cjs',
  '.json',
  '.md',
  '.html',
  '.css',
  '.yml',
  '.yaml',
  '.txt',
  '.gitignore',
  '',
]);

/** Published CLI: `template/` inside the package. In this repo: `templates/app`. */
export function templateDir(): string {
  const packaged = join(cliPackageRoot(), 'template');
  if (existsSync(join(packaged, 'platform.json'))) return packaged;
  const repo = resolve(cliPackageRoot(), '..', '..', 'templates', 'app');
  if (existsSync(join(repo, 'platform.json'))) return repo;
  throw new CliError('app template not found (broken CLI install?)');
}

export interface InitOptions {
  dir: string;
  name?: string;
  force?: boolean;
  /** Version range written for platform packages. Default `^<cli version>`. */
  versionRange?: string;
  template?: string;
}

export interface InitResult {
  dir: string;
  name: string;
  files: string[];
}

export function initApp(opts: InitOptions): InitResult {
  const dir = resolve(opts.dir);
  const name = opts.name ?? basename(dir);
  const err = validateAppName(name);
  if (err) throw new CliError(`invalid app name: ${err}`, { exitCode: EXIT.usage });
  if (existsSync(dir) && readdirSync(dir).filter((f) => f !== '.git').length > 0 && !opts.force) {
    throw new CliError(`${dir} is not empty`, {
      hint: 'choose an empty directory or pass --force',
      exitCode: EXIT.usage,
    });
  }
  const src = opts.template ?? templateDir();
  const range = opts.versionRange ?? `^${cliVersion()}`;
  const files = copyTree(src, dir, (rel, content) =>
    rel === 'package.json' ? rewritePackageJson(content, name, range) : replaceAppName(content, name),
  );
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), PNPM_WORKSPACE);
  files.push('pnpm-workspace.yaml');
  return { dir, name, files: files.sort() };
}

/**
 * pnpm 10+ refuses to install (ERR_PNPM_IGNORED_BUILDS) until a dependency's
 * install script is allowed, and esbuild (used by `plat build`) has one. It's
 * written here rather than shipped in templates/app: a pnpm-workspace.yaml
 * there would make that folder its own workspace inside this monorepo.
 */
export const PNPM_WORKSPACE = `# esbuild (used by \`plat build\`) installs its native binary with a build script.
allowBuilds:
  esbuild: true
`;

export function replaceAppName(content: string, name: string): string {
  return content.split(TEMPLATE_APP_NAME).join(name);
}

export function rewritePackageJson(content: string, name: string, range: string): string {
  const pkg = JSON.parse(content) as Record<string, unknown>;
  pkg.name = name;
  pkg.packageManager ??= PACKAGE_MANAGER;
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const deps = pkg[field] as Record<string, string> | undefined;
    if (!deps) continue;
    for (const [dep, v] of Object.entries(deps)) if (v.startsWith('workspace:')) deps[dep] = range;
  }
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

/** Copies `src` to `dest`, transforming text files; returns the written paths (relative). */
function copyTree(src: string, dest: string, transform: (rel: string, content: string) => string): string[] {
  const written: string[] = [];
  const walk = (from: string) => {
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue;
      const abs = join(from, entry.name);
      const rel = relative(src, abs).split('\\').join('/');
      if (rel === 'web/dist') continue;
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      // npm drops `.gitignore` from packages, so the published template stores `_gitignore`.
      const outRel = rel.replace(/(^|\/)_gitignore$/, '$1.gitignore');
      const target = join(dest, outRel);
      mkdirSync(dirname(target), { recursive: true });
      const isText = TEXT_EXT.has(extname(entry.name)) && statSync(abs).size < 1_000_000;
      if (isText) writeFileSync(target, transform(outRel, readFileSync(abs, 'utf8')));
      else copyFileSync(abs, target);
      written.push(outRel);
    }
  };
  walk(src);
  return written;
}
