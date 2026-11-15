import { type Command, Option } from 'commander';
import { ApiClient } from '../api.ts';
import { resolveAppName } from '../project.ts';
import { reportError, setJsonMode } from '../util/output.ts';

export interface CommonOpts {
  json?: boolean;
  apiUrl?: string;
  app?: string;
  stage?: string;
}

/** `--json` and `--api-url` on every command. */
export function withCommon(cmd: Command): Command {
  return cmd
    .option('--json', 'machine-readable JSON output on stdout')
    .addOption(new Option('--api-url <url>', 'platform API base URL').env('PLATFORM_API_URL'));
}

/** `--app` (defaults to plat.config.ts) and `--stage` (defaults to prod). */
export function withTarget(cmd: Command, stageDefault: string | false = 'prod'): Command {
  cmd.option('--app <name>', 'app name (default: from plat.config.ts)');
  if (stageDefault) cmd.option('--stage <stage>', 'stage', stageDefault);
  else cmd.option('--stage <stage>', 'stage');
  return withCommon(cmd);
}

export function apiFor(opts: CommonOpts): ApiClient {
  return new ApiClient(opts.apiUrl ? { baseUrl: opts.apiUrl } : {});
}

export function appFor(opts: CommonOpts): Promise<string> {
  return resolveAppName(opts.app);
}

/**
 * Wraps a command action: applies `--json`, turns errors into a concise
 * message + hint and a meaningful exit code.
 */
export function action<A extends unknown[]>(fn: (...args: A) => Promise<void> | void) {
  return async (...args: A) => {
    const cmd = args[args.length - 1] as Command;
    const opts = typeof cmd?.optsWithGlobals === 'function' ? cmd.optsWithGlobals() : {};
    setJsonMode(!!opts.json);
    try {
      await fn(...args);
    } catch (err) {
      process.exitCode = reportError(err);
    }
  };
}
