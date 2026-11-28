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
  // Names beyond `<app>.ericminassian.com`: the personal site (eric-minassian/website) at www, and
  // the apex sent there. Each needs its record in the root zone pointing at the edge (the apex an
  // alias to the distribution, which a CNAME can't be), which github.com/eric-minassian/aws holds.
  hosts: {
    'www.ericminassian.com': { app: 'website' },
    'ericminassian.com': { redirect: 'www.ericminassian.com' },
  },
  previewTtlDays: 7,
  limits: {
    appsPerMember: 50,
    stagesPerApp: 20,
    emailsPerDay: 2000,
    // The edge floor: once the whole edge sees `edgeFloorAt` requests in a minute, a WAF web ACL
    // answers a client sending one host more than `edgeRequestsPerMinute` a minute with a 429,
    // until an hour after traffic drops back. Equal, so the floor is on whenever a single client
    // could be over its limit; the busiest minute before it (2026-11) was 748. Remove both for no floor.
    edgeRequestsPerMinute: 1000,
    edgeFloorAt: 1000,
  },
  telemetry: { logRetentionDays: { prod: 30, other: 7 } },
});
