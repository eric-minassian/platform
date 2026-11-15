/**
 * `platform.config.ts` at the repo root: the platform's own settings and its
 * member allowlist. Members are GitHub usernames; inviting someone is a PR
 * plus a platform deploy. No emails or account ids here (the repo is public).
 */
export type MemberRole = 'admin' | 'member';

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
  limits: { appsPerMember: number; stagesPerApp: number };
  telemetry: { logRetentionDays: { prod: number; other: number } };
}

export function definePlatformConfig(config: PlatformConfig): PlatformConfig {
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
