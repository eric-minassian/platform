/**
 * Bindings: how the engine tells the runtime SDK where an app's resources are.
 * Serialized as JSON into the `PLATFORM_BINDINGS` environment variable of the
 * Web Function and the worker. Event Function env vars are capped at 4 KB in
 * total, so keep this compact (names, not policies).
 */
export const BINDINGS_ENV = 'PLATFORM_BINDINGS';

export interface Bindings {
  /** 2 since jobs were pushed (SDK 0.4.0): `queues` gave way to `jobs`. */
  v: 2;
  app: string;
  stage: string;
  /** Public hostname, e.g. `foo.ericminassian.com` or `foo.localhost:3000`. */
  host: string;
  /** Public origin, e.g. `https://foo.ericminassian.com`. */
  url: string;
  /** Deployment id currently running. */
  revision: string;
  region: string;
  /** Account id, so the SDK can build ARNs from the names below. */
  account: string;
  /** DynamoDB table backing `db` (present when `db: true`). */
  table?: string;
  /** Queues, events and crons (present when the stage has a worker). */
  jobs?: JobBindings;
  bus?: { name: string; arn: string };
  storage?: StorageBindings;
  secrets: { path: string; sharedPath: string; names: readonly string[] };
  auth?: AuthBindings;
  realtime?: RealtimeBindings;
  email?: EmailBindings;
  /** Worker function name: direct `invoke` jobs, and every handler not in `jobs.fns`. */
  worker?: string;
  /**
   * The stage's secret (32 random bytes, base64url), kept in SSM at
   * `names.stageKeyParameter`. The SDK derives a key per purpose from it, e.g.
   * to seal `db` query cursors. Absent on stages deployed before it existed.
   */
  stageKey?: string;
}

/**
 * Where jobs go and how often they're tried. Handlers are keyed `kind:name`
 * (`handlerKey`); only what differs from the default is listed, since Lambda
 * caps a function's environment at 4 KB.
 */
export interface JobBindings {
  /** Declared queues. */
  queues: readonly string[];
  /** Handlers that run in a function of their own, by key: its name. The rest run on `worker`. */
  fns: Record<string, string>;
  /** Handlers whose attempts aren't their kind's `DEFAULT_ATTEMPTS`, by key. */
  attempts: Record<string, number>;
  /** The stage's dead-letter queue's URL (`names.deadLetters`). */
  dead: string;
  /** The stage's schedule group, where retries and delayed sends are one-shot schedules. */
  group: string;
  /** The role Scheduler invokes them as: the stage's own. */
  role: string;
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

/** The shared storage bucket: a private store is `prefix + <name>/`, a public one `publicPrefix + <name>/`. */
export interface StorageBindings {
  bucket: string;
  prefix: string;
  /** Every store's name. */
  stores: readonly string[];
  /** The stores the edge serves at `STORAGE_PATH` (absent on stages deployed before there were any). */
  public?: readonly string[];
  publicPrefix?: string;
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

export interface EmailBindings {
  /** `ses` when deployed; `local` under `plat dev` / `plat test`, where the CLI captures mail and nothing is sent. */
  mode: 'ses' | 'local';
  /** The stage's address, e.g. `todo@mail.platform.ericminassian.com`. */
  from: string;
  /** Display name (`email.name`). */
  name?: string;
  /** SES tenant and configuration set (both `names.emailTenant`). */
  tenant: string;
  /** Recipients per UTC day. */
  dailyLimit: number;
  /** Table holding the stage's usage rows (the platform's telemetry table; `telemetryKeys.email`). */
  usageTable: string;
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
  if (b.v !== 2) throw new Error(`Unsupported ${BINDINGS_ENV} version ${String((b as { v?: unknown }).v)}`);
  return b;
}
