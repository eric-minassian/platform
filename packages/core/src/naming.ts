import { PROD_STAGE } from './constants.ts';
import { fingerprint } from './fingerprint.ts';
import { PUBLIC_STORAGE_ROOT } from './storage.ts';

/**
 * App names: 3-30 chars, lowercase letters/digits/single hyphens, starting with
 * a letter. `--` is reserved as the app/stage separator in hostnames and
 * resource names, so it can never appear inside a name. Minimum length 3 keeps
 * `--` out of DNS label positions 3-4 (reserved for IDNA `xn--`).
 */
export const APP_NAME_PATTERN = /^[a-z](?:[a-z0-9]|-(?!-)){1,28}[a-z0-9]$/;

/** Stage names: 2-20 chars, same alphabet. Examples: `prod`, `pr-12`, `local`. */
export const STAGE_NAME_PATTERN = /^[a-z](?:[a-z0-9]|-(?!-)){0,18}[a-z0-9]$/;

/** Keys inside a manifest (queue, cron, bucket names): 1-20 chars, no `--`. */
export const RESOURCE_KEY_PATTERN = /^(?!.*--)[a-z](?:[a-z0-9-]{0,18}[a-z0-9])?$/;

/** Event types an app publishes/subscribes to, e.g. `order.created`. */
export const EVENT_TYPE_PATTERN = /^[a-zA-Z][a-zA-Z0-9._:-]{0,63}$/;

/** Secret and env var names: `STRIPE_KEY`. */
export const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

/** Names the platform itself uses on the shared domain. */
export const PLATFORM_RESERVED_APP_NAMES = [
  'platform',
  'edge',
  'login',
  'auth',
  'api',
  'www',
  'mail',
  'admin',
  'console',
  'static',
  'assets',
  'cdn',
  'status',
  'local',
] as const;

export function validateAppName(name: string, extraReserved: readonly string[] = []): string | null {
  if (!APP_NAME_PATTERN.test(name)) {
    return `"${name}" must be 3-30 chars of a-z, 0-9 and single hyphens, start with a letter and end with a letter or digit`;
  }
  if ((PLATFORM_RESERVED_APP_NAMES as readonly string[]).includes(name) || extraReserved.includes(name)) {
    return `"${name}" is reserved`;
  }
  return null;
}

export function validateStageName(stage: string): string | null {
  if (!STAGE_NAME_PATTERN.test(stage)) {
    return `stage "${stage}" must be 2-20 chars of a-z, 0-9 and single hyphens, start with a letter`;
  }
  return null;
}

/** Stage name for a pull request preview. */
export function previewStage(prNumber: number): string {
  return `pr-${prNumber}`;
}

export function isPreviewStage(stage: string): boolean {
  return /^pr-\d+$/.test(stage);
}

/** Public hostname of an app stage: `foo.example.com` or `foo--pr-12.example.com`. */
export function stageHost(app: string, stage: string, domain: string): string {
  return stage === PROD_STAGE ? `${app}.${domain}` : `${app}--${stage}.${domain}`;
}

/** Inverse of {@link stageHost}. Returns null for hosts outside `domain`. */
export function parseStageHost(host: string, domain: string): { app: string; stage: string } | null {
  const h = host.toLowerCase().replace(/:\d+$/, '');
  const suffix = `.${domain}`;
  if (!h.endsWith(suffix)) return null;
  const label = h.slice(0, -suffix.length);
  if (label.includes('.')) return null;
  const sep = label.indexOf('--');
  if (sep === -1) return APP_NAME_PATTERN.test(label) ? { app: label, stage: PROD_STAGE } : null;
  const app = label.slice(0, sep);
  const stage = label.slice(sep + 2);
  if (!APP_NAME_PATTERN.test(app) || !STAGE_NAME_PATTERN.test(stage)) return null;
  return { app, stage };
}

/**
 * Deterministic AWS resource names. Everything for one stage shares the base
 * `<app>--<stage>`, so names are the state: the engine can always rediscover
 * what it owns. Limits: app ≤ 30 + stage ≤ 20 → base ≤ 52 chars.
 */
