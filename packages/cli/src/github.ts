import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { PROD_STAGE, previewStage, validateStageName } from '@ericminassian/platform-core';
import { CliError, EXIT } from './util/output.ts';

/** GitHub Actions environment, read from `process.env` (injectable for tests). */
export type Env = Record<string, string | undefined>;

export function isGitHubActions(env: Env = process.env): boolean {
  return env.GITHUB_ACTIONS === 'true';
}

interface GitHubEvent {
  number?: number;
  pull_request?: { number?: number; head?: { sha?: string; ref?: string }; title?: string };
  head_commit?: { message?: string };
  repository?: { default_branch?: string };
}

export function readEvent(env: Env = process.env): GitHubEvent {
  if (!env.GITHUB_EVENT_PATH) return {};
  try {
    return JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')) as GitHubEvent;
  } catch {
    return {};
  }
}

/**
 * The stage a CI run deploys to: `pr-<n>` for pull requests, `prod` for pushes
 * (or manual runs) on the default branch. `explicit` (from `--stage`) wins.
 */
export function deriveStage(explicit: string | undefined, env: Env = process.env): string {
  if (explicit) {
    const err = validateStageName(explicit);
    if (err) throw new CliError(err, { exitCode: EXIT.usage });
    return explicit;
  }
  if (!isGitHubActions(env)) {
    throw new CliError('no stage given', {
      hint: 'pass --stage <name> (CI derives it: pull requests → pr-<n>, main → prod)',
      exitCode: EXIT.usage,
    });
  }
  const event = readEvent(env);
  const name = env.GITHUB_EVENT_NAME;
  if (name === 'pull_request' || name === 'pull_request_target') {
    const n = event.pull_request?.number ?? event.number;
    if (!n) throw new CliError('pull_request event without a PR number', { exitCode: EXIT.usage });
    return previewStage(n);
  }
  const defaultBranch = event.repository?.default_branch ?? 'main';
  if (env.GITHUB_REF === `refs/heads/${defaultBranch}`) return PROD_STAGE;
  throw new CliError(
    `can't derive a stage for ${name ?? 'this event'} on ${env.GITHUB_REF ?? 'unknown ref'}`,
    {
      hint: 'pass --stage explicitly',
      exitCode: EXIT.usage,
    },
  );
}

/** Commit metadata for the deployment record. */
export function gitInfo(
  cwd: string,
  env: Env = process.env,
): { commit?: string; ref?: string; message?: string } {
  if (isGitHubActions(env)) {
    const event = readEvent(env);
    return {
      commit: event.pull_request?.head?.sha ?? env.GITHUB_SHA,
      ref: event.pull_request?.head?.ref ? `refs/heads/${event.pull_request.head.ref}` : env.GITHUB_REF,
      message: (event.pull_request?.title ?? event.head_commit?.message)?.split('\n')[0],
    };
  }
  const git = (...args: string[]) => {
    try {
      return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return undefined;
    }
  };
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  return {
    commit: git('rev-parse', 'HEAD'),
    ref: branch ? `refs/heads/${branch}` : undefined,
    message: git('log', '-1', '--format=%s'),
  };
}

/** GitHub Actions OIDC token for `audience` (requires `permissions: id-token: write`). */
export async function fetchOidcToken(audience: string, env: Env = process.env): Promise<string> {
  const url = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const token = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !token) {
    throw new CliError('GitHub Actions OIDC is not available', {
      hint: 'add `permissions: { id-token: write }` to the workflow',
      exitCode: EXIT.auth,
    });
  }
  const res = await fetch(`${url}${url.includes('?') ? '&' : '?'}audience=${encodeURIComponent(audience)}`, {
    headers: { authorization: `bearer ${token}`, accept: 'application/json' },
  });
  if (!res.ok) throw new CliError(`OIDC token request failed: HTTP ${res.status}`, { exitCode: EXIT.auth });
  const body = (await res.json()) as { value?: string };
  if (!body.value) throw new CliError('OIDC token response had no value', { exitCode: EXIT.auth });
  return body.value;
}

export function canUseOidc(env: Env = process.env): boolean {
  return isGitHubActions(env) && !!env.ACTIONS_ID_TOKEN_REQUEST_URL && !!env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
}

/** `key=value` into `$GITHUB_OUTPUT` (no-op outside Actions). */
export function setOutput(key: string, value: string, env: Env = process.env): void {
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `${key}=${value}\n`);
}

export function appendStepSummary(markdown: string, env: Env = process.env): void {
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
}
