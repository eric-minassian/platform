import { type StageRecord, validateAppName } from '@ericminassian/platform-core';
import type { Command } from 'commander';
import pc from 'picocolors';
import { CliError, EXIT, result, table } from '../util/output.ts';
import { confirmByTyping } from '../util/prompt.ts';
import { shortTime } from '../util/time.ts';
import { action, apiFor, type CommonOpts, withCommon } from './common.ts';

const usd = (n: number) => (n > 0 && n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`);

/** `request (≈ $0.04/mo; instance ≈ $3.10)`: how the server runs and, for prod, what each mode costs. */
export function describeCompute(stage: Pick<StageRecord, 'compute' | 'computeEstimate'>): string {
  if (!stage.compute) return '-';
  const e = stage.computeEstimate;
  if (!e) return stage.compute;
  const other = stage.compute === 'request' ? 'instance' : 'request';
  return `${stage.compute} (≈ ${usd(e[stage.compute].monthlyUsd)}/mo; ${other} ≈ ${usd(e[other].monthlyUsd)})`;
}

export function registerApps(program: Command): void {
  const apps = program
    .command('apps')
    .description('register and inspect apps (repos are created by you, not the CLI)');

  withCommon(
    apps
      .command('create <name>')
      .description('register an app with the platform')
      .requiredOption('--repo <owner/name>', 'GitHub repository whose CI may deploy this app')
      .option('--description <text>', 'one-line description'),
  ).action(
    action(async (name: string, opts: CommonOpts & { repo: string; description?: string }) => {
      const err = validateAppName(name);
      if (err) throw new CliError(err, { exitCode: EXIT.usage });
      if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(opts.repo)) {
        throw new CliError(`--repo must look like owner/name, got "${opts.repo}"`, { exitCode: EXIT.usage });
      }
      const app = await apiFor(opts).createApp({
        name,
        repo: opts.repo,
        ...(opts.description ? { description: opts.description } : {}),
      });
      result(app, (a) =>
        [
          `${pc.green('✓')} registered ${pc.bold(a.name)} (deploys from ${a.repo})`,
          '',
          '  next:',
          '    1. push the repo with the platform workflow (.github/workflows/platform.yml)',
          `    2. merging to main deploys https://${a.name}.<domain>; PRs get previews`,
        ].join('\n'),
      );
    }),
  );

  withCommon(apps.command('list').description('list apps you can see')).action(
    action(async (opts: CommonOpts) => {
      const list = await apiFor(opts).listApps();
      result(list, (l) =>
        table(
          l.map((s) => ({
            app: s.app.name,
            repo: s.app.repo,
            stages: s.stages.map((st) => st.stage).join(','),
            up:
              s.health?.up === null || s.health === null
                ? '-'
                : s.health.up
                  ? pc.green('up')
                  : pc.red('down'),
            'req/min': s.health?.reqPerMin ?? '-',
            p95: s.health?.p95 != null ? `${s.health.p95}ms` : '-',
            'cost MTD': s.costMonthToDateUsd != null ? `$${s.costMonthToDateUsd.toFixed(2)}` : '-',
          })),
        ),
      );
    }),
  );

  withCommon(apps.command('show <name>').description('app details, stages and health')).action(
    action(async (name: string, opts: CommonOpts) => {
      const s = await apiFor(opts).getApp(name);
      result(s, (v) =>
        [
          `${pc.bold(v.app.name)}  ${pc.dim(v.app.description ?? '')}`,
          `repo: ${v.app.repo}   owners: ${v.app.owners.join(', ')}   created: ${shortTime(v.app.createdAt)}`,
          '',
          table(
            v.stages.map((st) => ({
              stage: st.stage,
              status: st.status,
              url: st.url,
              deployment: st.currentDeployment ?? '',
              compute: describeCompute(st),
              updated: shortTime(st.updatedAt),
            })),
          ),
        ].join('\n'),
      );
    }),
  );

  withCommon(
    apps
      .command('delete <name>')
      .description('unregister an app (destroy its stages first)')
      .option('--yes', 'skip the confirmation prompt'),
  ).action(
    action(async (name: string, opts: CommonOpts & { yes?: boolean }) => {
      await confirmByTyping(`unregister ${name}?`, name, opts.yes);
      await apiFor(opts).deleteApp(name);
      result({ app: name, deleted: true }, () => `${pc.green('✓')} unregistered ${name}`);
    }),
  );
}