export const names = {
  base: (app: string, stage: string) => `${app}--${stage}`,
  table: (app: string, stage: string) => `${app}--${stage}`,
  /** The server's Lambda Web Function (instance mode). */
  webFunction: (app: string, stage: string) => `${app}--${stage}`,
  /**
   * The server's Lambda function in request mode. Not a worker function,
   * though it shares their `<app>--<stage>--` prefix: a handler's own
   * function is `…--worker--…`, or a cut of that ending in `-<hash>`.
   */
  requestFunction: (app: string, stage: string) => `${app}--${stage}--web`,
  /**
   * The Web Function's two endpoints, and the request-mode function's two
   * aliases (each with a function URL), each pinned to one revision or
   * version. Neither name means "current": a deploy uses whichever the live
   * route doesn't (`live` predates the second one).
   */
  webEndpoints: () => ['live', 'live-b'] as const,
  workerFunction: (app: string, stage: string) => `${app}--${stage}--worker`,
  /**
   * The function a queue, event or cron handler with its own memory or timeout
   * runs in, from the worker's bundle. Function names are ≤ 64 chars of
   * A-Z, a-z, 0-9, `-` and `_`: long names are hashed, and an event type's
   * `.` becomes `_` (which no event type contains). `:` has no such stand-in,
   * so a type with one always carries a hash of the type.
   */
  handlerFunction: (app: string, stage: string, kind: 'queue' | 'event' | 'cron', name: string) => {
    const full = `${app}--${stage}--worker--${kind}-${name}`;
    const safe = full.replaceAll('.', '_').replaceAll(':', '_');
    return name.includes(':') ? `${safe.slice(0, 55)}-${fingerprint([full])}` : fit(safe, 64);
  },
  /** IAM role name; created under {@link IAM_APP_PATH}. */
  role: (app: string, stage: string) => `${app}--${stage}`,
  /**
   * The stage's dead-letter queue (SQS, never polled): every job that failed
   * its last attempt. Queue keys can't contain `--` and the old dead-letter
   * queues end in `--dlq`, so this can't be a pre-0.4.0 queue's name.
   */
  deadLetters: (app: string, stage: string) => `${app}--${stage}--jobs--dead`,
  /** The SQS queue `plat dev` points the stage's event rules at, to run events in the local worker. */
  devEventTap: (app: string, stage: string) => `${app}--${stage}--plat-dev-events`,
  /** A queue's SQS queue and its dead-letter queue, before queues were pushed (0.4.0). */
  legacyQueue: (app: string, stage: string, key: string) => `${app}--${stage}--${key}`,
  legacyDeadLetterQueue: (app: string, stage: string, key: string) => `${app}--${stage}--${key}--dlq`,
  eventBus: (app: string, stage: string) => `${app}--${stage}`,
  /** EventBridge rule names are ≤ 64 chars; long event types are hashed. */
  eventRule: (app: string, stage: string, eventType: string) =>
    fit(`${app}--${stage}--${eventType.replace(/[^A-Za-z0-9._-]/g, '_')}`, 64),
  scheduleGroup: (app: string, stage: string) => `${app}--${stage}`,
  schedule: (cronKey: string) => cronKey,
  userPoolClient: (app: string, stage: string) => `${app}--${stage}`,
  /** SES tenant and its configuration set (≤ 64 chars each; the base is ≤ 52). */
  emailTenant: (app: string, stage: string) => `${app}--${stage}`,
  /** AppSync Events channel namespace; names are ≤ 50 chars, so long ones are hashed. */
  realtimeNamespace: (app: string, stage: string) => fit(`${app}--${stage}`, 50),
  /**
   * A stage's log groups. Lambda also writes a Web Function's environments to
   * `<web group>.local`, so the engine creates that one too.
   */
  logGroup: (app: string, stage: string, component: 'web' | 'web.local' | 'worker') =>
    `/platform/apps/${app}/${stage}/${component}`,
  logGroupPrefix: (app: string, stage?: string) =>
    stage ? `/platform/apps/${app}/${stage}/` : `/platform/apps/${app}/`,
  secretsPath: (app: string, stage: string) => `/platform/apps/${app}/${stage}/secrets/`,
  sharedSecretsPath: (app: string) => `/platform/apps/${app}/_shared/secrets/`,
  /** SSM SecureString holding the stage key (see `Bindings.stageKey`); outside the secrets path. */
  stageKeyParameter: (app: string, stage: string) => `/platform/apps/${app}/${stage}/stage-key`,
  /** A private store's prefix in the shared storage bucket: `<app>/<stage>/<store>/`. */
  storagePrefix: (app: string, stage: string, store?: string) =>
    store ? `${app}/${stage}/${store}/` : `${app}/${stage}/`,
  /** A public store's prefix in the shared storage bucket: `_public/<app>/<stage>/<store>/` (see `storage.ts`). */
  publicStoragePrefix: (app: string, stage: string, store?: string) =>
    `${PUBLIC_STORAGE_ROOT}${names.storagePrefix(app, stage, store)}`,
  /** Prefix inside the shared sites bucket for one deployment's static files. */
  sitePrefix: (app: string, stage: string, deploymentId: string) => `${app}/${stage}/${deploymentId}`,
  artifactKey: (app: string, stage: string, deploymentId: string, file: string) =>
    `${app}/${stage}/${deploymentId}/${file}`,
} as const;

