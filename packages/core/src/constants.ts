/**
 * Platform-wide constants. These are the only values baked into published
 * packages; everything account-specific (account ID, bucket names, ARNs)
 * comes from the deployed platform at runtime, because this repo is public.
 */
export const PLATFORM_DEFAULTS = {
  /** Apps are served at `<app>.<domain>`; previews at `<app>--<stage>.<domain>`. */
  domain: 'ericminassian.com',
  region: 'us-east-1',
  /** Control plane: console + API. */
  apiUrl: 'https://platform.ericminassian.com',
  /** Audience the API expects in GitHub Actions OIDC tokens. */
  oidcAudience: 'https://platform.ericminassian.com',
  /** Local dev router. Apps are served at `http://<app>.localhost:<port>`. */
  localDomain: 'localhost',
  localPort: 3000,
} as const;

/** Prefix for every platform-owned path (auth, health) on every app host. */
export const PLATFORM_PATH_PREFIX = '/__platform/';
export const HEALTH_PATH = '/__platform/health';

/**
 * Body served at `HEALTH_PATH`: by the SDK when the stage has a server, else
 * by the edge router from its route record. `revision` is the deployment id,
 * so a poller can tell which deployment answered.
 */
export interface HealthResponse {
  ok: true;
  app: string;
  stage: string;
  revision: string;
}

/** Header the router sets so apps (and the cache key) see the public host. */
export const HOST_HEADER = 'x-platform-host';
/** Trace propagation header (W3C traceparent is also honored). */
export const TRACE_HEADER = 'x-platform-trace';

/**
 * The secret the router sends a request-mode server (a function URL anyone
 * can call) with each request: the stage's `originSecret`. The SDK answers
 * 403 to a request without it before any app code runs.
 */
export const ORIGIN_HEADER = 'x-platform-origin';

/**
 * The client's `ip:port` as the edge saw the connection; IPv6 is unbracketed
 * (`2001:db8::7:51234`). CloudFront sets it and replaces any copy a client
 * sends (so does `plat dev`), and servers only take requests from the edge
 * (Web Function endpoints signed ones, request-mode servers those carrying
 * `ORIGIN_HEADER`), so apps can trust it.
 */
export const VIEWER_ADDRESS_HEADER = 'cloudfront-viewer-address';
/** The client's country (ISO 3166-1 alpha-2), from the edge; absent locally. */
export const VIEWER_COUNTRY_HEADER = 'cloudfront-viewer-country';

/**
 * Partition-key prefix of the SDK's rate-limit counters in a stage's table
 * (`_rl#<limit>#<key>`). Collection names start with a letter, so no
 * document shares it; the data browser leaves these items out.
 */
export const RATE_LIMIT_PK_PREFIX = '_rl#';

/** How long the edge's request floor asks a client over it to wait: WAF counts the last minute. */
export const EDGE_RETRY_AFTER_SECONDS = 60;

/**
 * The control plane worker's invoke job that the edge floor's alarm runs when
 * it goes off (an EventBridge rule in the foundation stack): it turns the floor on.
 */
export const EDGE_FLOOR_JOB = 'edge-floor';

/**
 * The body of the edge floor's 429 (`limits.edgeRequestsPerMinute`): the SDK's
 * `RateLimited`, so a generated web client decodes it like an app's own 429.
 */
export const EDGE_RATE_LIMITED_BODY = {
  _tag: 'RateLimited',
  message: `Too many requests. Try again in ${EDGE_RETRY_AFTER_SECONDS} seconds.`,
  retryAfter: EDGE_RETRY_AFTER_SECONDS,
} as const;

/** Tags on every AWS resource the engine creates. */
export const TAGS = {
  managed: 'platform:managed',
  app: 'platform:app',
  stage: 'platform:stage',
} as const;

/** The production stage. Its host has no stage suffix. */
export const PROD_STAGE = 'prod';
/** Stage name used by `plat dev` against the AWS Emulator. */
export const LOCAL_STAGE = 'local';

/** Lambda runtime for Web Functions, request-mode servers and worker (Event) Functions. */
export const NODE_RUNTIME = 'nodejs24.x';
