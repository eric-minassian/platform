import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/build.ts';
import { CliError } from '../src/util/output.ts';
import { zipFileNames } from '../src/util/zip.ts';
import { copyFixture, SDK_STUBS } from './helpers.ts';

describe('buildApp', () => {
  it('produces server, worker, static and manifest artifacts', async () => {
    const root = copyFixture('basic-app');
    const { manifest, files } = await buildApp({ cwd: root, resolveOverrides: SDK_STUBS, quiet: true });

    expect(manifest.name).toBe('basic-app');
    expect(Object.keys(files).toSorted()).toEqual([
      'manifest.json',
      'server.zip',
      'static.zip',
      'worker.zip',
    ]);
    for (const p of Object.values(files)) expect(p.startsWith(root)).toBe(true);

    expect(zipFileNames(readFileSync(files['server.zip']!))).toEqual(['index.mjs', 'index.mjs.map']);
    expect(zipFileNames(readFileSync(files['worker.zip']!))).toEqual(['index.mjs', 'index.mjs.map']);
    expect(zipFileNames(readFileSync(files['static.zip']!))).toEqual(['assets/app.js', 'index.html']);

    const server = readFileSync(join(root, '.plat/build/server/index.mjs'), 'utf8');
    expect(server).toContain('hello from basic-app'); // app code bundled in
    expect(server).toContain('createRequire'); // CJS interop banner
    const worker = readFileSync(join(root, '.plat/build/worker/index.mjs'), 'utf8');
    expect(worker).toMatch(/export\s*\{[^}]*handler/);

    const built = JSON.parse(readFileSync(files['manifest.json']!, 'utf8')) as {
      manifest: { name: string };
      resolved: { worker: { entry: string } };
      build: { files: string[] };
    };
    expect(built.manifest.name).toBe('basic-app');
    expect(built.resolved.worker.entry).toBe('src/worker.ts');
    expect(built.build.files).toEqual(['server.zip', 'worker.zip', 'static.zip']);
  });

  it('builds one server bundle that listens as a Web Function and exports a request-mode handler', async () => {
    const root = copyFixture('basic-app');
    await buildApp({ cwd: root, resolveOverrides: SDK_STUBS, quiet: true, minify: false, only: ['server'] });
    const bundle = pathToFileURL(join(root, '.plat/build/server/index.mjs')).href;
    const g = globalThis as { __platStubHandler?: unknown };
    const endpoint = process.env.AWS_LAMBDA_HTTP_ENDPOINT;
    try {
      delete process.env.AWS_LAMBDA_HTTP_ENDPOINT;
      g.__platStubHandler = undefined;
      const request = (await import(`${bundle}?request`)) as { handler?: { requestMode?: unknown } };
      expect(request.handler?.requestMode).toBeDefined();
      expect(g.__platStubHandler).toBeUndefined();

      process.env.AWS_LAMBDA_HTTP_ENDPOINT = '127.0.0.1:9001';
      const instance = (await import(`${bundle}?instance`)) as { handler?: unknown };
      expect(instance.handler).toBeUndefined();
      // Each import evaluates its own copy of the bundle, app included.
      expect(typeof g.__platStubHandler).toBe(typeof request.handler?.requestMode);
      expect(g.__platStubHandler).toBeDefined();
    } finally {
      if (endpoint === undefined) delete process.env.AWS_LAMBDA_HTTP_ENDPOINT;
      else process.env.AWS_LAMBDA_HTTP_ENDPOINT = endpoint;
    }
  });

  it('the worker bundle exports a handler that dispatches to the definition', async () => {
    const root = copyFixture('basic-app');
    await buildApp({ cwd: root, resolveOverrides: SDK_STUBS, quiet: true, minify: false, only: ['worker'] });
    const mod = (await import(join(root, '.plat/build/worker/index.mjs'))) as {
      handler: (event: unknown) => Promise<unknown>;
    };
    expect(await mod.handler({ ping: 1 })).toEqual({ handled: ['queues', 'crons'], event: { ping: 1 } });
  });

  it('is deterministic for the same inputs', async () => {
    const root = copyFixture('basic-app');
    const a = await buildApp({ cwd: root, resolveOverrides: SDK_STUBS, quiet: true });
    const first = readFileSync(a.files['static.zip']!);
    const b = await buildApp({ cwd: root, resolveOverrides: SDK_STUBS, quiet: true });
    expect(Buffer.compare(first, readFileSync(b.files['static.zip']!))).toBe(0);
  });

  it('explains missing entries', async () => {
    const root = copyFixture('basic-app');
    rmSync(join(root, 'src/worker.ts'));
    const err = await buildApp({ cwd: root, resolveOverrides: SDK_STUBS, quiet: true }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).message).toMatch(
      /worker entry src\/worker\.ts does not exist \(needed for queue jobs, cron tick\)/,
    );
  });

  it('rejects auth without a server', async () => {
    const root = copyFixture('basic-app');
    writeFileSync(
      join(root, 'plat.config.ts'),
      "export default { name: 'basic-app', auth: true, web: { static: 'public' } };\n",
    );
    await expect(buildApp({ cwd: root, quiet: true })).rejects.toBeInstanceOf(CliError);
  });

  it('reports bundling errors with file and line', async () => {
    const root = copyFixture('basic-app');
    writeFileSync(
      join(root, 'src/server.ts'),
      "import { nope } from './missing.ts';\nexport default nope;\n",
    );
    await expect(
      buildApp({ cwd: root, resolveOverrides: SDK_STUBS, quiet: true, only: ['server'] }),
    ).rejects.toThrow(/bundling failed:[\s\S]*missing\.ts/);
  });
});
