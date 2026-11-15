/**
 * Bindings: how the engine tells the runtime SDK where an app's resources are.
 * Serialized as JSON into the `PLATFORM_BINDINGS` environment variable of the
 * Web Function and the worker. Event Function env vars are capped at 4 KB in
 * total, so keep this compact (names, not policies).
 */
export const BINDINGS_ENV = 'PLATFORM_BINDINGS';

export interface Bindings {
  v: 1;
  app: string;
  stage: string;
  /** Public hostname, e.g. `foo.ericminassian.com` or `foo.localhost:3000`. */
  host: string;
  /** Public origin, e.g. `https://foo.ericminassian.com`. */
  url: string;
  /** Deployment id currently running. */
  revision: string;
  region: string;
  /** DynamoDB table backing `db` (present when `db: true`). */
  table?: string;
  queues: Record<string, { url: string; arn: string }>;
  bus?: { name: string; arn: string };
  /** Shared storage bucket; each named store is `prefix + <name>/`. */
  storage?: { bucket: string; prefix: string; stores: readonly string[] };
  secrets: { path: string; sharedPath: string; names: readonly string[] };
  auth?: AuthBindings;
  realtime?: RealtimeBindings;
  /** Worker function name, for direct `invoke` jobs. */
  worker?: string;
  /**
   * The stage's secret (32 random bytes, base64url), kept in SSM at
   * `names.stageKeyParameter`. The SDK derives a key per purpose from it, e.g.
   * to seal `db` query cursors. Absent on stages deployed before it existed.
   */
  stageKey?: string;
}

export interface AuthBindings {
  /** `cognito` in AWS; `local` under `plat dev` (local sign-in page, emulator Cognito). */
  mode: 'cognito' | 'local';
  userPoolId: string;
  clientId: string;
  /** Token issuer (`https://cognito-idp.<region>.amazonaws.com/<pool>`). */
  issuer: string;
  /** Where to fetch signing keys; the emulator serves them on its own endpoint. */
  jwksUri: string;
  /** Hosted login origin, e.g. `https://login.platform.ericminassian.com`. */
  loginUrl: string;
  required: boolean;
}

export interface RealtimeBindings {
  /** The stage's channel namespace. */
  namespace: string;
  /** AppSync's HTTP publish endpoint (`https://<domain>/event`; `http://127.0.0.1:<port>/event` locally). */
  publishUrl: string;
  subscribe: 'public' | 'signed-in';
  /** Declared channel patterns (`board`, `boards/*`): the SDK publishes only to these. */
  channels: readonly string[];
}

export function encodeBindings(b: Bindings): string {
  return JSON.stringify(b);
}

export function decodeBindings(raw: string | undefined): Bindings {
  if (!raw) {
    throw new Error(
      `${BINDINGS_ENV} is not set. This code must run on the platform (deployed, or under \`plat dev\` / \`plat test\`).`,
    );
  }
  const b = JSON.parse(raw) as Bindings;
  if (b.v !== 1) throw new Error(`Unsupported ${BINDINGS_ENV} version ${String((b as { v?: unknown }).v)}`);
  return b;
}
