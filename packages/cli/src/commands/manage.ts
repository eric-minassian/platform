import { ENV_NAME_PATTERN, PROD_STAGE } from '@ericminassian/platform-core';
import type { Command } from 'commander';
import pc from 'picocolors';
import { CliError, EXIT, result, table } from '../util/output.ts';
import { confirmByTyping, prompt } from '../util/prompt.ts';
import { shortTime } from '../util/time.ts';
import { action, apiFor, appFor, type CommonOpts, withTarget } from './common.ts';
import { readStdin } from './observe.ts';

type TargetOpts = CommonOpts & { stage: string };

export function registerManage(program: Command): void {
  // ------------------------------------------------------------ secrets
  const secrets = program.command('secrets').description('app secrets (values never shown)');

  withTarget(secrets.command('list').description('secret names for a stage (and shared ones)')).action(
    action(async (opts: TargetOpts) => {
      const list = await apiFor(opts).listSecrets(await appFor(opts), { stage: opts.stage });
      result(list, (l) =>
        table(
          l.map((s) => ({
            name: s.name,
            scope: s.scope,
            stage: s.stage ?? '',
            updated: s.updatedAt ? shortTime(s.updatedAt) : '',
          })),
        ),
      );
    }),
  );

  withTarget(
    secrets
      .command('set <name> [value]')
      .description('set a secret (value from the argument or stdin)')
      .option('--shared', 'app-wide: every stage without its own value uses it'),
  ).action(
    action(async (name: string, value: string | undefined, opts: TargetOpts & { shared?: boolean }) => {
      checkSecretName(name);
      const v = value ?? (process.stdin.isTTY ? await prompt(`value for ${name}: `) : readStdin());
      if (!v) throw new CliError('empty secret value', { exitCode: EXIT.usage });
      const info = await apiFor(opts).setSecret(
        await appFor(opts),
        name,
        opts.shared ? { value: v, shared: true } : { value: v, stage: opts.stage },
      );
      result(
        info,
        () =>
          `${pc.green('✓')} set ${name} (${opts.shared ? 'shared' : opts.stage}); new value applies within ~5 minutes`,
      );
    }),
  );

  withTarget(
    secrets
      .command('rm <name>')
      .description('delete a secret')
      .option('--shared', 'delete the app-wide value'),
  ).action(
    action(async (name: string, opts: TargetOpts & { shared?: boolean }) => {
      checkSecretName(name);
      await apiFor(opts).deleteSecret(
        await appFor(opts),
        name,
        opts.shared ? { shared: true } : { stage: opts.stage },
      );
      result({ deleted: name }, () => `${pc.green('✓')} deleted ${name}`);
    }),
  );

  // ------------------------------------------------------------ deployments & stages
  withTarget(program.command('deployments').description('recent deployments'), false).action(
    action(async (opts: CommonOpts & { stage?: string }) => {
      const list = await apiFor(opts).listDeployments(await appFor(opts), opts.stage);
      result(list, (l) =>
        table(
          l.map((d) => ({
            id: d.id,
            stage: d.stage,
            status:
              d.status === 'succeeded'
                ? pc.green(d.status)
                : d.status === 'failed'
                  ? pc.red(d.status)
                  : d.status,
            commit: d.commit?.slice(0, 7) ?? '',
            message: (d.message ?? '').slice(0, 50),
            by: d.actor,
            at: shortTime(d.createdAt),
          })),
        ),
      );
    }),
  );

  withTarget(program.command('stages').description('stages of an app'), false).action(
    action(async (opts: CommonOpts) => {
      const list = await apiFor(opts).listStages(await appFor(opts));
      result(list, (l) =>
        table(
          l.map((s) => ({
            stage: s.stage,
            status: s.status,
            url: s.url,
            deployment: s.currentDeployment ?? '',
            updated: shortTime(s.updatedAt),
          })),
        ),
      );
    }),
  );

  withTarget(
    program
      .command('rollback')
      .description('point a stage back at its previous deployment')
      .option('--to <deploymentId>', 'a specific earlier deployment')
      .option('--no-wait', "don't wait for this machine to be served the deployment"),
  ).action(
    action(async (opts: TargetOpts & { to?: string; wait: boolean }) => {
      const r = await apiFor(opts).rollback(await appFor(opts), opts.stage, opts.to);
      if (opts.wait) {
        const { confirmServedHere } = await import('../edge.ts');
        // Every routed stage answers health (its server or the edge), with the deployment id.
        await confirmServedHere(r.url, r.currentDeployment, { health: true });
      }
      result(r, (v) => `${pc.green('✓')} rolled back ${opts.stage} to ${v.currentDeployment}: ${v.url}`);
    }),
  );

  withTarget(
    program
      .command('destroy')
      .description('delete a stage and its resources')
      .option('--yes', 'skip the confirmation prompt')
      .option('--force', 'required to destroy prod'),
    false,
  ).action(
    action(async (opts: CommonOpts & { stage?: string; yes?: boolean; force?: boolean }) => {
      if (!opts.stage) throw new CliError('--stage is required', { exitCode: EXIT.usage });
      if (opts.stage === PROD_STAGE && !opts.force) {
        throw new CliError('refusing to destroy prod', {
          hint: 'pass --force if you really mean it',
          exitCode: EXIT.usage,
        });
      }
      const app = await appFor(opts);
      await confirmByTyping(`destroy ${app}/${opts.stage}?`, opts.stage, opts.yes);
      await apiFor(opts).destroyStage(app, opts.stage);
      result(
        { app, stage: opts.stage, destroyed: true },
        () => `${pc.green('✓')} destroying ${app}/${opts.stage}`,
      );
    }),
  );

  // ------------------------------------------------------------ crons
  const cron = program.command('cron').description('scheduled jobs');
  withTarget(cron.command('run <name>').description('run a cron now on a deployed stage')).action(
    action(async (name: string, opts: TargetOpts) => {
      await apiFor(opts).runCron(await appFor(opts), name, opts.stage);
      result(
        { cron: name, stage: opts.stage, triggered: true },
        () => `${pc.green('✓')} triggered ${name} on ${opts.stage}`,
      );
    }),
  );
}

function checkSecretName(name: string): void {
  if (!ENV_NAME_PATTERN.test(name)) {
    throw new CliError(`secret names are UPPER_SNAKE_CASE, got "${name}"`, { exitCode: EXIT.usage });
  }
}
