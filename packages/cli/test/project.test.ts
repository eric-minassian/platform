import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadProject, resolveAppName } from '../src/project.ts';
import { CliError } from '../src/util/output.ts';
import { tempDir } from './helpers.ts';

function app(files: Record<string, string>): string {
  const dir = tempDir();
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

describe('loadProject', () => {
  it('evaluates plat.config.ts, with its imports, from a subdirectory', async () => {
    const root = app({
      'plat.config.ts': [
        "import { schedules } from './config/schedules.ts';",
        'const batchSize: number = 5;',
        "export default { name: 'shop', crons: schedules, queues: { mail: { batchSize } } };",
      ].join('\n'),
      'config/schedules.ts': "export const schedules = { nightly: '0 3 * * *' };",
      'src/.keep': '',
    });
    const p = await loadProject(join(root, 'src'));
    expect(p.root).toBe(root);
    expect(p.manifest.crons).toEqual({ nightly: { schedule: '0 3 * * *' } });
    expect(p.raw).toEqual({
      name: 'shop',
      crons: { nightly: '0 3 * * *' },
      queues: { mail: { batchSize: 5 } },
    });
    expect(await resolveAppName(undefined, join(root, 'src'))).toBe('shop');
  });

  it('re-reads the file on each load', async () => {
    const root = app({ 'plat.config.ts': "export default { name: 'one-app' };" });
    expect((await loadProject(root)).manifest.name).toBe('one-app');
    writeFileSync(join(root, 'plat.config.ts'), "export default { name: 'two-app' };");
    expect((await loadProject(root)).manifest.name).toBe('two-app');
  });

  it('explains how to move from platform.json', async () => {
    const root = app({ 'platform.json': '{"name":"old-app"}' });
    await expect(loadProject(root)).rejects.toMatchObject({
      message: expect.stringMatching(/no plat\.config\.ts found/),
      hint: expect.stringMatching(/platform\.json is no longer read.*defineApp/),
    });
  });

  it('reports a missing default export, a broken or throwing file and an invalid config', async () => {
    await expect(loadProject(app({ 'plat.config.ts': 'export const x = 1;' }))).rejects.toThrow(
      /must default-export the app config/,
    );
    await expect(loadProject(app({ 'plat.config.ts': 'export default {' }))).rejects.toThrow(
      /could not compile plat\.config\.ts:[\s\S]*plat\.config\.ts:1:/,
    );
    await expect(
      loadProject(app({ 'plat.config.ts': "throw new Error('no region');\nexport default {};" })),
    ).rejects.toThrow(/plat\.config\.ts threw while loading: no region/);
    const invalid = loadProject(
      app({ 'plat.config.ts': "export default { name: 'X', crons: { a: 'nope' } };" }),
    );
    await expect(invalid).rejects.toBeInstanceOf(CliError);
    await expect(invalid).rejects.toThrow(/Invalid plat\.config\.ts:[\s\S]*name[\s\S]*crons\.a/);
  });
});
