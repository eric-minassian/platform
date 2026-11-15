import { spawnSync } from 'node:child_process';
import { type Command, Option } from 'commander';
import pc from 'picocolors';
import { ApiClient, apiBaseUrl } from '../api.ts';
import { clearCredentials, credentialsPath, loadCredentials, saveCredentials } from '../credentials.ts';
import { CliError, EXIT, result, success } from '../util/output.ts';
import { action, apiFor, type CommonOpts, withCommon } from './common.ts';

export function registerAccount(program: Command): void {
  withCommon(
    program
      .command('login')
      .description('sign in to the platform with your GitHub identity (uses `gh auth token`)')
      .addOption(
        new Option('--github-token <token>', 'GitHub token to use instead of `gh auth token`').env(
          'PLAT_GITHUB_TOKEN',
        ),
      ),
  ).action(
    action(async (opts: CommonOpts & { githubToken?: string }) => {
      const baseUrl = opts.apiUrl ?? apiBaseUrl();
      const githubToken = opts.githubToken ?? ghToken();
      const api = new ApiClient({ baseUrl, auth: 'none' });
      const res = await api.login({ githubToken });
      saveCredentials({ apiUrl: baseUrl, token: res.token, github: res.github, expiresAt: res.expiresAt });
      result({ github: res.github, role: res.role, expiresAt: res.expiresAt, apiUrl: baseUrl }, (r) => {
        success(`signed in as ${pc.bold(r.github)} (${r.role}) until ${r.expiresAt}`);
        return undefined;
      });
    }),
  );

  withCommon(program.command('logout').description('forget the stored platform login')).action(
    action(async () => {
      const removed = clearCredentials();
      result({ loggedOut: removed, path: credentialsPath() }, (r) =>
        r.loggedOut ? 'logged out' : 'not logged in',
      );
    }),
  );

  withCommon(program.command('whoami').description('show the signed-in platform member')).action(
    action(async (opts: CommonOpts) => {
      const me = await apiFor(opts).me();
      const stored = loadCredentials();
      result({ ...me, expiresAt: stored?.expiresAt }, (r) => `${pc.bold(r.github)} (${r.role})`);
    }),
  );
}

function ghToken(): string {
  const env = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const r = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8' });
  const token = r.status === 0 ? r.stdout.trim() : env;
  if (!token) {
    throw new CliError('could not get a GitHub token', {
      hint: 'install the GitHub CLI and run `gh auth login`, or pass --github-token',
      exitCode: EXIT.auth,
    });
  }
  return token;
}
