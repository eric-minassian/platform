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

export function publicUrl(
  cfg: Pick<PlatformRuntimeConfig, 'publicScheme' | 'publicPort'>,
  host: string,
): string {
  const port = cfg.publicPort ? `:${cfg.publicPort}` : '';
  return `${cfg.publicScheme}://${host}${port}`;
}
