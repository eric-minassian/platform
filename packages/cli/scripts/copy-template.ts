// Copies templates/app into the CLI package (`template/`) before publishing,
// so `plat init` works from npm. `.gitignore` is stored as `_gitignore`
// because npm strips dotfiles named .gitignore from packages.
import { cpSync, existsSync, renameSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const src = resolve(pkgRoot, '..', '..', 'templates', 'app');
const dest = join(pkgRoot, 'template');
const skip = new Set(['node_modules', '.plat', 'dist', 'coverage']);

rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, {
  recursive: true,
  filter: (from) => !from.split(/[\\/]/).some((part) => skip.has(part)),
});
if (existsSync(join(dest, '.gitignore'))) renameSync(join(dest, '.gitignore'), join(dest, '_gitignore'));
console.log(`copied ${src} -> ${dest}`);
