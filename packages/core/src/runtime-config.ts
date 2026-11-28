import { PROD_STAGE } from './constants.ts';
import { type Hosts, hostsOf } from './hosts.ts';
import { APPSYNC_PUBLISH_PATH, APPSYNC_REALTIME_PATH } from './realtime.ts';

/**
 * What the foundation produced: shared resources every stage deploy needs.
 * Stored as JSON in SSM at `platformNames.runtimeConfigParameter` by the
 * foundation deploy and read by the control plane (and by `plat dev`, which
 * builds an equivalent object pointing at the AWS Emulator).
 */
export interface PlatformRuntimeConfig {
  v: 1;
  /** `aws` for the real platform; `emulator` under `plat dev` / `plat test`. */
  target: 'aws' | 'emulator';
  accountId: string;
  region: string;
  /** Apex domain apps live under (`ericminassian.com`, or `localhost` locally). */
  domain: string;
  /** platform.config.ts `hosts`: what decides an aliased app's public URL (`appHost`). */
  hosts?: Hosts;
  /** Scheme + optional port used to build public URLs (`https`, or `http` + `:3000` locally). */
  publicScheme: 'https' | 'http';
  publicPort?: number;
  artifactsBucket: string;
  sitesBucket: string;
  storageBucket: string;
  stateTable: string;
  telemetryTable: string;
  /** Permission boundary attached to every per-stage role. */
  boundaryPolicyArn?: string;
  /** CloudFront KeyValueStore holding host → route records (absent locally). */
  kvsArn?: string;
  /** The router distribution; Web Function resource policies trust only this. */
  distributionArn?: string;
  /** The edge floor's alarm and trigger; absent without `limits.edgeFloorAt`. */
  edgeFloor?: EdgeFloorRuntimeConfig;
  /** Shared Cognito user pool for app end users. */
  userPoolId?: string;
  /** Hosted login origin, e.g. `https://login.platform.ericminassian.com`. */
  loginUrl?: string;
  /** JWKS base URL override (emulator); defaults to the public Cognito URL. */
  jwksBaseUrl?: string;
  /** SNS topic for platform alerts. */
  alertsTopicArn?: string;
  /** Telemetry processor (account-level log subscription target). */
  telemetryFunctionArn?: string;
  /** The AppSync Event API stages' channel namespaces live in (absent on platforms that predate it). */
  realtime?: RealtimeRuntimeConfig;
  /** The SES domain every stage sends from (absent on platforms that predate email). */
  email?: EmailRuntimeConfig;
}

/**
 * The edge floor (`limits.edgeFloorAt`): a CloudWatch alarm on the router
 * distribution's requests per minute, and an EventBridge rule that invokes
 * the control plane's worker when it goes off. The web ACL itself belongs to
 * the control plane, which creates it only while the floor is on.
 */
export interface EdgeFloorRuntimeConfig {
  alarmArn: string;
  /** The rule's ARN, which the worker's resource policy names. */
  ruleArn: string;
}

export interface EmailRuntimeConfig {
  /** Verified domain identity: `mail.<zone>` (`mail.localhost` in the emulator). */
  domain: string;
  identityArn: string;
}

export interface RealtimeRuntimeConfig {
  apiId: string;
  /** HTTP domain (`<id>.appsync-api.<region>.amazonaws.com`; `127.0.0.1:<port>` in the emulator). */
  httpDomain: string;
  /** Realtime (WebSocket) domain. */
  realtimeDomain: string;
}

/**
 * Where to publish and connect. AWS serves TLS; the emulator serves plain
 * HTTP and WebSocket on local ports.
 */
export function realtimeEndpoints(
  cfg: Pick<PlatformRuntimeConfig, 'target'>,
  rt: RealtimeRuntimeConfig,
): { publishUrl: string; websocketUrl: string } {
  const tls = cfg.target === 'aws';
  return {
    publishUrl: `${tls ? 'https' : 'http'}://${rt.httpDomain}${APPSYNC_PUBLISH_PATH}`,
    websocketUrl: `${tls ? 'wss' : 'ws'}://${rt.realtimeDomain}${APPSYNC_REALTIME_PATH}`,
  };
}

export function cognitoIssuer(region: string, userPoolId: string): string {
  return `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`;
}

export function cognitoJwksUri(
  cfg: Pick<PlatformRuntimeConfig, 'region' | 'jwksBaseUrl'>,
  userPoolId: string,
): string {
  const base = cfg.jwksBaseUrl ?? `https://cognito-idp.${cfg.region}.amazonaws.com`;
  return `${base.replace(/\/$/, '')}/${userPoolId}/.well-known/jwks.json`;
}

/**
 * The host a stage knows itself by, for its sign-in callbacks and the links
 * it builds: prod's first host in `hosts`, else its own `host`. The route
 * stays under `host`, which the alias reads.
 */
export function appHost(
  cfg: Pick<PlatformRuntimeConfig, 'hosts'>,
  app: string,
  stage: string,
  host: string,
): string {
  return (stage === PROD_STAGE && hostsOf(cfg.hosts, app)[0]) || host;
}

export function publicUrl(
  cfg: Pick<PlatformRuntimeConfig, 'publicScheme' | 'publicPort'>,
  host: string,
): string {
  const port = cfg.publicPort ? `:${cfg.publicPort}` : '';
  return `${cfg.publicScheme}://${host}${port}`;
}
