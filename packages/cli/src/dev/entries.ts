import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Path to tsx's CLI (it has no `./cli` export, so go through its package.json). */
export function tsxCli(): string {
  const pkg = createRequire(import.meta.url).resolve('tsx/package.json');
  const bin = (JSON.parse(readFileSync(pkg, 'utf8')) as { bin: string | Record<string, string> }).bin;
  const rel = typeof bin === 'string' ? bin : (bin.tsx ?? Object.values(bin)[0]!);
  return join(dirname(pkg), rel);
}

/** A CLI-owned entry file next to this module (`.ts` in the repo, `.js` when published). */
export function devEntry(name: 'server-entry' | 'worker-host'): string {
  const ts = fileURLToPath(new URL(`./${name}.ts`, import.meta.url));
  return existsSync(ts) ? ts : fileURLToPath(new URL(`./${name}.js`, import.meta.url));
}

/** argv for running an entry under tsx, optionally restarting on edits. */
export function tsxArgs(name: 'server-entry' | 'worker-host', watch: boolean): string[] {
  return watch ? [tsxCli(), 'watch', '--clear-screen=false', devEntry(name)] : [tsxCli(), devEntry(name)];
}
