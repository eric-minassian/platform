import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { APP_CONFIG_FILE } from '@ericminassian/platform-core';
import { describe, expect, it } from 'vitest';
import { initApp, replaceAppName, rewritePackageJson, TEMPLATE_APP_NAME, templateDir } from '../src/init.ts';
import { cliVersion, loadProject } from '../src/project.ts';
import { tempDir } from './helpers.ts';

describe('plat init', () => {
  it('copies the template with the app name everywhere', async () => {
    const dir = join(tempDir(), 'my-notes');
    const r = initApp({ dir });
    expect(r.name).toBe('my-notes');

    // Evaluate the new app's plat.config.ts the way `plat` does, against the
    // template's installed packages.
    symlinkSync(join(templateDir(), 'node_modules'), join(dir, 'node_modules'));
    const { manifest } = await loadProject(dir);
    expect(manifest.name).toBe('my-notes');
    expect(Object.keys(manifest.queues)).toEqual(['emails']);
    expect(manifest.events).toEqual(['todo.created']);

    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    expect(pkg.name).toBe('my-notes');
    expect(pkg.dependencies['@ericminassian/platform']).toBe(`^${cliVersion()}`);
    expect(pkg.devDependencies['@ericminassian/plat']).toBe(`^${cliVersion()}`);
    expect(pkg.packageManager).toMatch(/^pnpm@/);
    expect(JSON.stringify(pkg)).not.toContain('workspace:');
    // pnpm 10+ fails the install unless esbuild's build script is allowed.
    expect(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')).toMatch(/allowBuilds:\n {2}esbuild: true/);
    expect(r.files).toContain('pnpm-workspace.yaml');

    for (const f of r.files) {
      if (/\.(png|ico)$/.test(f)) continue;
      expect(readFileSync(join(dir, f), 'utf8'), f).not.toContain(TEMPLATE_APP_NAME);
    }
    expect(readFileSync(join(dir, 'AGENTS.md'), 'utf8')).toContain('my-notes--pr-<n>.ericminassian.com');
    expect(existsSync(join(dir, '.gitignore'))).toBe(true);
    expect(existsSync(join(dir, '.github/workflows/platform.yml'))).toBe(true);
    expect(r.files.some((f) => f.startsWith('node_modules/'))).toBe(false);
    expect(r.files).not.toContain('web/dist/index.html');
  });

  it('uses --name over the directory name', () => {
    const dir = join(tempDir(), 'somewhere');
    expect(initApp({ dir, name: 'shop' }).name).toBe('shop');
  });

  it('rejects bad names and non-empty directories', () => {
    expect(() => initApp({ dir: join(tempDir(), 'x'), name: 'Bad_Name' })).toThrow(/invalid app name/);
    expect(() => initApp({ dir: join(tempDir(), 'platform') })).toThrow(/reserved/);
    const full = join(tempDir(), 'full');
    mkdirSync(full);
    writeFileSync(join(full, 'file.txt'), 'hi');
    expect(() => initApp({ dir: full })).toThrow(/not empty/);
    expect(() => initApp({ dir: full, name: 'fine-app', force: true })).not.toThrow();
  });

  it('rewrites package.json and placeholders', () => {
    const out = JSON.parse(
      rewritePackageJson(
        JSON.stringify({ name: 'platform-app-template', dependencies: { a: 'workspace:*', b: '^1.0.0' } }),
        'shop',
        '^0.3.0',
      ),
    );
    expect(out).toMatchObject({ name: 'shop', dependencies: { a: '^0.3.0', b: '^1.0.0' } });
    expect(replaceAppName('https://template-app.x and template-app--pr-1', 'shop')).toBe(
      'https://shop.x and shop--pr-1',
    );
  });

  it('finds the template in the repo', () => {
    expect(existsSync(join(templateDir(), APP_CONFIG_FILE))).toBe(true);
  });
});
