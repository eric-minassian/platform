/**
 * `platform.config.ts` at the repo root: the platform's own settings and its
 * member allowlist. Members are GitHub usernames; inviting someone is a PR
 * plus a platform deploy. No emails or account ids here (the repo is public).
 */
import { Schema } from 'effect';
export const MemberRole = Schema.Literals(['admin', 'member']);
export type MemberRole = typeof MemberRole.Type;

export interface Member {
  github: string;
  role: MemberRole;
}

export interface PlatformConfig {
  domain: string;
  region: string;
  /** Zone delegated to the platform account (console, edge, login). */
  zone: string;
  consoleHost: string;
  /** Root-zone `*` CNAME target; alias to the router distribution. */
  edgeHost: string;
  /** Cognito managed login custom domain for app end users. */
  loginHost: string;
  /**
   * `ownerId`/`repoId` are the numeric GitHub ids (public). Repos created with
   * GitHub's immutable OIDC subject claims sign tokens as
   * `repo:<owner>@<ownerId>/<repo>@<repoId>:...`, so roles that trust GitHub
   * Actions need them (see `gh api repos/<owner>/<repo>/actions/oidc/customization/sub`).
   */
  github: { owner: string; repo: string; ownerId: number; repoId: number };
  members: Member[];
  /** Names that already exist in the root zone (delegated or static records). */
  reservedAppNames: string[];
  /** Preview stages untouched for this long are destroyed by the reaper. */
  previewTtlDays: number;
  limits: {
    appsPerMember: number;
    stagesPerApp: number;
    /** Highest `email.dailyLimit` an app may declare (recipients per UTC day). */
    emailsPerDay: number;
    /**
     * The edge floor's limit for every app: requests one client (IP address)
     * may send one host per minute before the edge answers 429 for a while.
     * Enforced only while the floor is on (`edgeFloorAt`); apps set finer
     * limits with `RateLimits`.
     */
    edgeRequestsPerMinute?: number;
    /**
     * Requests per minute across the whole edge, every app together, that
     * turn the floor on: the control plane attaches an AWS WAF web ACL with
     * the `edgeRequestsPerMinute` rule, and removes it after an hour under
     * this rate. Set both or neither; without them there is no floor.
     */
    edgeFloorAt?: number;
    /** Long-running services one stage's plat.config.ts may declare: the one resource billed while idle. */
    servicesPerApp: number;
  };
  telemetry: { logRetentionDays: { prod: number; other: number } };
}

export function definePlatformConfig(config: PlatformConfig): PlatformConfig {
  const { edgeRequestsPerMinute: perClient, edgeFloorAt: at } = config.limits;
  // WAF's rate-based rules count from 10 requests.
  if (perClient !== undefined && (!Number.isSafeInteger(perClient) || perClient < 10))
    throw new Error(`limits.edgeRequestsPerMinute must be an integer of at least 10, not ${perClient}`);
  if (at !== undefined && (!Number.isSafeInteger(at) || at < 1))
    throw new Error(`limits.edgeFloorAt must be a positive integer, not ${at}`);
  // One without the other is a floor that never turns on, or one with no limit to enforce.
  if ((perClient === undefined) !== (at === undefined))
    throw new Error('limits.edgeRequestsPerMinute and limits.edgeFloorAt are set together, or neither');
  const seen = new Set<string>();
  for (const m of config.members) {
    const key = m.github.toLowerCase();
    if (seen.has(key)) throw new Error(`duplicate member ${m.github}`);
    seen.add(key);
  }
  return config;
}

export function findMember(config: PlatformConfig, github: string): Member | undefined {
  return config.members.find((m) => m.github.toLowerCase() === github.toLowerCase());
}
