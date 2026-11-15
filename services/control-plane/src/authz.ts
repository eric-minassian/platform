/**
 * Authorization rules. Pure functions only (unit tested): who may see an app,
 * create apps, and which CI runs may deploy which stage.
 */
import {
  type AppRecord,
  findMember,
  isPreviewStage,
  type MemberRole,
  type PlatformConfig,
  PROD_STAGE,
  validateStageName,
} from '@ericminassian/platform-core';

export interface MemberPrincipal {
  kind: 'member';
  github: string;
  role: MemberRole;
}

/** A GitHub Actions run, identified by its OIDC token. */
export interface CiPrincipal {
  kind: 'ci';
  repository: string;
  repositoryOwner: string;
  ref: string;
  eventName: string;
  sha?: string;
  actor?: string;
  runId?: string;
}

export type Principal = MemberPrincipal | CiPrincipal;

/** Claims we read from a GitHub Actions OIDC token. */
export interface GithubOidcClaims {
  repository?: string;
  repository_owner?: string;
  ref?: string;
  event_name?: string;
  sha?: string;
  actor?: string;
  run_id?: string;
}

export type Decision = { ok: true } | { ok: false; reason: string };

const allow: Decision = { ok: true };
const deny = (reason: string): Decision => ({ ok: false, reason });

export function ciPrincipalFromClaims(claims: GithubOidcClaims): CiPrincipal | null {
  if (!claims.repository || !claims.repository_owner || !claims.ref || !claims.event_name) return null;
  return {
    kind: 'ci',
    repository: claims.repository,
    repositoryOwner: claims.repository_owner,
    ref: claims.ref,
    eventName: claims.event_name,
    ...(claims.sha ? { sha: claims.sha } : {}),
    ...(claims.actor ? { actor: claims.actor } : {}),
    ...(claims.run_id ? { runId: claims.run_id } : {}),
  };
}

/** Members see apps they own; admins see everything. */
export function canAccessApp(p: MemberPrincipal, app: AppRecord): boolean {
  if (p.role === 'admin') return true;
  const me = p.github.toLowerCase();
  return app.owners.some((o) => o.toLowerCase() === me);
}

/** Is this principal (still) a member? Membership is re-checked on every request. */
export function memberFor(config: PlatformConfig, github: string): MemberPrincipal | null {
  const m = findMember(config, github);
  return m ? { kind: 'member', github: m.github, role: m.role } : null;
}

export function canCreateApp(
  p: MemberPrincipal,
  appsCreatedByMember: number,
  config: PlatformConfig,
): Decision {
  if (p.role !== 'admin' && appsCreatedByMember >= config.limits.appsPerMember) {
    return deny(`limit of ${config.limits.appsPerMember} apps per member reached`);
  }
  return allow;
}

/**
 * Which CI runs may deploy (or destroy) which stage:
 *  - the token must come from the app's registered repo, owned by a member;
 *  - `prod` only from `main` (push or workflow_dispatch);
 *  - `pr-N` only from the `pull_request` event for PR N;
 *  - any other stage needs a member token (`plat deploy --stage <name>`).
 */
export function checkCiStageAccess(
  ci: CiPrincipal,
  app: AppRecord,
  stage: string,
  config: PlatformConfig,
): Decision {
  const stageErr = validateStageName(stage);
  if (stageErr) return deny(stageErr);
  if (ci.repository.toLowerCase() !== app.repo.toLowerCase()) {
    return deny(`token is for ${ci.repository}, but ${app.name} deploys from ${app.repo}`);
  }
  if (!findMember(config, ci.repositoryOwner)) {
    return deny(`repository owner ${ci.repositoryOwner} is not a platform member`);
  }
  if (stage === PROD_STAGE) {
    if (ci.ref !== 'refs/heads/main') return deny(`prod deploys only from refs/heads/main (got ${ci.ref})`);
    if (ci.eventName !== 'push' && ci.eventName !== 'workflow_dispatch') {
      return deny(`prod deploys only from push or workflow_dispatch (got ${ci.eventName})`);
    }
    return allow;
  }
  if (isPreviewStage(stage)) {
    const pr = stage.slice('pr-'.length);
    if (ci.eventName !== 'pull_request') return deny(`${stage} deploys only from pull_request events`);
    if (ci.ref !== `refs/pull/${pr}/merge`) return deny(`${stage} deploys only from refs/pull/${pr}/merge`);
    return allow;
  }
  return deny(`stage ${stage} can only be deployed with a member token`);
}

/** Member token deploys: any stage of an app the member can access. */
export function checkMemberStageAccess(p: MemberPrincipal, app: AppRecord, stage: string): Decision {
  const stageErr = validateStageName(stage);
  if (stageErr) return deny(stageErr);
  return canAccessApp(p, app) ? allow : deny(`${p.github} cannot manage ${app.name}`);
}

export function checkStageAccess(
  p: Principal,
  app: AppRecord,
  stage: string,
  config: PlatformConfig,
): Decision {
  return p.kind === 'member'
    ? checkMemberStageAccess(p, app, stage)
    : checkCiStageAccess(p, app, stage, config);
}

/** Display name stored as a deployment's actor. */
export function actorOf(p: Principal): string {
  return p.kind === 'member' ? p.github : `ci:${p.repository}${p.actor ? `@${p.actor}` : ''}`;
}
