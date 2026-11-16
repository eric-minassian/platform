import { Command } from 'commander';
import { registerAccount } from './commands/account.ts';
import { registerAlerts } from './commands/alerts.ts';
import { registerApps } from './commands/apps.ts';
import { registerEmail } from './commands/email.ts';
import { registerExplore } from './commands/explore.ts';
import { registerLifecycle } from './commands/lifecycle.ts';
import { registerManage } from './commands/manage.ts';
import { registerObserve } from './commands/observe.ts';
import { registerServices } from './commands/services.ts';
import { cliVersion } from './project.ts';

export function createProgram(): Command {
  const program = new Command('plat')
    .description(
      'The platform CLI: create, run locally (AWS Emulator), deploy and observe apps.\nEvery command accepts --json for machine-readable output.',
    )
    .version(cliVersion(), '-v, --version')
    .showHelpAfterError('(run with --help for usage)')
    .configureHelp({ sortSubcommands: false });

  registerLifecycle(program);
  registerApps(program);
  registerAccount(program);
  registerObserve(program);
  registerAlerts(program);
  registerExplore(program);
  registerServices(program);
  registerManage(program);
  registerEmail(program);
  return program;
}

export async function main(argv: string[]): Promise<void> {
  await createProgram().parseAsync(argv);
}
