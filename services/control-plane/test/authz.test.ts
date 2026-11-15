import { type AppRecord, definePlatformConfig, type PlatformConfig } from '@ericminassian/platform-core';
import { describe, expect, it } from 'vitest';
import {
  actorOf,
  type CiPrincipal,
  canAccessApp,
  canCreateApp,
  checkCiStageAccess,
  checkStageAccess,
  ciPrincipalFromClaims,
  memberFor,
} from '../src/authz.ts';

const config: PlatformConfig = definePlatformConfig({
  domain: 'example.com',
  region: 'us-east-1',
  zone: 'platform.example.com',
  consoleHost: 'platform.example.com',
  edgeHost: 'edge.platform.example.com',
  loginHost: 'login.platform.example.com',
  github: { owner: 'owner', repo: 'platform', ownerId: 1, repoId: 2 },
  members: [
    { github: 'Admin', role: 'admin' },
    { github: 'dev', role: 'member' },
  ],
  reservedAppNames: [],
  previewTtlDays: 7,
  limits: { appsPerMember: 2, stagesPerApp: 5 },
  telemetry: { logRetentionDays: { prod: 30, other: 7 } },
});

const app: AppRecord = {
  name: 'todo',
  repo: 'dev/todo',
  owners: ['dev'],
  createdBy: 'dev',
  createdAt: '2026-01-01T00:00:00Z',
};

const ci = (over: Partial<CiPrincipal> = {}): CiPrincipal => ({
  kind: 'ci',
  repository: 'dev/todo',
  repositoryOwner: 'dev',
  ref: 'refs/heads/main',
  eventName: 'push',
  ...over,
});

describe('members', () => {
  it('resolves members case-insensitively', () => {
    expect(memberFor(config, 'admin')).toEqual({ kind: 'member', github: 'Admin', role: 'admin' });
    expect(memberFor(config, 'stranger')).toBeNull();
  });

  it('lets owners and admins access apps', () => {
    expect(canAccessApp(memberFor(config, 'dev')!, app)).toBe(true);
    expect(canAccessApp(memberFor(config, 'admin')!, app)).toBe(true);
    expect(canAccessApp({ kind: 'member', github: 'other', role: 'member' }, app)).toBe(false);
  });

  it('enforces the per-member app limit except for admins', () => {
    expect(canCreateApp(memberFor(config, 'dev')!, 1, config).ok).toBe(true);
    expect(canCreateApp(memberFor(config, 'dev')!, 2, config).ok).toBe(false);
    expect(canCreateApp(memberFor(config, 'admin')!, 99, config).ok).toBe(true);
  });
});

describe('CI deploy rules', () => {
  it('allows prod only from main via push or workflow_dispatch', () => {
    expect(checkCiStageAccess(ci(), app, 'prod', config).ok).toBe(true);
    expect(checkCiStageAccess(ci({ eventName: 'workflow_dispatch' }), app, 'prod', config).ok).toBe(true);
    expect(checkCiStageAccess(ci({ ref: 'refs/heads/feature' }), app, 'prod', config)).toMatchObject({
      ok: false,
    });
    expect(checkCiStageAccess(ci({ eventName: 'pull_request' }), app, 'prod', config)).toMatchObject({
      ok: false,
    });
  });

  it('allows pr-N only from that pull request', () => {
    const pr = ci({ eventName: 'pull_request', ref: 'refs/pull/12/merge' });
    expect(checkCiStageAccess(pr, app, 'pr-12', config).ok).toBe(true);
    expect(checkCiStageAccess(pr, app, 'pr-13', config)).toMatchObject({ ok: false });
    expect(checkCiStageAccess(ci(), app, 'pr-12', config)).toMatchObject({ ok: false });
  });

  it("lets a merged PR's closed run destroy its preview, but not deploy one", () => {
    // A merged PR's `closed` event runs with the base branch as its ref.
    const closed = ci({ eventName: 'pull_request', ref: 'refs/heads/main' });
    expect(checkCiStageAccess(closed, app, 'pr-12', config, 'destroy').ok).toBe(true);
    expect(checkCiStageAccess(closed, app, 'pr-12', config, 'deploy')).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/refs\/pull\/12\/merge/),
    });
    expect(checkCiStageAccess(closed, app, 'prod', config, 'destroy')).toMatchObject({ ok: false });
    expect(checkCiStageAccess(closed, app, 'staging', config, 'destroy')).toMatchObject({ ok: false });
    // Still bound to the app's repo, and to pull_request events.
    expect(
      checkCiStageAccess({ ...closed, repository: 'dev/other' }, app, 'pr-12', config, 'destroy'),
    ).toMatchObject({ ok: false });
    expect(checkCiStageAccess(ci(), app, 'pr-12', config, 'destroy')).toMatchObject({ ok: false });
    // An open PR's run tears down its own preview the usual way.
    const open = ci({ eventName: 'pull_request', ref: 'refs/pull/12/merge' });
    expect(checkCiStageAccess(open, app, 'pr-12', config, 'destroy').ok).toBe(true);
    expect(checkStageAccess(closed, app, 'pr-12', config, 'destroy').ok).toBe(true);
  });

  it('rejects other repos, non-member owners and custom stages', () => {
    expect(checkCiStageAccess(ci({ repository: 'dev/other' }), app, 'prod', config)).toMatchObject({
      ok: false,
    });
    expect(checkCiStageAccess(ci({ repositoryOwner: 'mallory' }), app, 'prod', config)).toMatchObject({
      ok: false,
    });
    expect(checkCiStageAccess(ci(), app, 'staging', config)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/member token/),
    });
    expect(checkCiStageAccess(ci(), app, 'BAD', config)).toMatchObject({ ok: false });
  });

  it('lets members deploy any stage of their apps', () => {
    expect(checkStageAccess(memberFor(config, 'dev')!, app, 'staging', config).ok).toBe(true);
    expect(checkStageAccess({ kind: 'member', github: 'x', role: 'member' }, app, 'prod', config).ok).toBe(
      false,
    );
  });

  it('parses OIDC claims', () => {
    expect(ciPrincipalFromClaims({ repository: 'a/b' })).toBeNull();
    const p = ciPrincipalFromClaims({
      repository: 'dev/todo',
      repository_owner: 'dev',
      ref: 'refs/heads/main',
      event_name: 'push',
      actor: 'dev',
    });
    expect(p).toMatchObject({ kind: 'ci', repository: 'dev/todo', actor: 'dev' });
    expect(actorOf(p!)).toBe('ci:dev/todo@dev');
  });
});
