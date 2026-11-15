import { relative } from 'node:path';
import { PLATFORM_DEFAULTS } from '@ericminassian/platform-core';
import { type Command, Option } from 'commander';
import pc from 'picocolors';
import { initApp } from '../init.ts';
import { CliError, EXIT, result, success } from '../util/output.ts';
import { action, apiFor, type CommonOpts, withCommon } from './common.ts';

export function registerLifecycle(program: Command): void {
  withCommon(
    program
      .command('init [dir]')
      .description('scaffold a new app from the template (local files only; create the GitHub repo yourself)')
      .option('--name <app>', 'app name (default: directory name)')
      .option('--force', 'write into a non-empty directory'),
  ).action(
    action(async (dir: string | undefined, opts: CommonOpts & { name?: string; force?: boolean }) => {
      const target = dir ?? opts.name ?? '.';
      const r = initApp({
        dir: target,
        ...(opts.name ? { name: opts.name } : {}),
        ...(opts.force ? { force: true } : {}),
      });
      const rel = relative(process.cwd(), r.dir) || '.';
      result(r, (v) =>
        [
          `${pc.green('✓')} created ${pc.bold(v.name)} in ${rel} (${v.files.length} files)`,
          '',
          '  next:',
          rel === '.' ? '' : `    cd ${rel}`,
          '    pnpm install',
          '    pnpm dev                                   # local, on the AWS Emulator',
          `    gh repo create <owner>/${v.name} --private --source . --push`,
          `    plat apps create ${v.name} --repo <owner>/${v.name}`,
        ]
          .filter(Boolean)
          .join('\n'),
      );
    }),
  );

  withCommon(
    program
      .command('build')
      .description('bundle the app into deployable artifacts (.plat/build)')
      .option('--out <dir>', 'output directory')
      .option('--no-minify', 'skip minification'),
  ).action(
    action(async (opts: CommonOpts & { out?: string; minify: boolean }) => {
      const { buildApp } = await import('../build.ts');
      const r = await buildApp({
        cwd: process.cwd(),
        ...(opts.out ? { outDir: opts.out } : {}),
        minify: opts.minify,
      });
      result({ app: r.manifest.name, files: r.files }, (v) => {
        success(`built ${v.app}`);
        return Object.entries(v.files)
          .map(([k, p]) => `  ${k.padEnd(14)} ${relative(process.cwd(), p as string)}`)
          .join('\n');
      });
    }),
  );

  withCommon(
    program
      .command('deploy')
      .description('build and deploy (CI derives the stage: PR → pr-<n>, main → prod)')
      .option('--stage <stage>', 'target stage (required outside CI)')
      .option('--no-wait', "don't wait for the deployment to finish"),
  ).action(
    action(async (opts: CommonOpts & { stage?: string; wait: boolean }) => {
      const { deploy } = await import('../deploy.ts');
      const r = await deploy(apiFor(opts), {
        cwd: process.cwd(),
        ...(opts.stage ? { stage: opts.stage } : {}),
        wait: opts.wait,
      });
      result({ deployment: r.deployment, url: r.url }, (v) => (v.url ? v.url : undefined));
    }),
  );

  const dev = withCommon(
    program
      .command('dev')
      .description('run the app locally against the AWS Emulator')
      .addOption(
        new Option('--port <port>', 'local router port')
          .default(String(PLATFORM_DEFAULTS.localPort))
          .env('PLAT_DEV_PORT'),
      )
      .option('--spans', 'also print trace spans (db, queue, fetch calls)'),
  ).action(
    action(async (opts: CommonOpts & { port: string; spans?: boolean }) => {
      const { runDev } = await import('../dev/index.ts');
      await runDev({
        cwd: process.cwd(),
        port: parsePort(opts.port),
        ...(opts.spans ? { spans: true } : {}),
      });
    }),
  );

  withCommon(
    dev
      .command('run-cron <name>')
      .description('fire a cron now in a running `plat dev` (same --port as `plat dev`)'),
  ).action(
    action(async (name: string, _opts: CommonOpts, cmd: Command) => {
      // `--port` belongs to `plat dev` (the parent); commander parses it there.
      const port =
        (cmd.parent?.opts() as { port?: string } | undefined)?.port ?? String(PLATFORM_DEFAULTS.localPort);
      const { runCronOnDev } = await import('../dev/index.ts');
      await runCronOnDev(name, parsePort(port));
      result({ cron: name, triggered: true }, () => `${pc.green('✓')} ran ${name}`);
    }),
  );

  withCommon(
    program
      .command('test')
      .description('run integration tests against a throwaway AWS Emulator with this app provisioned')
      .argument('[vitestArgs...]', 'extra arguments for vitest')
      .allowUnknownOption(),
  ).action(
    action(async (vitestArgs: string[]) => {
      const { runTests } = await import('../dev/test.ts');
      const code = await runTests({ cwd: process.cwd(), args: vitestArgs ?? [] });
      if (code !== 0) throw new CliError(`tests failed (vitest exit ${code})`, { exitCode: code });
    }),
  );
}

export function parsePort(v: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0 || n > 65535)
    throw new CliError(`invalid port ${v}`, { exitCode: EXIT.usage });
  return n;
}
