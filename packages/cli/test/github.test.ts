import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { appendStepSummary, deriveStage, gitInfo, setOutput } from '../src/github.ts';
import { tempDir } from './helpers.ts';

function eventFile(event: unknown): string {
  const p = join(tempDir(), 'event.json');
  writeFileSync(p, JSON.stringify(event));
  return p;
}

const actions = (extra: Record<string, string>) => ({ GITHUB_ACTIONS: 'true', ...extra });

describe('deriveStage', () => {
  it('uses --stage when given (and validates it)', () => {
    expect(deriveStage('pr-7', {})).toBe('pr-7');
    expect(() => deriveStage('Bad Stage', {})).toThrow(/stage/);
  });

  it('requires --stage outside CI', () => {
    expect(() => deriveStage(undefined, {})).toThrow(/no stage given/);
  });

  it('maps pull requests to pr-<n>', () => {
    const env = actions({
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_EVENT_PATH: eventFile({ number: 12, pull_request: { number: 12 } }),
      GITHUB_REF: 'refs/pull/12/merge',
    });
    expect(deriveStage(undefined, env)).toBe('pr-12');
  });

  it('maps pushes to the default branch to prod', () => {
    const env = actions({
      GITHUB_EVENT_NAME: 'push',
      GITHUB_REF: 'refs/heads/main',
      GITHUB_EVENT_PATH: eventFile({ repository: { default_branch: 'main' } }),
    });
    expect(deriveStage(undefined, env)).toBe('prod');
    const trunk = actions({
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_REF: 'refs/heads/trunk',
      GITHUB_EVENT_PATH: eventFile({ repository: { default_branch: 'trunk' } }),
    });
    expect(deriveStage(undefined, trunk)).toBe('prod');
  });

  it('refuses other branches', () => {
    const env = actions({ GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/feature' });
    expect(() => deriveStage(undefined, env)).toThrow(/can't derive a stage/);
  });
});

describe('CI metadata', () => {
  it('reads the PR head commit rather than the merge commit', () => {
    const env = actions({
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_SHA: 'merge-sha',
      GITHUB_EVENT_PATH: eventFile({
        pull_request: { number: 3, title: 'Add todos\nbody', head: { sha: 'head-sha', ref: 'feat' } },
      }),
    });
    expect(gitInfo('.', env)).toEqual({ commit: 'head-sha', ref: 'refs/heads/feat', message: 'Add todos' });
  });

  it('writes step outputs and summaries', () => {
    const dir = tempDir();
    const env = { GITHUB_OUTPUT: join(dir, 'out'), GITHUB_STEP_SUMMARY: join(dir, 'summary') };
    setOutput('url', 'https://x.example.com', env);
    appendStepSummary('### done', env);
    expect(readFileSync(env.GITHUB_OUTPUT, 'utf8')).toBe('url=https://x.example.com\n');
    expect(readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8')).toBe('### done\n');
  });
});