/** All per-stage IAM roles live under this path so policies can scope to it. */
export const IAM_APP_PATH = '/platform/apps/';

/** Shared, account-scoped platform resources. */
export const platformNames = {
  artifactsBucket: (accountId: string, region: string) => `platform-${accountId}-${region}-artifacts`,
  sitesBucket: (accountId: string, region: string) => `platform-${accountId}-${region}-sites`,
  storageBucket: (accountId: string, region: string) => `platform-${accountId}-${region}-storage`,
  stateTable: 'platform',
  telemetryTable: 'platform-telemetry',
  keyValueStore: 'platform-routes',
  routerFunction: 'platform-router',
  userPool: 'platform-users',
  boundaryPolicy: 'platform-app-boundary',
  /** The AppSync Event API every stage's channel namespace lives in. */
  realtimeApi: 'platform-realtime',
  /** Its Lambda authorizer (signed-in subscribe tokens). */
  realtimeAuthorizer: 'platform-realtime-authorizer',
  /** Description of the API's subscribe-only key for `public` stages (how the control plane finds it). */
  realtimePublicKey: 'platform-public-subscribe',
  /** The control plane's own app name (services/control-plane/plat.config.ts), stage prod. */
  controlPlaneApp: 'platform',
  controlPlaneRole: 'platform-control-plane',
  ciRole: 'platform-ci',
  alertsTopic: 'platform-alerts',
  /**
   * The edge floor's AWS WAF web ACL, which the control plane creates and attaches to the router
   * while the floor is on; also its CloudWatch metric name. Not `platform-edge`, the always-on web
   * ACL the foundation stack used to own: the stack deletes that one only after updating the
   * distribution, so the two names can't collide while it goes.
   */
  edgeWebAcl: 'platform-edge-floor',
  /** Its rate-based rule, and that rule's metric name. */
  edgeFloorRule: 'requests-per-client',
  /**
   * The CloudWatch alarm on the router's requests per minute (`limits.edgeFloorAt`) that turns the
   * floor on, and the EventBridge rule that tells the control plane when it goes off.
   */
  edgeFloorAlarm: 'platform-edge-floor',
  /**
   * The router's access log (CloudFront standard logging, `EDGE_LOG_FIELDS`): its log group, and
   * the name of the delivery source, destination, resource policy and subscription filter that
   * feed it to the telemetry processor.
   */
  edgeLogGroup: '/platform/edge',
  edgeLogDelivery: 'platform-edge',
  runtimeConfigParameter: '/platform/config/runtime',
  sessionKeyParameter: '/platform/config/session-key',
  githubAppParameterPrefix: '/platform/config/github-app/',
} as const;

function fit(name: string, max: number): string {
  if (name.length <= max) return name;
  const hash = fingerprint([name]);
  return `${name.slice(0, max - 9)}-${hash}`;
}
