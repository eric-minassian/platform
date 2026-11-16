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
 * The client's `ip:port` as the edge saw the connection; IPv6 is unbracketed
 * (`2001:db8::7:51234`). CloudFront sets it and replaces any copy a client
 * sends (so does `plat dev`), and Web Function endpoints only take requests
 * signed by the edge, so apps can trust it.
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

/** Lambda runtime for both Web Functions and worker (Event) Functions. */
export const NODE_RUNTIME = 'nodejs24.x';
