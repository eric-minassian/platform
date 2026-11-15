import { definePlatformConfig } from '@ericminassian/platform-core';

/**
 * The platform's own settings. Inviting someone = add them to `members` in a
 * PR, merge, and let CI deploy the platform. This repo is public, so nothing
 * account-specific (ids, ARNs, emails) belongs here; those come from GitHub
 * Actions variables and SSM at deploy time (see docs/SETUP.md).
 */
export default definePlatformConfig({
  domain: 'ericminassian.com',
  region: 'us-east-1',
  zone: 'platform.ericminassian.com',
  consoleHost: 'platform.ericminassian.com',
  edgeHost: 'edge.platform.ericminassian.com',
  loginHost: 'login.platform.ericminassian.com',
  github: { owner: 'eric-minassian', repo: 'platform', ownerId: 51006625, repoId: 1458054906 },
  members: [{ github: 'eric-minassian', role: 'admin' }],
  // Names already taken in the ericminassian.com root zone (github.com/eric-minassian/aws).
  // Delegated subdomains and static records beat the platform's `*` wildcard.
  reservedAppNames: [
    'orbit',
    'orbit-beta',
    'forma',
    'forma-beta',
    'putyourname',
    'putyourname-beta',
    'simply-personalized',
    'simply-personalized-beta',
  ],
  previewTtlDays: 7,
  limits: { appsPerMember: 50, stagesPerApp: 20 },
  telemetry: { logRetentionDays: { prod: 30, other: 7 } },
});
