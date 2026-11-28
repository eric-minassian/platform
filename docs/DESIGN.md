# Platform design

A personal, AI-first PaaS on a single AWS account. An agent (or a person) can
take an idea to `https://<app>.ericminassian.com` with auth, a database,
queues, events, cron, file storage, live updates to browsers, email, CI/CD,
preview environments and built-in observability, with no setup per app. Idle
apps cost about nothing.

Status: scaffold (November 2026). Decisions below were made with Eric; the
"Decision log" at the end records why.

## Goals and constraints

- **Zero setup per app.** Creating an app needs no DNS change, no
  certificate, no AWS credentials, no infrastructure code.
- **Apps never own infrastructure.** An app repo contains code plus a small,
  cloud-neutral `plat.config.ts`. No CloudFormation, CDK or AWS SDK calls in
  apps; the platform's control plane provisions everything with direct AWS API
  calls. Apps stay portable.
- **Cheap at rest.** Everything scales to zero. No NAT gateways, load
  balancers, customer-managed KMS keys or Secrets Manager.
- **Single AWS account** (`platform-prod` in Eric's existing organization; no
  per-app accounts). DynamoDB only for now.
- **Observability built in.** Every request, job and error is instrumented by
  the platform; `platform.ericminassian.com` shows it.
- **Invite-only.** Members are GitHub accounts listed in `platform.config.ts`.
- **CLI-first for AI.** `plat` is the interface for agents (everything has
  `--json`). No MCP server.
- **Graduation stays possible.** A successful app can move to its own account
  without code changes.

## Architecture

```
                        *.ericminassian.com  (root zone, eric-minassian/aws: `*` CNAME → edge.platform…)
                                   │
                  ┌────────────────▼─────────────────┐
                  │ CloudFront distribution (router) │  one for all apps, wildcard cert
                  │  viewer-request CloudFront Fn ───┼──► KeyValueStore: host → route record
                  └───────┬─────────────────┬──────┬─┘
              static      │                 │      │  /__platform/realtime: WebSocket (no OAC)
                          │                 │      └─────────────────────────────────┐
                          │                 │  server (OAC, or the origin secret)    ▼
                          ▼                 ▼                              AppSync Event API (one;
         S3 sites bucket (per deploy)   Web Function or request Lambda       a namespace per stage)
                                            │  (fetch handler, SDK wrapper)          ▲ publish (IAM)
     ┌──────────────────────────────────────┼─────────────────────────────────────┐  │
     │ per stage:  DynamoDB table · SQS dead-letter queue · EventBridge bus ·      ├─┘
     │             Scheduler group · worker Lambda (queues/events/crons) · Cognito │
     │             channel namespace · SES tenant · IAM role (scoped, boundary) ·  ├──► SES (mail.platform…,
     │             log groups                                                      │     a tenant per stage)
     └──────────────────────────────────────┬─────────────────────────────────────┘
                                            │ stdout JSON telemetry
                              CloudWatch Logs ──(account-level subscription)──► telemetry processor
                                                                                   │ rollups, error groups
     platform.ericminassian.com  (the control plane, itself a platform app)       ▼
       API /v1 + console · deployer · pinger · cost · reaper ◄────────── telemetry + state tables
```

### Components

| Component                                  | What it is                                                                                                                                                                                                                                                                   |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core`                            | Contracts shared by everything: naming, app config schema, bindings, telemetry schema, router decision, and the control plane API (`PlatformApi`), all as Effect schemas. Isomorphic.                                                                                        |
| `packages/sdk` (`@ericminassian/platform`) | What app code imports: every resource as an Effect service, `toFetchHandler`/`defineWorker`, and an in-memory platform for tests. Also the server wrapper (a Web Function's HTTP server, or a request-mode Lambda handler) and the worker dispatcher, all auto-instrumented. |
| `packages/engine`                          | Idempotent "ensure" drivers over the AWS SDK. Deploys, rolls back and destroys stages. Also wraps the AWS Emulator.                                                                                                                                                          |
| `packages/cli` (`@ericminassian/plat`)     | `init`, `dev`, `test`, `build`, `deploy`, `apps`, `logs`, `metrics`, `errors`, `traces`, `data`, `secrets`, `rollback`, `destroy`.                                                                                                                                           |
| `services/control-plane`                   | The `platform` app: API, console, deployer, telemetry processor, uptime pinger, cost collector, compute chooser, preview reaper, storage expiry.                                                                                                                             |
| `foundation/`                              | The platform's shared resources (DNS, certificates, router, buckets, tables, Cognito, the realtime Event API and its authorizer, the SES mail domain, IAM) as one CDK stack, and the deploy that brings up the control plane on them.                                        |
| `templates/app`                            | What `plat init` copies: an Effect app (HttpApi server, worker, React SPA on a generated client) with auth, a todo collection, a queue, an event, a cron, a file store, and agent docs.                                                                                      |

## The app contract

### `plat.config.ts`

```ts
import { channel, defineApp, event, queue } from '@ericminassian/platform/config';
import type { EmailJob, TodoCreated, TodoChanged } from './src/domain.ts';

const app = defineApp({
  name: 'todo',
  description: 'Shared todo lists', // the public directory shows it; `listed: false` keeps the app out
  web: {
    server: 'src/server.ts',
    static: 'web/dist',
    build: 'pnpm --dir web build',
    dev: { command: 'pnpm --dir web dev' }, // listens on $PLATFORM_DEV_WEB_PORT
    spa: true,
    serverRoutes: ['/api/'],
    compute: 'auto', // or 'request' / 'instance': how the server runs (see Compute)
  },
  auth: true, // or { required: true }
  db: true, // one document DB per stage; collections are declared in code
  worker: { timeoutSeconds: 120, memoryMb: 1024 }, // every handler's, unless it sets its own
  queues: { emails: queue<EmailJob>({ maxAttempts: 3 }) },
  events: { 'todo.created': event<TodoCreated>() }, // event types the worker subscribes to
  crons: {
    cleanup: '0 3 * * *', // 5-field UTC cron or rate(...)
    listen: { schedule: 'rate(1 minute)', memoryMb: 256, timeoutSeconds: 90 }, // its own function
  },
  storage: { uploads: {}, exports: { public: true, expireAfterDays: 7 } }, // or ['uploads']
  secrets: ['STRIPE_KEY'],
  env: { FEATURE_X: 'on' },
  realtime: {
    subscribe: 'signed-in', // or 'public' (the default)
    channels: { 'user/*': channel<TodoChanged>() }, // browsers subscribe; server and worker publish
  },
  email: { name: 'Todo', dailyLimit: 500 }, // or `true`; sends from todo@mail.platform.ericminassian.com
});
export default app;

declare module '@ericminassian/platform/config' {
  interface Register {
    app: typeof app;
  }
}
```

- **Schema.** `AppConfig` (what authors write) and `ManifestSchema` (what the
  CLI and API validate) live in `packages/core/src/manifest.ts`. Keep them
  small: every field is a promise the platform keeps on any cloud.
- **Evaluation.** `plat` finds the nearest `plat.config.ts`, bundles it with
  esbuild (packages stay external), imports the result and validates the
  default export's JSON form. That JSON is what `plat build` writes to
  `manifest.json` and `plat deploy` sends, so the control plane never runs app
  code.
- **Typed code.** `Register` hands the literal config to the SDK
  (`packages/sdk/src/register.ts`). `plat.config.ts` augments it in
  `@ericminassian/platform/config`, the one SDK module every app imports.
  - Queue, event, store and secret names must be declared ones, and only a
    `public` store has a public URL.
  - Bodies and details must match `queue<T>()` / `event<T>()`.
  - Realtime channels must match a declared pattern (`board`, or `boards/*`
    for every channel below it), and their events `channel<T>()`, both where
    the server publishes and where the browser subscribes.
  - `defineWorker` must handle exactly the declared queues, events and crons.

### Code

- **Server**: the default export of `web.server` is `toFetchHandler(layer)`,
  which serves an `HttpApi` and passes route patterns, logs and the error
  behind a 500 to the platform's telemetry. `plat build` bundles it with the
  SDK's `serve`, which adds the platform routes and request telemetry around
  it and runs either way the platform runs a server (see
  [Compute](#compute)): it listens on `AWS_LAMBDA_HTTP_ENDPOINT` (a Web
  Function, and `plat dev`), and otherwise exports the streaming handler a
  request-mode function calls per request. App code is the same in both.
- **Worker**: `export default defineWorker({ layer, queues, events, crons })`.
  One bundle per stage handles all of them; the wrapper dispatches on event
  shape, and retries or dead-letters a failed run (see [Jobs](#jobs)).
  Handlers get the payload types declared in `plat.config.ts` and run on
  `layer`.
  - The worker's Lambda runs every handler with `worker.memoryMb` and
    `worker.timeoutSeconds`.
  - A queue, event or cron that sets its own `memoryMb` or `timeoutSeconds`
    (`queue<T>({ memoryMb })`, `event<T>({ timeoutSeconds })`, a cron's
    object form), or a queue that sets `concurrency`, runs in a Lambda of
    its own: the same bundle, environment and log group, with its triggers
    pointed there. A setting it leaves out is the worker's.
- **Resources**: only through `@ericminassian/platform`, as Effect services.
  `Db.collection()` maps collections onto the stage's single table
  (partition/sort keys, up to three pinned index slots, TTL), so adding a
  collection needs no deploy-time provisioning; documents are encoded and
  decoded with a schema. `db.transact` writes across collections all or none
  (TransactWriteItems); `putMany`/`deleteMany` batch writes that needn't be.
  `@ericminassian/platform/api` holds the browser-safe pieces an `HttpApi`
  definition shares with its web client.
- **Realtime**: the server and worker publish with the `Realtime` service; the
  browser subscribes with `RealtimeClient` from `@ericminassian/platform/client`.
  See [Realtime](#realtime).
- **Email**: the server and worker send with the `Email` service. See
  [Email](#email).
- **Rate limits**: `RateLimits` checks limits in the server and worker, and
  `RateLimits.middleware` puts one in front of `HttpApi` endpoints. See
  [Rate limits](#rate-limits).
- **Storage**: the `Storage` service's stores; browsers fetch a public store's
  files with `storageUrl` from `@ericminassian/platform/client`. See
  [Storage](#storage).
- **Unit tests**: `Platform.layerMemory()` runs every resource in memory. Its
  `Db` stores items exactly as DynamoDB holds them, and one test scenario runs
  against both it and DynamoDB in the emulator.

### Bindings

The engine passes resource names to the runtime in one environment variable,
`PLATFORM_BINDINGS` (JSON, `packages/core/src/bindings.ts`): account, table,
jobs (declared queues, handlers' own functions and attempts, the dead-letter
queue, the schedule group and role), bus, storage prefix, secrets paths, auth
settings, realtime namespace and
publish endpoint, email sender and tenant, worker name, public URL, and the
stage key. The stage key is
a random secret the engine creates once per stage in SSM. The SDK seals `db`
query cursors and signs realtime subscribe tokens with keys derived from it, so
cursors are opaque and neither can be forged.

## Naming: names are the state

Everything for a stage shares the base `<app>--<stage>` (`--` cannot appear in
app or stage names), so the engine can always rediscover what it owns from
names plus `platform:app` / `platform:stage` tags. There is no state file to
lose. App names are 3–30 chars; stages 2–20 (`prod`, `pr-12`, `local`).

| Resource     | Name                                                                                                                                                                  |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host         | `todo.ericminassian.com`, previews `todo--pr-12.ericminassian.com`                                                                                                    |
| Server       | Web Function `todo--prod` (endpoints `live`, `live-b`); request-mode function `todo--prod--web` (aliases `live`, `live-b`, a function URL each)                       |
| Worker       | `todo--prod--worker`; a handler's own `…--worker--<queue\|event\|cron>-<name>` (`.` and `:` in event types become `_`; hashed past 64)                                |
| Table        | `todo--prod`                                                                                                                                                          |
| Dead letters | SQS `todo--prod--jobs--dead` (queues from before 0.4.0 were `todo--prod--emails` / `…--dlq`)                                                                          |
| Bus / rules  | `todo--prod` / `todo--prod--<event>`                                                                                                                                  |
| Schedules    | group `todo--prod` (crons; jobs' retries and delayed sends `_q-<queue>-<id>`, `_c-…`, `_e-<hash>-…`)                                                                  |
| Channels     | namespace `todo--prod` in `platform-realtime` (hashed past 50)                                                                                                        |
| Email        | `todo@mail.platform.ericminassian.com` (previews `todo--pr-12@…`); SES tenant and configuration set `todo--prod`; usage rows `mail#todo#prod` in `platform-telemetry` |
| Role         | `/platform/apps/todo--prod`                                                                                                                                           |
| Logs         | `/platform/apps/todo/prod/{web,web.local,worker}`                                                                                                                     |
| Secrets      | `/platform/apps/todo/{prod,_shared}/secrets/NAME`                                                                                                                     |
| Stage key    | `/platform/apps/todo/prod/stage-key`                                                                                                                                  |
| Static files | `s3://platform-<acct>-<region>-sites/todo/prod/<deploymentId>/`                                                                                                       |
| Storage      | `s3://platform-<acct>-<region>-storage/todo/prod/<store>/`; public stores `…-storage/_public/todo/prod/<store>/`                                                      |

## Routing

One CloudFront distribution serves `*.ericminassian.com` with one wildcard
certificate. A viewer-request CloudFront Function (JS runtime 2.0) looks up the
`Host` in a CloudFront KeyValueStore and applies `decide()`
(`packages/core/src/router/decide.js`; the same file is inlined at the edge and
used by `plat dev`):

- `/__platform/*` and server routes (`/api/` by default) go to the stage's
  server, in whichever compute mode the route record names (see
  [Compute](#compute)). The function calls `cf.updateRequestOrigin()`:
  - a Web Function endpoint (instance mode) with OAC (origin type `lambda`,
    signing `always-amz-auth`). That signing mode sends bodies as
    `UNSIGNED-PAYLOAD`, so browsers can POST without hashing;
  - a function URL (request mode, the record's `c: 'r'`) without OAC, which
    would make every client send `x-amz-content-sha256` with a body. It adds
    the stage's origin secret (the record's `k`) as the custom origin header
    `x-platform-origin`, after deleting any copy the viewer sent: CloudFront
    answers 502 when a viewer header has the name of one the function adds.
- Files go to the sites bucket under the live deployment's prefix. SPA paths
  get `index.html`.
- `/__platform/realtime` belongs to the router when the stage has realtime
  (the route record's `rt`). A WebSocket handshake goes to the AppSync
  realtime endpoint (no OAC); a plain GET is answered with the browser's
  connection settings. See [Realtime](#realtime).
- `/__platform/storage/<store>/<key>` belongs to the router: a store in the
  route record's `p` is served from the storage bucket, anything else is a 404. See [Storage](#storage).
- A stage without a server has nothing to answer `/__platform/health`, so the
  function answers it from the route record (`revision` is the record's
  deployment id). Every routed stage reports which deployment it serves, for
  the deployer, `plat deploy`/`plat rollback` and the uptime pinger.
- Unknown hosts get a 404.

While the whole edge is busy, an AWS WAF web ACL runs before the function:
the edge floor, which answers a client sending one host more than
`limits.edgeRequestsPerMinute` requests a minute with a 429. See
[Rate limits](#rate-limits).

The cache key includes the rewritten URI (static keys contain the deployment
id) plus `x-platform-host`, so apps never share cache entries. The origin
request policy is `AllViewerExceptHostHeader` (Web Functions 404 on a foreign
Host, and function URLs need their own). Hashed assets are immutable;
`index.html` revalidates.

A new app or preview is a single KVS entry: no DNS, certificate or
distribution change. Rollback is pointing the entry back.

## Compute

A stage's server runs in one of two modes, from one bundle. Which one costs
less depends on how busy the stage is, so the platform picks
(`packages/core/src/web-compute.ts`):

| Mode       | What runs                                                              | Billed                                                                                                                     |
| ---------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `request`  | a Lambda function (arm64, `web.memoryMb`, default 1024 MB) per request | each invocation's duration and INIT by the GB-second, and requests; from the account's free tier first; nothing while idle |
| `instance` | a Lambda Web Function; one environment serves up to `web.concurrency`  | the memory an environment uses for its whole life (until ~290 s after its last request), vCPU while it works, and requests |

Overlapping requests are what a Web Function bills once and request mode
bills each, so request mode is cheaper until a stage keeps requests in flight
most of the time. A visit to an otherwise idle app costs ~$0.00027 on a Web
Function (an environment kept ~290 s) and ~$0.000008 in request mode (a cold
start's ~0.55 s INIT at 1 GB, and the request); each further request while
the environment is warm, ~$0.0000003.

```
plat.config.ts  web.compute: 'auto' (default) | 'request' | 'instance'
deployer        webComputeFor: previews → request; prod → the stage's mode, request at first;
                a build before SDK 0.4.0 → instance (and 'request' refuses it)
engine          request: publish a version → the alias the live route doesn't use → its function URL
                instance: create a revision → the endpoint the live route doesn't use
daily chooser   prod servers: simulateWebCompute(last days of minute rollups) → estimate on the stage
                auto, other mode ≥ 25% cheaper 3 days running → a platform deployment in that mode
```

- **Request mode.** The function is `<app>--<stage>--web` (`index.handler`),
  logging JSON at system level WARN. Like a Web Function's two endpoints, it
  has two aliases (`live`, `live-b`), each with a function URL (auth `NONE`,
  invoke mode `RESPONSE_STREAM`) and the two grants such URLs need: invoking
  the URL, and invoking the function only through a URL. A deploy publishes a
  version and points the alias the live route doesn't use at it, so the route
  flip switches files and server together; the newest three versions and the
  aliases' are kept.
- **The origin secret.** A function URL takes requests from anyone, so the
  SDK answers 403 to a request without `x-platform-origin`, compared in
  constant time, before any app code runs, and strips the header from what
  the app sees. The secret is HKDF of the stage key (`originSecret`): the
  engine writes it into the route, the SDK derives it from its bindings, and
  nothing else stores it. Requests that get through are the router's, so
  `cloudfront-viewer-address` can be trusted in both modes.
- **The SDK in request mode** turns a function URL event into a `Request`
  (cookies rejoined, base64 bodies decoded), runs the same platform fetch as
  a Web Function (platform routes, auth, telemetry), and streams the
  `Response` back: status, headers (repeated ones comma-joined), each
  Set-Cookie, and the body as the app produces it. Lambda sends the status
  and headers only with the first write, so a bodiless response writes an
  empty chunk. A request's event is at most 6 MiB, so a request body is at
  most ~6 MB, or ~4.7 MB of binary (sent base64-encoded); a response streams
  up to 200 MB. `env` lines say which mode a server runs in.
- **Instance mode.** Endpoints run at most `web.maxEnvironments` environments
  (prod, default 10; previews 2): Lambda keeps spare, billed environments next
  to busy ones (CI bursts ran 9–25 at once), and the cap bounds them.
  Revisions log at system level WARN, which drops the runtime's per-minute
  `platform.invokeSummary` and its init, invoke and spin-down records; the
  SDK's `env` and `req` lines carry the same facts.
- **The account's concurrency.** Request-mode servers share the account's
  Lambda concurrency with every worker, and a throttled function URL answers
  errors; Web Functions scale on their own vCPU quota. So `auto` runs request
  mode only on an account whose "Concurrent executions" limit is at least
  100 (`REQUEST_MODE_MIN_ACCOUNT_CONCURRENCY`; a new account has 10, which one
  burst of browser tests on a preview exceeds): below it, deploys run
  instance mode with a warning saying why, and the chooser estimates but
  doesn't switch to request mode. `web.compute: 'request'` still runs, with
  the warning. The control plane reads the limit (`GetAccountSettings`) on
  each deploy and chooser run, so raising the quota needs no deploy of the
  platform.
- **Both modes stay.** A deploy builds only the active mode and leaves the
  other mode's server as it is (both cost nothing idle), so a switch back or a
  rollback across modes finds it. Dropping `web.server`, or destroying the
  stage, deletes both.
- **The chooser** (`compute`, daily) prices each prod server's traffic in
  both modes from the whole-stage minute rollups (what they keep: 3 days),
  which sum each minute's handling time (`dur`) and the INIT its starts
  reported. A minute's concurrency is its handling time over 60 s:
  - request: handling time and cold starts' INIT, by memory, and requests;
    a minute needs as many environments as its concurrency, and ones idle
    longer than 5 minutes are gone;
  - instance: environments alive from each busy minute until ~290 s after
    it, as many as its concurrency over `web.concurrency`, by the peak memory
    CloudWatch reports (`AWS/Lambda/Web` `EnvironmentMaxMemoryUsage`, else
    256 MB); vCPU for the share of the minute a request is in flight
    (1 − e^−concurrency); and requests.

  The estimate stays on the stage (the console's Cost tab, `plat apps show`).
  On `auto`, once the other mode has been at least 25% cheaper three days
  running (the streak is kept on the stage), the chooser creates a deployment
  of the live deployment's build in that mode, actor `platform`, with the
  reason as its message and `computeSwitchOf` naming the build; the deployer
  runs it like any other, so it shows in the deployment history and can be
  rolled back. Like any deployment it also redeploys the worker. A stage that
  is deploying waits for the next day, and a build whose artifacts expired (90
  days) stays due until the next deployment.

- **Rollback** restores the target deployment's mode, pointing that mode's
  alias or endpoint at its version or revision first if neither has it, and
  refuses one whose build was cleaned up.
- **The control plane** runs its own server in instance mode: a Web Function
  scales on its own vCPU quota, so the console keeps answering when apps'
  request-mode servers and workers use up the account's Lambda concurrency.

## Storage

Named file stores in one shared bucket. A private store is reached through
presigned URLs; a **public** store (`{ public: true }`) is served from the edge
on the app's own host, with no Web Function in the path, for large read-mostly
files such as feed snapshots.

```
worker   storage.store('exports').put('fires/1105.json', body, { cacheControl: 'public, max-age=31536000, immutable' })
           → s3://…-storage/_public/todo/prod/exports/fires/1105.json   (Content-Type, Cache-Control on the object)
browser  GET /__platform/storage/exports/fires/1105.json              (storageUrl('exports', key), same origin)
           → behavior /__platform/storage/* → router: 'exports' is in the route's `p`
           → /todo/prod/exports/fires/1105.json; query string, cookies, Authorization dropped
           → edge cache, else S3 through OAC with origin path /_public
```

- **Isolation.** Public stores live under `_public/` (no app name starts with
  `_`), and the bucket policy lets the router distribution read and list
  `_public/` and nothing else, so a routing mistake can't expose a private
  store or its key names. Listing makes a missing file a 404 rather than S3's 403.
- **The router.** The same function runs on a second cache behavior,
  `/__platform/storage/*`, whose origin is the storage bucket. It refuses keys
  with `.` or `..` segments (also percent-encoded) and drops the query string:
  CloudFront signs OAC requests, so S3 would honor `response-content-type` and
  the other `response-*` overrides. The key stays percent-encoded; S3 decodes
  it.
- **Its own cache entries.** CloudFront's cache key is the rewritten URI plus
  `x-platform-host`, not the behavior or origin, and a server-only app's
  server gets `/<app>/<stage>/<store>/<key>` unchanged. So the router sets
  `x-platform-host` to a value no host has (`STORAGE_CACHE_HOST`) for a public
  store's file: otherwise a request to that path could put the server's
  response in the file's place. The router sets the header on every request
  it forwards, so a client can't choose it.
- **Headers.** A response headers policy on that behavior only adds
  `X-Content-Type-Options: nosniff` and `Content-Security-Policy: script-src
  'none'`, so a file a user uploaded can't run script on the app's origin,
  where its session cookie lives (`sandbox` would also keep PDFs from opening
  in Chrome). A file without its own `Cache-Control` gets `no-cache`.
- **Caching.** Objects carry their own `Content-Type` (from the key's extension
  unless given) and `Cache-Control` (`put`/`uploadUrl` take both), and the
  edge caches by it, so a versioned key can be immutable for a year. With the
  cache policy's default TTL of 0, a file without one is revalidated against
  S3 on each request. CloudFront compresses JSON and text up to 10 MB. A
  missing file's 404 is cached for about 10 s (the distribution's error
  caching), so a key asked for before it's written can stay missing that
  long.
- **Lifecycle.** The route's `p` changes at the flip, like the rest of the
  route: a store is served once the deployment that makes it public is live,
  and stops being served when one that doesn't is, even for files cached for a
  year, because the router runs before the cache. Rollback restores the
  earlier route's `p`. A stage with public stores is routed even without
  `web`; a stage left with nothing to serve loses its route.
- **Changing visibility.** A store's files are where its kind is read, so a
  store with files can't switch between public and private: deploy refuses
  it, before changing anything, and asks for a new store. Moving the files
  during the deploy would race the live deployment, which keeps writing to the
  old place until the edges switch. The live route's `p` says what each store
  was.
- **Expiry.** `expireAfterDays` (any store) is a daily control-plane job,
  `storage-expiry`, that deletes files not written for that many days in the
  stores of every live stage: a LIST per 1,000 files a day, and deletes are
  free. Not S3 lifecycle rules: a bucket has one lifecycle document, shared by
  every app, which concurrent deploys would rewrite with no conditional write
  (a dropped rule keeps data, a resurrected one deletes it), and the
  foundation's drift-reverting deploys own that bucket's configuration.
- **Abuse.** Reads never reach the app, so rate limits don't cover them,
  as with static files. A cached file costs only CloudFront; since query
  strings are dropped, only a key that isn't cached costs an S3 GET, and a
  missing one's 404 is cached for about 10 s. Writes always go through the
  app: an endpoint that hands out `uploadUrl` for a public store should be
  rate-limited, since whatever is uploaded is served to anyone.
- **`plat dev`** serves public stores from the emulator's bucket with the same
  headers, `Range` and `If-None-Match`, and relays browser uploads: the
  emulator refuses a presigned request that carries an `Origin` header, which
  every browser upload sends, so under `plat dev` (only) `uploadUrl` points at
  the router's `/__plat_dev/upload?to=<presigned URL>`, which forwards the PUT
  without it. Only presigned URLs on the emulator's endpoint are relayed.

## Jobs

Queue messages, events and cron runs are pushed, never polled, so a stage
with ten queues costs nothing until a message arrives. (An SQS queue with a
Lambda event source mapping costs ~$0.26 a month in empty receives: about
890 an hour, measured on a production queue in November 2026.)

```
queues.send(body)          → lambda:Invoke (Event) on the function the queue's handler runs in
queues.send(body, {delay}) → one-shot Scheduler schedule `_q-<queue>-<id>` → that function, at the time
EventBridge rule / Scheduler cron → the event's or cron's function (async)
worker wrapper  run the handler ─ ok ─────────────────────────────► done
                                └ failed, attempts left ─► schedule attempt n+1 (1, 2, 4 … min, ≤ 1 h)
                                └ failed, last attempt ──► SQS `<app>--<stage>--jobs--dead`
Lambda          crash / timeout ─► 2 retries ─► on-failure destination ─► the same queue
Scheduler, EventBridge  couldn't deliver ─► their dead-letter config ─► the same queue
console, plat jobs      list · redrive (from attempt 1, to the handler's function now) · discard
```

- **One payload** (core `jobs.ts`): `{ __platform: 'job', kind, name, id,
  attempt, sentAt, body | detail, trace }`. The wrapper turns EventBridge
  events and cron firings into it on arrival, so retries, dead letters and
  redrive treat all three alike. Delivery is at least once, in no set order,
  as with SQS.
- **Retries are the SDK's.** A failed run schedules the next attempt and the
  invocation succeeds, so Lambda doesn't retry it as well; `maxAttempts`
  (queues 5, events and crons 3, which is what Lambda's two retries gave them
  before) decides. Lambda's own retries are left for crashes and timeouts,
  where the wrapper never got to decide. If scheduling the next attempt
  fails, the invocation fails, and Lambda retries it.
- **Dead letters** live in one SQS queue per stage that nothing polls ($0 at
  rest, 14 days). Four writers share it and `readDeadLetter` reads them all:
  the SDK (its own record, with the error), Lambda's on-failure destination
  (crashes, timeouts, and events throttled for over six hours), Scheduler's
  dead-letter config (a retry, delayed send or cron firing it couldn't
  deliver) and EventBridge's (an event it couldn't deliver after a day). The
  queue's policy lets only this stage's rules send to it; the rest send as
  the stage role. Events and crons had no dead-letter destination before:
  failed ones were dropped after Lambda's two retries.
- **Delays and retries are one-shot schedules** in the stage's group
  (`ActionAfterCompletion: DELETE`), invoking the function as the stage role.
  Scheduler fires within about a minute and refuses past times, so a delay
  shorter than a minute waits about a minute. Their names lead with `_` and
  the queue or cron, so the console counts what's waiting per queue by
  prefix, and cron schedules (a cron key starts with a letter) never collide
  with them.
- **Limits.** A payload is at most 240 KB of JSON: Scheduler caps a
  schedule's input at 256 KB, and a dead letter wraps the payload with its
  error. `queue({ concurrency })` is the queue's function's reserved
  concurrency (which needs the account's quota to spare it); messages past it
  wait in Lambda's async queue for up to six hours, then dead-letter. There's
  no batching: each message is one invocation, which costs less than SQS's
  send, receive and delete did ($0.20 a million against $1.20).
- **Queues from before 0.4.0** drain: the engine keeps a queue's event source
  mapping while it holds messages (the wrapper still reads SQS batches),
  deletes it once empty, and moves its old dead-letter queue's messages into
  the stage's. Deployments built with an older SDK are refused
  (`MIN_SDK_VERSION`): their workers can't read pushed jobs.
- **The control plane** runs deploys and destroys on a `stages` queue with a
  1 GB function of its own and one attempt (the watchdog fails a deploy whose
  run died; a deploy is retried by deploying again), so its worker, which
  also runs the telemetry processor, needs 512 MB instead of 1 GB.
- **Local.** The emulator's Lambda can't run the worker and its Scheduler
  never fires, so the SDK hands jobs to a dispatcher in the CLI process
  (`PLATFORM_LOCAL_WORKER_URL`), which runs them in the local worker now or
  when they come due. Waiting jobs survive the worker's restarts on edits. A
  crash lands in the emulator's dead-letter queue as Lambda's record would.

## Realtime

Live updates to browsers (shared boards, presence, notifications) on AWS
AppSync Events: managed WebSocket pub/sub, $0 at rest. Lambda Web Functions
don't take WebSocket upgrades, and holding server-sent event streams open
bills memory and can't reach streams held by another environment.

```
browser  GET /__platform/realtime        → router answers RealtimeClientConfig from the route store
         GET /__platform/realtime/token  → Web Function (SDK): a subscribe token   [signed-in stages]
         WSS /__platform/realtime        → router → AppSync realtime endpoint (subscribe only)
server, worker  Realtime.publish()       → SigV4 POST to AppSync /event with the stage role
AppSync ──AWS_LAMBDA──► platform-realtime-authorizer (verifies tokens with the stage key)
```

- **One Event API** (`platform-realtime`, foundation stack) with API key, IAM
  and Lambda auth. Each stage that declares `realtime` gets a channel
  namespace; app channels `board` or `boards/b1` are `/<namespace>/<channel>`
  in AppSync. Events aren't stored: a browser re-reads what it shows each time
  it (re)connects.
- **Browsers only subscribe.** Every namespace takes publishes from IAM alone,
  and a stage's role may publish only to its own namespace. AppSync can't
  rate-limit a client and each publish fans out to every subscriber, so a
  client able to publish could run up the bill; anything a browser sends goes
  through the app's server, throttled and batched there.
- **`subscribe: 'public'`** namespaces accept the platform's subscribe-only API
  key, served to browsers by the router. The control plane owns the key, not
  the foundation stack, whose drift-reverting deploys would undo extensions.
  Its daily `realtime-key` job (and any realtime deploy) extends the key to a
  year out once it has less than 11 months left. The key and AppSync's domains
  sit in one route-store entry (`REALTIME_KVS_KEY`), so a replaced key reaches
  every app at once.
- **`subscribe: 'signed-in'`** namespaces accept tokens from the Lambda
  authorizer only. The session is an HttpOnly cookie that AppSync never sees,
  and handing the Cognito token to page JavaScript would let any XSS steal the
  session, so the SDK issues its own: `pt1.<claims>.<HMAC>` with app, stage,
  user and a 15-minute expiry, keyed by HKDF of the stage key. The authorizer
  reads the stage key from SSM, checks the namespace, and keeps `user/<id>/…`
  channels to that user (a wildcard that could reach another user's channels
  is refused); every other channel is open to any signed-in user of the app.
  Subscriptions already open outlive the token.
- **The endpoint is the app's own host.** AppSync requires the auth header's
  `host` to be its HTTP domain, which the browser learns from the router's
  config answer; the WebSocket itself is same-origin, so there's no extra DNS,
  certificate or CORS. CloudFront drops `Upgrade` and `Connection` before
  functions run, so the router recognizes a handshake by `Sec-WebSocket-Key`.
- **The browser client** keeps one shared socket, resubscribes after
  reconnecting with backoff (AppSync closes healthy connections now and then),
  refreshes tokens before they expire, and closes the socket after five
  minutes in a hidden tab.
- **Lifecycle.** Deploy creates or updates the namespace before the route
  flip; removing `realtime` deletes it after the flip; destroy deletes it.
  Rolling back to a deployment without realtime only drops the route's `rt`.

## Email

Transactional mail (sign-up confirmations, notifications, digests) on Amazon
SES: about $0.10 per 1,000 emails, $0 at rest.

```
server, worker  Email.send({ to, subject, text, html?, replyTo? })
  deployed      1. reserved test domains (example.com, *.test, *.invalid…) are logged, never sent
                2. daily limit: conditional ADD on mail#<app>#<stage> / <UTC day> in platform-telemetry
                3. SESv2 SendEmail from "Todo" <todo@mail.platform…>, tenant + configuration set <app>--<stage>
  plat dev/test 1–2 as above, then POST to the CLI's inbox → http://<app>.localhost:3000/__platform/mail
SES             per-tenant suppression list, reputation pause, metrics
control plane   reads them on demand: console Email page, `plat email`; the pinger alerts on a pause
```

- **One mail domain** (`mail.<zone>`, foundation stack): Easy DKIM, a custom
  MAIL FROM (`bounce.mail.<zone>`, SPF) and DMARC (`p=quarantine`), all in
  the delegated zone, so the root zone needs no change. Every app sends from
  it: `todo@…` in prod, `todo--pr-12@…` in previews, with an optional display
  name (`email.name`). Replies need `replyTo`: the domain takes no mail.
- **A tenant per stage.** SES tenants keep a suppression list each (scope
  `TENANT`: hard bounces and complaints), report per-tenant `Send`,
  `Delivery`, `Bounce` and `Complaint` metrics, and carry the standard
  reputation policy, which pauses only that tenant when its bounce or
  complaint findings turn high-severity. One app's bad list can't stop the
  others' mail, and a preview's test sends can't pause prod. The tenant's
  configuration set has the same name.
- **The stage role sends only as itself.** `ses:SendEmail` on the domain and
  the stage's configuration set, with `ses:FromAddress`, `ses:TenantName` and
  `ses:ApiVersion` pinned, so code that bypasses the SDK still sends from its
  own address through its own tenant, and the tenant's pause still applies.
- **Daily limit.** The SDK counts recipients per UTC day with one conditional
  `UpdateItem` on a row in the platform's telemetry table, which the role may
  update only under its own partition key (`dynamodb:LeadingKeys`). Apps
  declare `email.dailyLimit` (default 200) up to the platform's
  `limits.emailsPerDay`, checked when a deployment is created; previews and
  local stages get at most 50. A send past it fails with `EmailNotSent`
  (`daily-limit`), so a queue handler retries and then dead-letters. A failed
  send gives its count back. The limit catches runaway code, not hostile
  code; the tenant's reputation pause is the backstop that code can't
  bypass.
- **Failures** are typed: `EmailNotSent` with `daily-limit`, `paused` (the
  tenant is paused: SES answers `MessageRejected: Sending disabled for
  <tenant>`) or `rejected` (an invalid message, or one SES refuses). Anything
  else is a defect.
- **Reserved test domains** are skipped on deployed stages: they always
  bounce, and bounces from test data count against the app's reputation.
- **Local.** Under `plat dev` and `plat test` the engine creates the same
  tenant in the emulator, but bindings say `mode: 'local'`: the SDK counts the
  send against the emulator's telemetry table, then posts it to the CLI, whose
  inbox page lists messages live and shows their HTML in a sandboxed frame.
  The emulator can't send as a tenant or show what it sent.
- **Control plane.** The Email page and `plat email` show the stage's sender,
  whether SES lets it send (paused by the policy, by hand, or by AWS), today's
  recipients against the limit, the tenant's CloudWatch metrics, and its
  suppression list. An owner can remove an address from the list and resume a
  pause that isn't AWS's (`REINSTATED`, which the policy honors while its
  findings are still open). The 5-minute pinger alerts when a prod stage's
  sending is paused or resumes.
- **The user pool** sends its own mail (sign-up and reset codes) through SES
  from `login@mail.<zone>`, not Cognito's own sender (50 emails a day for the
  whole pool). It has no tenant: it counts against the account.
- **Lifecycle.** Deploy creates the configuration set and tenant and
  associates both with the domain before any code that sends. Removing
  `email` keeps them (the suppression list and any pause live there), as
  removing `db` keeps the table; the role loses its grant. Destroy deletes
  them. Rollback needs nothing.

## Rate limits

Abuse limits for public and no-auth endpoints (signups per network, writes
per client per minute, sends per user per day), counted in the stage's own
table: one conditional write per check, $0 at rest.

```
server, worker  RateLimits.check(name, { max, per, cost?, key? })    key: the client's network by default
                1. what this instance last saw is already over the limit → refused, no call
                2. the previous window's count: one consistent read per key and window, then cached
                3. UpdateItem ADD n :cost IF n <= max − cost − previous × overlap → fits, or the count that refused it
HttpApi         RateLimits.middleware(WriteLimit, policy) → RateLimited: 429 + Retry-After, before the handler
telemetry       a `limit` line per check (name, ok) → l#<app>#<stage>#<res> rollups → console Overview, plat metrics
```

- **A sliding window.** A limit allows `max` uses in any span of `per`
  (1 second to 30 days). The count is the current window's plus the previous
  window's, weighted by the share of it still within `per`, as if its uses
  were spread evenly (Cloudflare's approximation). Fixed windows let 2×
  through around each boundary, which hurts most for small limits such as 5
  signups an hour; this costs the same writes.
- **One item per limit, key and window**: `pk` `_rl#<name>#<key>`, `sk`
  `<per in ms>#<window number>`, `n`, and `_ttl` when the next window ends
  (until then it is the previous window). The app pays for its own checks,
  and needs `db: true`. Collection names start with a letter, so no document
  shares the prefix; the data browser leaves these items out.
- **Exact under concurrency.** The write adds only while the count leaves
  room, so racing checks never let more than `max` through (an emulator test
  races 64 checks against `max: 10`). A use that doesn't fit isn't counted, so
  a client that waits `retryAfter` gets back in instead of staying locked out
  while it retries.
- **Floods add no writes.** Each instance remembers the counts it last saw,
  for up to 10,000 counters. Counts only grow within a window, so when those
  alone are over the limit the check is refused without a call: a client
  hammering one Web Function environment costs one write, not one per
  request. This replaces the in-memory block lists apps wrote themselves.
- **Keys.** The default is `clientInfo`'s network (the IPv4 address or the
  IPv6 /64), from the edge's address header, which clients can't forge.
  `key` counts by anything else, such as a user id. The worker has no request,
  so it must pass one; the types say so. Telemetry carries the limit's name,
  never its key: keys are often client addresses.
- **Errors.** `enforce` and the middleware fail with `RateLimited` (in
  `@ericminassian/platform/api`): a 429 with `Retry-After` in whole seconds and
  `retryAfter` in the body, decoded by the generated web client. The header
  rides on the error class itself, as `HttpApiSchema.encodeToWithHeaders`
  would attach it, so apps declare and fail with one class. A `cost` above
  `max`, a bad name or `per`, and a missing `db` are defects naming the fix.
- **The edge floor** sits under every app's own limits while the whole edge
  is busy: an AWS WAF web ACL (`platform-edge-floor`) on the router
  distribution with one rate-based rule. A client (IP address) sending one
  host more than `limits.edgeRequestsPerMinute` requests a minute (1,000) is
  answered at the edge, static files and public stores' files included,
  before any function runs:
  - a 429 with `Retry-After: 60` and the `RateLimited` body, so a generated web
    client decodes it like an app's own;
  - counted per client and host (lowercased, so spelling it differently
    doesn't buy a second budget): a busy client of one app, or a CI runner
    testing several, isn't blocked from the others;
  - WAF checks the last minute's rate every few seconds and stops blocking
    once it falls back under the limit, usually within 30 seconds.

  ```
  router distribution ── Requests (AWS/CloudFront, 1 min) ──► alarm platform-edge-floor ≥ limits.edgeFloorAt
  alarm → ALARM ── EventBridge rule (default bus) ──► control plane worker, invoke job `edge-floor`
  job, and the 5-minute watchdog: EdgeFloor.reconcile (services/control-plane/src/edge-floor.ts)
     ALARM                      → create the web ACL, set it as the distribution's WebACLId
     OK (or no data) for 60 min → clear WebACLId, delete the web ACL
     the floor's state          → PLATFORM / EDGE_FLOOR in the state table: on, since, why
  ```

  - **On demand.** A web ACL bills by the hour whether or not anything is
    flooding, so it exists only while the floor is on. The alarm watches the
    distribution's requests per minute across every app
    (`limits.edgeFloorAt`, 1,000: equal to the per-client limit, so the floor
    is on whenever one client could be over it; the busiest minute before it
    existed was 748). Below that, a client can send one host up to
    `edgeFloorAt` a minute unblocked; apps' own `RateLimits` still apply.
  - **The foundation** owns only the alarm and the EventBridge rule (its
    target input is the worker's `invoke` payload). The worker exists only
    after the stack, so the platform deploy grants the rule its invoke
    permission afterwards (`foundation/src/deploy.ts`). The control plane
    owns the web ACL: its definition is code there, and its IAM covers that
    web ACL's name, the router distribution's config and the alarm, with or
    without the setting, so a floor on when the setting goes can be taken
    down.
  - **Repair.** The watchdog reconciles every 5 minutes, so a lost alarm event
    costs at most 5 minutes. A foundation deploy writes the whole
    distribution config, and its drift-reverting change sets undo changes
    made outside the stack, so a deploy during a flood drops the web ACL; the
    watchdog puts it back. A web ACL that isn't the floor's is never replaced
    or cleared.
  - **Hold.** The floor stays on until the alarm has been OK for an hour, so a
    flood that pauses doesn't flap it (each change is a distribution deploy).
    WAF refuses to delete a web ACL still attached; a refused delete is
    retried on the next run.

  The Admin page shows whether the floor is on, since when and why, blocked
  and allowed requests over the last day (WAF's CloudWatch metrics, which
  keep the web ACL's name each time it's created), and while it's on a sample
  of recently blocked requests with their host and client (WAF's free
  three-hour sample, which goes with the web ACL), so a flood can be traced
  to an app. Without the settings there is no alarm and no floor.

## Deploy flow

```
app CI ── plat build ──► server.zip, worker.zip, static.zip, manifest.json
       ── plat deploy ─► POST /v1/apps/:app/deployments   (GitHub Actions OIDC token)
                         ◄─ presigned POSTs → upload → POST /v1/deployments/:id/start
control plane ─ `stages` queue job "deploy" ─ engine.deployStage():
   role → log groups → table → dead-letter queue → bus/rules → Cognito client → channel namespace
   → SES tenant → worker Lambdas (async config, reserved concurrency) → rule targets/schedules
   → old queues retired → static files → server build in its compute mode (Web Function revision,
   or function version) → the endpoint or alias the live route doesn't use → its access grants
   → KVS route (last step)
   → old builds cleaned up
CI polls, streams events, waits until its nearest edge serves the deployment,
comments the URL on the PR.
```

- The API accepts a deploy from CI only if the token's `repository` matches
  the registered app's repo and its owner is a member, and only of bundles
  built with `@ericminassian/platform` ≥ `MIN_SDK_VERSION` (`plat deploy`
  sends the app's version).
- `prod` deploys only from `refs/heads/main`; `pr-N` only from that PR. A
  merged PR's `closed` run carries the base branch as its ref, so it may
  destroy previews but never deploy one.
- A failure before the route flip leaves the live version untouched.
- The deployer decides the server's compute mode (see [Compute](#compute))
  and records it on the deployment, with the server build (revision or
  version) a rollback needs.
- Either mode has two places to serve from: a Web Function's two endpoints,
  each pinned to one revision, or a request-mode function's two aliases, each
  on one version with its own function URL. A deploy puts the new build on
  the one the live route doesn't use, and the route names it, so one route
  write switches static files and server together at each edge. Edges still
  on the old route keep getting the old version of both until they pick up
  the new one. A deploy that changes mode switches the same way.
- Rollback writes the earlier deployment's route, in its mode. Its build is
  usually still on an endpoint or alias (always for the previous deployment
  in that mode); if not, the one the live route doesn't use is pointed at it
  first.
- A deploy never deletes the static files the previous route points at:
  edges that haven't picked up the new route still serve them. Rollback
  refuses a deployment whose files, revision or version were cleaned up since.
- The platform deploys too: a compute switch is a deployment (actor
  `platform`) of the live deployment's build in the other mode.
- Stages: `main` → `prod`. Each PR → `pr-<n>`, destroyed when the PR closes.
  A nightly reaper removes previews idle for `previewTtlDays`.
- App repos hold no AWS credentials. They call a reusable workflow in this
  repo (`.github/workflows/app.yml`), so pipeline changes reach every app.
- An app with a `test:e2e` script (Playwright) gets a browser check against
  each preview, and the same suite runs as a smoke check after each prod
  deploy, with the stage's URL in `BASE_URL`. Unit and emulator tests can't
  see what only a browser shows. A failing smoke check marks the commit red
  but doesn't roll back, since the change already passed the suite on its
  preview.

## Local development: the AWS Emulator

`plat dev` wraps the [AWS Emulator](https://docs.aws.amazon.com/emulator/)
(one local HTTPS endpoint for many AWS APIs, in-memory state):

1. Start the emulator on a free port (telemetry off), read its endpoint, CA
   and generated credentials.
2. Run `ensureLocalPlatform` and `engine.deployStage({ stage: 'local',
   webMode: 'external' })`. The same engine that provisions AWS provisions the
   emulator, so every local run exercises it.
3. Run the server like a Web Function would (`AWS_LAMBDA_HTTP_ENDPOINT`, same
   bindings) with hot reload, whatever its compute mode deployed (the SDK's
   wrapper and the app's code are the same in both), plus the frontend dev
   server on a free port it
   gets in `PLATFORM_DEV_WEB_PORT` (`web.dev.port` if that is free), so
   several apps run side by side.
4. A local router applies the same `decide()` at `http://<app>.localhost:3000`.
   Realtime runs on the emulator's Event API: the router answers the config
   and tunnels `/__platform/realtime` WebSockets to the emulator's realtime
   port. Email goes to the CLI's inbox at `/__platform/mail`. Public stores'
   files come from the emulator's storage bucket.
5. The worker runs as a local Node process with hot reload.
   - The engine still creates the real worker Lambdas, their async-invoke
     configs, the dead-letter queue, rules and schedules in the emulator, so
     provisioning is exercised.
   - The emulator's `nodejs24.x` Lambda is a restricted JS sandbox (no
     `node:http`, `https`, `net`, `tls`, `async_hooks` or `fetch`), so a
     worker that calls AWS can't run inside it.
   - `plat dev` therefore runs jobs itself: the SDK hands queue sends,
     retries, delayed sends and `invokeJob` to a dispatcher in the CLI
     (`PLATFORM_LOCAL_WORKER_URL`), which waits out their time, and event
     rules are redirected to a queue it polls. See [Jobs](#jobs).
   - Crons run from a local scheduler.

`plat test` does the same with a throwaway stage and runs vitest, locally and
in CI.

Emulator coverage, tested against v1.0.385 on 2026-11-14 (AppSync Events on
2026-11-15, one-shot schedules and function URLs on 2026-11-16):

| Works                                                                               | Missing, so the wrapper fills in                                                                                 |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| DynamoDB (GSIs, TTL, transactions)                                                  | Web Function endpoints (`CreateWebFunctionEndpoint` = NotImplemented): `plat dev` runs the server                |
| SQS; SQS → Lambda ESM (checks role permissions); async invoke configs, destinations | Lambda `nodejs24.x` is a JS sandbox without networking modules: `plat dev` runs the worker locally               |
| EventBridge → SQS/Lambda (checks resource policies), rule targets' DLQs             | Scheduler never fires: local cron runner, and the CLI's dispatcher waits out jobs' delays                        |
| Lambda control plane (create/update, ESMs, permissions); logs reach CloudWatch Logs | Cognito hosted UI (404): local sign-in page in the SDK, real emulator tokens                                     |
| S3 (presigned URLs, CORS), SSM SecureString, IAM/STS                                | CloudFront edge: local router                                                                                    |
| Cognito tokens (RS256) + JWKS on the emulator endpoint                              | lambda-web timestamps break the JS SDK: engine compat middleware                                                 |
| AppSync Events: Event APIs, namespaces, API keys, IAM publish, handlers, wildcards  | Lambda authorizer never invoked (any token passes): signed-in subscribe tokens go unchecked locally              |
| Scheduler one-shot schedules                                                        | `SendEmail` as a tenant is NotImplemented and sent mail can't be read back: the CLI's inbox                      |
| SESv2: identities, configuration sets, tenants and their associations               | Function URLs answer 502 for a streaming handler: `plat dev` runs the server                                     |
| Lambda versions, aliases, function URLs and their permissions                       | A presigned request with an `Origin` header is refused (`InvalidAccessKeyId`): the router relays browser uploads |
|                                                                                     | In-memory only: re-provisioned on each start (seconds)                                                           |

As the emulator fills gaps (it releases several times a day), the wrapper
drops each stand-in.

## Observability (built in, ~$0 per app)

The SDK owns the process entry points, so every app gets telemetry without
writing any instrumentation:

- **Lines.** JSON lines on stdout (`packages/core/src/telemetry.ts`):
  - `req`: every request, with route pattern, status, latency, country and cold start
  - `err`: errors, with a fingerprint
  - `job`: every queue, event, cron or invoke run
  - `span`: SDK calls (including `realtime.publish` and `email.send`) and
    outgoing `fetch`, for the requests and jobs that keep them
  - `log`, `metric` (from `metrics.count/value`) and `env` (cold start)
  - `limit`: every `RateLimits` check, with the limit's name and whether it fit
  - All carry `trace`. Traces propagate through job payloads (queue
    messages, retries) and event detail.
  - **Spans when they matter.** A request, job or `traced` unit holds its
    spans until it ends, then writes them if it failed (a 5xx, a failed job,
    or an `err` line while it ran), took 1 s or longer, or its trace is one of
    1 in 20 (`TRACE_SAMPLE_RATE`, a hash of the trace id, so every hop of a
    trace agrees). Otherwise its line counts them (`calls`, `callMs`), and the
    trace views show "12 calls, 34ms, not recorded". It holds at most 500 and
    counts the rest. An error writes the held spans at once; spans that end
    after their request follow its choice. Code that no request or job ends
    (the logs processor) writes spans as they end, and `plat dev` prints all.
  - **Compact.** A line leaves out what a reader can tell without it: `path`
    when it is the `route`, a first `attempt`, and a request's own `span` id
    when no span points to it. A typical request (three calls, a 200) writes
    one line of 251 bytes instead of four of 1,060 (pinned in
    `packages/sdk/test/telemetry.test.ts`).
- **Pipeline.** One account-level CloudWatch Logs subscription filter (one per
  account and region; destination is the control plane worker) forwards
  `req|err|job|metric|limit|env` lines to the telemetry processor. `span` and
  `log` lines stay in CloudWatch Logs for log search and traces (Logs
  Insights) to read on demand.
- **Edge traffic.** Apps' own lines only see what reaches their servers, so a
  static site would look idle. The router's access log (CloudFront standard
  logging, `EDGE_LOG_FIELDS`: time, host, method, path, status, content type,
  never the client's address) is delivered to `/platform/edge` as JSON, kept
  a day, and a subscription filter of its own (the account-level one takes a
  single pattern) hands it to the same processor. It counts each stage's
  requests by status class and its page views (`isPageView`: a GET answered
  with HTML, or a 304 for a path that names no file), health checks left out,
  and only for stages the platform serves, so a scan of made-up names writes
  nothing.
  CloudFront delivers it up to an hour late, so its series serve charts and
  the public directory, not alert rules.
- **Rollups.** The processor writes:
  - per-minute, per-hour and per-day rollups to `platform-telemetry`, with
    TTL (minutes 3 days): request counts by status class, a fixed-bucket
    latency histogram (so DynamoDB `ADD` works) and cold starts, stage-wide
    and per route; per-job, custom-metric (count, sum and a max raised by a
    conditional write), rate-limit and edge (`v#`) series. Writes happen only
    when there is traffic;
  - Sentry-style error groups. A new group sends an alert and can open a
    GitHub issue in the app repo.
- **No CloudWatch custom metrics, alarms or dashboards per app.** These are
  the costs that scale with app count. Infrastructure metrics (Web Function
  environments and throttles, queue age) are read from CloudWatch on demand.
- **Reading it back** (`src/telemetry/query.ts`, `src/logs.ts`,
  `src/insights.ts`):
  - _Series_ (the Metrics explorer, alert rules, `plat metrics --metric`): a
    query's statistic per bucket from the rollups. 5 to 30 minute buckets are
    sums of minute rows, and histograms add, so percentiles stay exact. A
    window older than minute rows falls back to hours with a note. Grouped
    queries keep the top 10 groups. Realtime series come from AppSync's
    CloudWatch metrics.
  - _Log search:_ text or a filter pattern runs on FilterLogEvents. Any
    structured filter but streams (level, route, status class, deployment,
    trace) runs on Logs Insights over the stage's log groups, newest first,
    paged by the oldest millisecond returned and the lines already returned
    at it. A line's level follows its kind: a `log` line's own; `err` lines
    and 5xx requests are errors; the Lambda runtime's records are `system`.
    Facets and the volume chart are five Insights queries run together; a
    line's context reads its stream over widening windows.
  - _Members' Logs Insights queries_ run only on the stage's own log groups:
    the language is pinned and a query that names log groups (`SOURCE`,
    `logGroups(`) is refused. The control plane can read every log group, so
    this check is what keeps members to their apps.
  - _Trace lists_ are root `req` and `job` lines (a trace and no parent). A
    trace's spans were kept when its root line names its own span id.
- **Alert rules** (`src/alerts/`): a rule watches one series query on one
  stage (requests, latency, cold starts, jobs, job duration, custom metrics
  or rate limits) and fires when it is above or below a threshold over 1 to
  60 minutes. The worker's `alerts` cron evaluates every enabled rule each
  minute over the window that ends 2 minutes before the current minute, so
  its telemetry is in. States are OK, Alarm and No data (the rule says
  whether missing data is OK, Alarm or keeps the state). A state change is
  written only if the state read is unchanged, so overlapping runs can't
  both notify; it gets a history row (`a#<app>#<stage>`, 90 days), and
  `notify` rules email the alerts topic on entering and leaving Alarm with a
  link to the rule. Unchanged rules are written at most every 10 minutes.
  Up to 25 rules per app. A platform with no rules does one read a minute.
- **Console** (`platform.ericminassian.com`, `services/control-plane/web`):
  React on TanStack Router, Charts and Table, with its controls on ui-sdk
  (headless behaviors: keyboard, focus, ARIA, popups) styled after Vercel's
  Geist: neutral greys, light, dark or the device's setting (saved per
  browser, applied before the first paint).
  - **Layout:** a sidebar on the canvas and the page in a panel beside it;
    the sidebar folds to icons (⌘B) and is a drawer on phones. At the top
    level: Apps and Platform (admins). In an app: Overview and Deployments,
    then Observe (Logs, Traces, Metrics, Errors, Alerts), Run (Jobs, and
    Email and Realtime when a stage declares them), Data (Database,
    Storage) and Configure (Secrets, Cost, Settings). The scope switcher picks
    the app and stage; ⌘K jumps to an app, a page, a time range or a trace
    id, or switches the color scheme.
  - **Agents:** every control is a ui-sdk part with a name, so a browser
    agent can find and use it; anything destructive is marked
    (`data-agent-confirm`) and needs a person. The console registers no
    WebMCP tools: the `plat` CLI is the agent's interface.
  - **Everything is in the URL:** the time window, stage, filters, queries and
    chart choices are typed search params, so any view is a link and the
    window follows you between pages. Dragging across a chart zooms every
    chart on the page; charts on a page share a cursor and mark deployments.
  - **Home:** every app with status, its prod traffic over 24 hours, error
    rate, p95, firing alerts, cost and last deploy, trouble first.
  - **Overview:** the stage's live deployment (where it runs, its source,
    who deployed it, compute mode; its logs and a rollback to the one before),
    five figures against the previous period, page views, requests, latency,
    5xx and job runs, the busiest routes, recent activity, and the custom
    metrics and rate limits the stage recorded.
  - **Metrics:** the explorer. Up to 8 queries (metric, statistic, filters,
    group by) over the rollups, expressions over them (`100 * b / a`), as a
    line, area, bar or heatmap. Each unit gets its own chart,
    never a second axis. The bucket size follows the window (about 150
    points; minute rollups for the last 3 days, hourly after). Expressions
    run in the browser on the series the API returns.
  - **Logs:** search (text or a filter pattern) with facets for level,
    stream, route, status class and deployment, a volume chart by level, and
    a line's details in a panel beside the list with its neighbours in its
    stream; Live tail; Logs Insights over the stage's own log groups,
    charting `stats … by bin()` results.
  - **Traces:** recent traces with filters and a duration scatter; a trace
    as a waterfall with its logs. **Errors:** groups with occurrences by
    deployment and the stack.
  - Any chart's menu can open it in the explorer or start an alert rule from
    it.
  - **Run, Data, Ship, Configure:** jobs (each queue's scheduled retries and
    delayed sends, the stage's dead letters with redrive and discard, cron
    run-now); realtime (publishes, subscribes and errors from AppSync's
    per-namespace metrics; deliveries and connections are only reported for
    the whole API, so they aren't shown per app); email (sending status,
    today's recipients against the limit, SES's per-tenant sends, deliveries,
    bounces and complaints, and the suppression list); collections (an item
    opens with its JSON) and files; deployments, each with its own page (event
    log, manifest) and a rollback; secrets; cost; settings.
  - **Platform:** members, platform cost, and the edge floor's state and
    blocked requests.
  - **Settings** also say whether the public directory lists the app.
  - **Demo:** `pnpm web:demo` in `services/control-plane` serves the API
    from generated data (`src/demo`), for working on the console without AWS.
- **Uptime.** Every 5 minutes the pinger
  (`services/control-plane/src/jobs/pinger.ts`) gives each prod stage a
  result without waking servers that have nothing to do:
  - _From traffic:_ a stage that served requests in the last 10 complete
    minutes (its minute rollups) is up unless it served at least 3 and half or
    more were 5xx. No request is sent.
  - _Health checks_ (`GET /__platform/health`) only for a stage that served
    nothing: every run for one without a server (the router answers at the
    edge); for one with a server when its newest uptime row is a 6-hour-old
    check, or is traffic (it just went quiet, which is also how a server that
    can no longer start looks), and every run while its last result failed.
    Otherwise nothing is recorded and its state stays. The control plane's
    own app is never checked.
  - Two failed results in a row are DOWN and alert, by email through the
    alerts topic; a success after that alerts back up. So a server that can't
    start any more alerts about 20 minutes after its last request: the window
    ages out, then two checks fail.
  - The platform's own health probes (the pinger's, deploys waiting for the
    edge) are left out of the rollups, so they never read as traffic.
  - Rows (`u#<app>#<stage>`, 35 days) say which kind they are; the console's
    Overview shows uptime with how many came from traffic and how many were
    checks. Rows from before have no source and were all checks.
- **Cost.** A daily Cost Explorer pull grouped by the `platform:app` tag. The
  Cost tab and `plat apps show` also show each prod server's monthly estimate
  in both compute modes (see [Compute](#compute)).
- **CLI.** `plat logs|metrics|errors|traces|data --json` gives agents the same views.

## Public directory

`GET /v1/public/apps` answers anyone, without signing in: every app whose
live prod deployment is `listed` (the default; `listed: false` in
`plat.config.ts` keeps it out), so following deploys and rollbacks. Each has
its description (the live manifest's, else the record's), URL, when prod was
first deployed and when what it serves went live (a compute switch keeps its
build's time), the uptime pinger's last result, and page views and edge
requests for each of the 30 UTC days ending today (today's so far).
`countingSince` is the day the router's access log began (its log group's
creation), so a reader can tell days before it from quiet ones. Its
repository is linked when public: the platform records
`repository_visibility` from the GitHub OIDC token of each CI deploy (the
control plane's own deploy, from its Actions event), and forgets it when
`repo` changes. Nothing else is there: no owners, routes, deployments'
contents or cost.

Eric's personal site (eric-minassian/website) fetches it from visitors'
browsers, so it answers any origin (`Access-Control-Allow-Origin: *`; it
carries no credentials) with `Cache-Control: public, max-age=60,
s-maxage=300`: a page is a few minutes behind at most, and the router
answers repeat readers, waking the control plane at most every five minutes
per edge location.

## Identity

- **Members** (people who create and run apps) are GitHub accounts in the
  `members` list of `platform.config.ts`.
  - **Console:** "Sign in with GitHub" through a GitHub App.
  - **CLI:** `plat login` exchanges the local `gh` token for a platform token.
  - **CI:** GitHub OIDC, no secrets.
  - Inviting someone is a PR plus a platform deploy.
- **App end users** use one shared Cognito user pool (Essentials tier: 10k MAU
  free, managed login, passkeys) at `login.platform.ericminassian.com`.
  - Each app stage gets its own public app client.
  - Its managed login pages look like the console, following the device's light
    or dark mode. The header names the platform's domain, the same account on
    every app, and the app's name sits above the form. Every deploy brings the
    client's style up to date.
  - The SDK implements `/__platform/auth/{login,callback,logout,me}`: PKCE,
    HttpOnly cookies on the app's own host, and refresh.
  - The result is one account across all of Eric's apps.
  - An app can graduate to a dedicated pool; Cognito's lazy-migration trigger
    moves users as they sign in.

## Isolation and security

- App repos have no AWS access. Only the control plane provisions.
- Each stage's runtime role:
  - lives under `/platform/apps/` with the platform permission boundary;
  - is scoped to that stage's table, dead-letter queue, bus, storage prefix
    and secrets paths, and its own worker functions (the SDK invokes them,
    and Scheduler invokes crons, retries and delayed sends as the role);
  - creates only `_`-prefixed one-shot schedules in its own group, and passes
    only itself to Scheduler;
  - can't create log groups. The engine creates them, so logs still in
    flight when a stage is destroyed can't bring its groups back;
  - publishes only to its own channel namespace. Browsers never publish;
  - reaches its stores under `<app>/<stage>/` and `_public/<app>/<stage>/`;
  - sends email only from its own address, through its own SES tenant.
- Web Functions use `IamAuth` endpoints, and their resource policy trusts only
  the router distribution (`aws:SourceArn`). Request-mode function URLs take
  requests from anyone (CloudFront's OAC would make clients hash bodies), so
  the SDK refuses any without the stage's origin secret before app code runs.
  The secret is derived from the stage key and lives only in the route store
  and the control plane's records; the API never returns routes.
- The router distribution reads the storage bucket's `_public/` prefix only.
- CI tokens are bound to a repo and a stage (prod only from main).
- The platform's own CI role trusts only `eric-minassian/platform` on `main`.
- This repo is public: no account ids, ARNs or emails are committed. They
  come from GitHub Actions variables and SSM.

## DNS

The root zone `ericminassian.com` stays in Eric's management account
(github.com/eric-minassian/aws).

- The `platform-prod` account is delegated `platform.ericminassian.com` through
  the existing scoped delegation role. That zone holds:
  - the console;
  - `edge.platform.ericminassian.com`, an alias to the distribution;
  - `login.platform.ericminassian.com` for Cognito;
  - `mail.platform.ericminassian.com`: SES's DKIM, MAIL FROM and DMARC records.
- The root zone has one static `*` CNAME to `edge.platform.ericminassian.com`,
  plus the ACM validation record for the `*.ericminassian.com` certificate.
- Explicit records and delegated siblings (orbit, forma, …) beat the wildcard.
  Those names are listed in `reservedAppNames`.
- App creation also checks DNS, so it never shadows an existing name.

## Cost model

| Item                                                | Monthly                                                                                                                      |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Hosted zone (delegated)                             | $0.50                                                                                                                        |
| CloudFront, CloudFront Functions, KVS               | free tier: 1 TB, 10M requests, 2M function and KVS reads; then cents                                                         |
| Idle app (table, bus, schedules, functions at zero) | ~$0                                                                                                                          |
| Queues, events, crons (jobs)                        | $0 at rest; $0.20 per million messages (async invokes), retries and delays $1/M schedules after 14M free; dead letters ~$0   |
| Server, request mode (quiet stages, previews)       | $0 at rest; $0.0000133 per GB-s (INIT included) + $0.20/M requests, from the free 400k GB-s and 1M requests first: cents     |
| Server, instance mode (busy prod)                   | memory used while an environment lives (~290 s past a request): ~$2.40 per 256 MB held 24/7, + vCPU and $0.30/M requests     |
| Logs                                                | $0.50/GB ingested; ~0.3 KB a request (~$0.15 per million): spans only for failed, slow and 1 in 20; short retention          |
| Cognito                                             | free ≤ 10k MAU                                                                                                               |
| Realtime (AppSync Events)                           | $0 at rest; $1/M operations, $0.08/M connection-minutes (1,000 always-on users ≈ $3.50)                                      |
| Email (SES)                                         | $0 at rest; $0.10 per 1,000 emails, plus $0.005 per 1,000 sent as a tenant; 1,000 tenants included, then $0.005 a month each |
| Rate limit checks                                   | one DynamoDB write each (~$0.63 per million on demand); refusals an instance already knows about are free                    |
| Public stores                                       | S3 storage, plus a $0.0004 per 1,000 GET on each edge miss; transfer counts toward CloudFront's; no Lambda                   |
| Edge floor (AWS WAF)                                | $0.10 for the alarm; while on, $6 a month by the hour (~$0.01/h) plus $0.60 per million requests                             |
| Edge access log (page views)                        | ~$0 below CloudFront's 750 bytes of log delivery per request (a line is ~200); kept a day; the processor's invocations cents |
| Alarms / dashboards / custom metrics                | none per app                                                                                                                 |
| Alert rules                                         | a cron a minute (~43k invocations, inside the free tier) and one index read; per rule a rollup read a minute: cents          |

Fixed cost is about $0.60 a month: the delegated zone and the edge floor's
alarm. An idle app adds about nothing: no server held warm, no queue polled,
no health check unless it has been quiet for 6 hours. Before the
scale-to-zero changes (measured November 2026) an idle prod app cost ~$2.30 a
month in a Web Function the uptime pinger kept warm plus ~$0.26 per queue,
and the always-on web ACL $6. `eric-minassian/aws` already puts a budget on
the account.

## Graduation

Nothing in an app mentions AWS: the SDK needs only `PLATFORM_BINDINGS` and IAM
permissions. Moving an app to its own account is therefore re-hosting:

- recreate its resources with ordinary infrastructure code;
- set the bindings;
- copy the data;
- switch DNS.

App code is unchanged. Because it's rare, it's a manual runbook,
[`docs/MOVE-APP.md`](MOVE-APP.md), not tooling.

## Repo layout

```
platform.config.ts       domain, region, members, reserved names, limits
packages/core            contracts (naming, manifest, bindings, telemetry, router, API types)
packages/sdk             runtime SDK + server/worker wrappers (@ericminassian/platform)
packages/engine          AWS SDK drivers + AWS Emulator wrapper
packages/cli             plat CLI (@ericminassian/plat)
services/control-plane   API, console, deployer, telemetry, pinger, cost, reaper
foundation               shared platform resources (CDK stack) + the platform deploy
templates/app            app template + AGENTS.md/CLAUDE.md
.github/workflows        ci, release, deploy-platform, reusable app.yml
docs                     DESIGN.md (this), SETUP.md (one-time runbook)
```

## Risks and open items

- **Web Function economics** (measured in the account, November 2026). An
  environment bills the memory it uses (~0.25 GB here) for its whole life,
  including ~290 s after its last request, gets no free tier, and Lambda
  starts spare, billed environments next to busy ones (CI bursts ran 9–25 at
  once). Quiet stages therefore run request mode, and endpoints are capped
  (`web.maxEnvironments`). See [Compute](#compute).
- **The compute chooser estimates.** Minute rollups hold averages, so
  bursts (many cold starts at once in request mode, more environments in
  instance mode) are underestimated, and a streamed response's billed time
  past its headers isn't in `dur`. Request mode's idle lifetime is
  undocumented; the simulation assumes 5 minutes (an environment survived 3
  idle minutes and was gone after 6). Neither estimate subtracts the free
  tier, which the account's workers share. The 25% margin and three-day
  streak keep a stage from flapping on these errors.
- **Lambda concurrency.** Request-mode servers and workers share the
  account's concurrent executions, still the new-account default of 10:
  one request in flight uses one. Raise "Concurrent executions" in Service
  Quotas before several apps run request mode, since Lambda refuses
  requests past it. The control plane runs instance mode so it isn't
  throttled with them.
- **Function URLs are public.** Anyone who learns a URL (it appears only in
  the route store and control plane records) can invoke it: each such
  request is answered 403 by the SDK in a few milliseconds, billed like any
  request. If one leaks, reserved concurrency caps what it can cost, and
  recreating the alias's URL config retires the address.
- **Request mode, verified 2026-11-16 on throwaway resources** (a
  distribution, KVS, router function and S3 origin built like the router's,
  two functions behind function URLs; deleted afterwards):
  - `updateRequestOrigin` switches from the S3 default origin to a function
    URL without OAC, with `customHeaders` (a plain `{ name: value }` object).
  - A viewer sending a header with the name the function adds as a custom
    origin header gets a 502 (`FunctionValidationError`), so the router
    deletes the viewer's copy first; with that, a forged `x-platform-origin`
    is replaced by the real secret.
  - The function URL with only `lambda:InvokeFunctionUrl` answered 403
    ("requires both the lambda:InvokeFunctionUrl and lambda:InvokeFunction
    permissions"); both grants on the alias, the second conditioned on
    `lambda:InvokedViaFunctionUrl`, work.
  - Straight to the URL: no secret or a wrong one, 403 from the SDK; the
    secret, 200. Through the edge, the app saw its public URL,
    `x-platform-host`, `cloudfront-viewer-address` and no origin header.
  - POST bodies arrived byte for byte (1 MB binary, 180 KB UTF-8 JSON, a
    form). The limit is Lambda's 6 MiB event: 5.9 MB of text and 4.7 MB of
    binary (base64-encoded in the event) passed; 6.3 MB of text and 4.8 MB
    of binary got 413.
  - Responses stream through CloudFront: five chunks a second apart reached
    the client a second apart (first at 0.38 s); 12 MB and 20 MB responses
    arrived whole (20 MB in 1.3 s). A 204 kept its headers, as did a 302
    and a HEAD; two Set-Cookie headers arrived separately; an app-gzipped
    body passed intact. CloudFront dropped `accept` from `Vary: accept,
    cookie` (the URL itself sent both).
  - Cold starts of the template app's server (2.1 MB bundle): INIT 460–650
    ms at 512, 1024 and 1769 MB; the first request after it ~115, ~60 and
    ~40 ms; warm requests 12–148, 5–11 and 5–11 ms; ~140 MB used. The SDK's
    `env` line's `initMs` was within ~30 ms of Lambda's INIT duration.
- **Verified on the first real deploy (2026-11-15).**
  - `updateRequestOrigin` switches from the default S3 origin to a Web
    Function with OAC, and POST bodies arrive unsigned.
  - The `x-platform-host` cache key keeps two hosts' responses apart.
  - KVS route changes reach the edge in roughly 5–15 s. Later checks the
    same day, from a client outside AWS, took 30–55 s per change, so waits
    allow 3 minutes. The deployer waits
    for `/__platform/health` to report the new revision before calling a
    deployment live. Edges elsewhere can still serve the previous version for
    a few seconds after that, so `plat deploy` and `plat rollback` then wait
    until the edge nearest the machine running them serves it too.
  - Measured on the template app: first deploy ~25 s, redeploy ~14 s,
    rollback ~8 s at the edge. A Web Function cold start took ~0.4 s, peaking
    at 182 MB.
- **Two endpoints per stage (verified 2026-11-15 on a throwaway stage: three
  deploys, two rollbacks).** Sampling the API and `index.html` back to back
  during each switch never showed the new server with the old static files.
  Creating the second endpoint took ~3 s; rollback to the previous deployment
  was a 2.5 s route write.
- **KVS writes from a Web Function.**
  - `PutKey` (SigV4A-signed) failed with "Authentication failed" when called
    from the API's Web Function. The same call works from the worker (an Event
    Function).
  - So every engine operation that writes the KVS (deploy, rollback,
    destroy) runs in the control plane's worker. The API calls rollback
    synchronously (`services/control-plane/src/jobs/call.ts`).
  - Worth a closer look, or an AWS support case, if more code ever needs
    SigV4A from a Web Function.
- **Realtime (AppSync Events), verified 2026-11-15 on throwaway resources.**
  - The router's WebSocket switch works through CloudFront; it added no
    measurable latency. A publish from a Lambda in us-east-1 took ~175 ms
    (p50; min 28 ms), and reached a browser in the US West ~260 ms (p50)
    after it was sent.
  - 40 idle connections for 65 minutes got ~2,500 keep-alives (one a minute)
    and AppSync metered none of them (no OutboundMessages, Requests or
    TokensConsumed). CloudFront kept every routed connection open; AppSync
    closed 2 of 20 direct ones after ~31 minutes, so clients reconnect.
  - Fan-out cost grows with subscribers × events: live cursors need
    throttling and batching on the server.
  - 50 channel namespaces per Event API (adjustable), and previews count.
    Raise "Event APIs - Channel namespaces per API" before apps run into it.
  - 2,000 request tokens per second are shared by every Event API in the
    account and region.
- **Email, verified 2026-11-15 on throwaway resources.**
  - One domain identity can be associated with several tenants.
  - A role pinned to a from address, a tenant and a configuration set could
    send only with all three; another tenant, another address or no tenant
    was AccessDenied.
  - A paused tenant answers `MessageRejected: Sending disabled for <tenant>`.
  - Tenant metrics carry both `TenantId` and `TenantName` dimensions.
  - Cognito creates a user pool whose SES identity doesn't exist yet
    (checked 2026-11-25 on a throwaway pool), so a new account's first
    deploy doesn't wait for the mail domain to verify.
  - SES production access (`docs/SETUP.md` step 11) was granted in
    November 2026: 50,000 emails a day at 14 a second.
- **The edge floor counts IPv6 clients per address.** WAF can't group by
  prefix, so a client rotating through its /64 gets a budget per address;
  apps' own limits group by /64 (`clientInfo().network`).
- **The edge floor starts late.** It turns on only after CloudWatch has a
  full minute over `edgeFloorAt` and the alarm evaluates it, so the first
  minutes of a flood reach the apps (how long CloudFront's metric takes to
  arrive wasn't measured), and a flood just under the threshold isn't
  blocked at all.
- **Edge floor on demand, verified 2026-11-16 on a throwaway distribution and
  web ACL.**
  - `UpdateDistribution` with a `WebACLId` needs `wafv2:GetWebACL` on that web
    ACL besides `cloudfront:GetDistributionConfig` and
    `cloudfront:UpdateDistribution` (without it: `InvalidWebACLId`, "Unable to
    verify read permissions on Web ACL"); not `wafv2:AssociateWebACL`.
    Clearing it needs CloudFront's permissions only.
  - A web ACL created 8 s earlier attached fine. Attaching reached the nearest
    edge within 6 s and the distribution was Deployed after 29 s; clearing,
    15 s and 38 s.
  - WAF refused to delete a web ACL still attached
    (`WAFAssociatedItemException`) and deleted it 5 s after it was cleared,
    while the distribution was still deploying.
- **Public stores, verified 2026-11-16 on a throwaway bucket and
  distribution.**
  - A public file is served with its own `Content-Type` and `Cache-Control`
    and cached by it; the headers policy also covers S3's errors, the
    router's 404s and 304s. A 57 KB JSON file came back as 5.6 KB with brotli.
  - A missing file is a 404 with the listing scoped to `_public/`; listing
    anything else is refused.
  - CloudFront resolves `..` and `%2e` before choosing a behavior, and refuses
    (400) a function's URI that climbs above `/`. The function sees the raw
    URI, and S3 doesn't resolve dot segments, so the router's check is what
    keeps them out. No path reached a file outside `_public/`.
  - S3 honors `response-content-type` on the OAC-signed request, hence the
    dropped query string.
  - A Range request that also accepts gzip gets the whole compressed file
    (200), as CloudFront does for compressed responses.
  - `cf.updateRequestOrigin` to an S3 origin failed (502), so public stores
    have their own behavior instead of an origin switch.
  - The cache key ignores behavior and origin: a file and another behavior's
    response for the same URI and headers shared an entry until the router
    gave the file its own `x-platform-host`.
- **Custom domains** (non-`ericminassian.com`) need their own certificate.
  The plan is a second, multi-tenant (SaaS Manager) distribution reusing the
  same function and KVS.
- **Workflows.** Lambda durable functions (`app.workflow()`) are not wired yet.
  The deployer is a plain async job with idempotent steps.

## Decision log

| Decision                                                                              | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Control plane provisions with direct AWS SDK calls; apps ship code + `plat.config.ts` | Eric rejected app-owned CDK stacks: they couple apps to AWS and to CloudFormation. Direct calls deploy in seconds, and the platform owns a small, fixed resource vocabulary.                                                                                                                                                                                                                                                                                                                                                                             |
| App config is TypeScript (`plat.config.ts`), evaluated by the CLI                     | Eric's call. The config is type-checked with editor docs, and the SDK checks resource names and payload types against it, so a misspelled queue or a missing worker handler fails `tsc`. The CLI sends the evaluated JSON, so the control plane never runs app code. Not `platform.config.ts`: that's this repo's own settings, and the CLI looks up through parent directories.                                                                                                                                                                         |
| Apps are written with Effect v4 (the template, the SDK's Effect API)                  | Eric's call (2026-11-15). One `HttpApi` definition gives the server, the typed web client and OpenAPI. Services and layers make every resource swappable, so unit tests run the whole app on an in-memory platform, and failures are typed instead of thrown `Response`s. The SDK is Effect-only, and so is every app (the control plane included).                                                                                                                                                                                                      |
| Foundation is one CDK stack; stages stay on the engine                                | Eric's call (2026-11-15). The shared resources are one fixed set that rarely changes and serves every app, which suits CloudFormation: `cdk diff`, rollback on failure, removal of resources dropped from code, drift-aware deploys. Stages keep the engine: many, short-lived, deployed in seconds. The engine's resources were imported into the stack, not recreated.                                                                                                                                                                                 |
| Lambda Web Functions for HTTP                                                         | A normal HTTP server, multi-concurrency per environment, scale to zero, and OAC with unsigned bodies. GA Oct 12, 2026 in 5 regions including us-east-1. CDK 2.277 has L1s only, which doesn't matter here.                                                                                                                                                                                                                                                                                                                                               |
| One router distribution + KVS                                                         | Zero per-app DNS, certificate or distribution work, and instant rollbacks. CloudFront flat-rate plans stay an upgrade path for a big app (only 3 free plans per account).                                                                                                                                                                                                                                                                                                                                                                                |
| AWS Emulator for local dev (Eric's call)                                              | One code path (AWS adapters everywhere), and the real engine runs locally.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Moving an app out is a runbook, not tooling (Eric's call)                             | It should almost never happen, so a manual, documented process beats code that would rot unused.                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| No MCP; CLI only                                                                      | Eric's call. Agents use `plat … --json`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Members = GitHub usernames in config                                                  | Invite-only with a code-reviewed change, and no emails in a public repo. GitHub is already the identity for repos and CI.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Shared Cognito pool for app users                                                     | SSO across apps, no per-app OAuth setup, 10k MAU free.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `<app>--<stage>` hosts                                                                | Stays one DNS label under the single wildcard certificate.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Realtime on AppSync Events, same-origin through the router                            | Managed WebSocket pub/sub at $0 at rest, with no connection table or fan-out to run. API Gateway WebSocket APIs cost ~5× as much for always-on users and need a connection table and one PostToConnection per subscriber; SSE from Web Functions bills held memory and needs a backplane; IoT Core fits auth and naming poorly. Routing `/__platform/realtime` through the existing router avoids DNS, certificates and CORS.                                                                                                                            |
| Browsers subscribe with platform tokens, never publish                                | The session cookie is HttpOnly and AppSync can't see it; exposing Cognito tokens to page JavaScript would let XSS steal sessions. AppSync can't rate-limit a client, so browser publishing could run up the fan-out bill. Channels under `user/<id>` are private to that user; finer access rules belong in the app's API.                                                                                                                                                                                                                               |
| Email on SES with a tenant per stage                                                  | Tenants give each stage its own suppression list, metrics and reputation pause, so one app can't spoil mail for the rest, with nothing for the platform to process: no bounce notifications, no suppression table. The issue's first plan (SNS notifications into a control-plane suppression list) predates tenant-level suppression lists (June 2026).                                                                                                                                                                                                 |
| The daily email limit is counted by the SDK; the tenant pause is the backstop         | One conditional write per send is exact and immediate, and its failure is typed for the app. A control-plane pause driven by telemetry couldn't be bypassed, but would act minutes late; IAM still pins the role to its own tenant, whose reputation pause applies whatever the code does.                                                                                                                                                                                                                                                               |
| One sender per stage, `<app>@mail.<zone>`, with a display name                        | Custom local parts on one shared domain would be a namespace across every app. Per-app subdomains would avoid that but add length for little gain; the display name carries the app's name.                                                                                                                                                                                                                                                                                                                                                              |
| Rate limits: a sliding window in the stage's table                                    | One conditional write per check in the app's own table is exact under concurrency, needs no new infrastructure and bills the app. A sliding window avoids fixed windows' 2× burst at boundaries, at the same cost. Not Effect's `persistence/RateLimiter`: its store must also keep token buckets and adaptive state, which DynamoDB can't update atomically.                                                                                                                                                                                            |
| An edge floor on AWS WAF, per client and host                                         | Eric's call (2026-11-16), after rate limits shipped without it. Floods of static files never reach a function, so only the edge can stop them. Keyed per host so one app's busy client or a shared CI runner doesn't lose the others.                                                                                                                                                                                                                                                                                                                    |
| Public stores under `_public/` in the storage bucket, served by the router            | No Web Function invocation, memory or response-size cap per edge miss, and no DNS, certificate or CORS (same origin). A per-store grant in the bucket policy would be one document every deploy rewrites with no conditional write; a separate bucket would isolate as well, with one more bucket and runtime-config field.                                                                                                                                                                                                                              |
| Store expiry is a daily control-plane sweep, not S3 lifecycle rules                   | One lifecycle document per bucket, shared by every app, can't be updated safely by concurrent deploys, and the foundation stack owns that bucket's configuration. The sweep touches only the stores that ask for it, for a LIST per 1,000 files a day.                                                                                                                                                                                                                                                                                                   |
| A store with files can't switch between public and private                            | Its files would have to move while the live deployment keeps writing to the old place until every edge switches, so some writes could be lost. A new store name is a one-line change.                                                                                                                                                                                                                                                                                                                                                                    |
| A handler with its own memory or timeout gets its own Lambda                          | Lambda sets both per function, so a handler idling 45 s on a socket paid for the 1 GB a snapshot parse needs. Same bundle, environment and log group: `defineWorker`, bindings, logs and telemetry don't change. One function per handler, not per setting, so changing one handler never moves another; setting either opts in. Stage roles may invoke `*--*--*`: a hashed name keeps only `<app>--<stage>--`.                                                                                                                                          |
| us-east-1                                                                             | Web Functions are available there, CloudFront certificates must live there anyway, and new features land first.                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Jobs are pushed: queue sends are async Lambda invokes, retries one-shot schedules     | Eric's call (2026-11-16, the scale-to-zero review). A Lambda event source mapping polls an idle SQS queue ~890 times an hour (~$0.26 a month per queue, more with previews); an async invoke costs nothing until a message exists, and $0.20 per million against SQS's $1.20 (send, receive, delete). The SDK owns retries so `maxAttempts` means the same for queues, events and crons, and Lambda's retries cover only what the SDK can't see (crashes, timeouts). Lost: batching, messages over 240 KB (Scheduler's input cap) and sub-minute delays. |
| One unpolled dead-letter queue per stage, for every writer                            | Failed events and crons were dropped after Lambda's two retries. An SQS queue nothing polls is free at rest and keeps letters 14 days; the SDK, Lambda's on-failure destination, Scheduler and EventBridge all write to it, and redrive re-invokes from the first attempt on the function the handler runs in now.                                                                                                                                                                                                                                       |
| Deployments built with an SDK older than 0.4.0 are refused                            | Bindings (v2) and job payloads changed with pushed jobs, and an old worker can't read them. Live stages keep running what they run until they deploy again; their old queues drain, and their old dead letters move into the stage's queue.                                                                                                                                                                                                                                                                                                              |
| The control plane's deploys run on a queue with a function of its own                 | The worker also processes every app's telemetry, and was 1 GB only because deploys ran there. Deploys and destroys get 1 GB and 15 minutes on a `stages` queue run once; the worker drops to 512 MB.                                                                                                                                                                                                                                                                                                                                                     |
| Spans are written for failed, slow and 1-in-20 traces; the rest are counted           | Measured 2026-11-16: a span line per call made a typical request ~1 KB of CloudWatch Logs ($0.50/GB), about $0.50 per million requests, more than the Web Function's request fee. Deciding when a request ends keeps every failed or slow trace whole, which deciding at its start can't; choosing by trace id keeps every hop of a sampled one. Lines keep `app`, `stage` and `rev`, so no reader has to infer them.                                                                                                                                    |
| The edge floor is on only while the edge is busy (revisits the always-on floor)       | Revisits Eric's 2026-11-16 always-on call: that web ACL was the largest fixed cost ($6 a month plus $0.60 per million requests). WAF bills by the hour and CloudFront doesn't bill requests WAF blocks, so a web ACL only while the edge is busy keeps the floor for $0.10 at rest; it starts minutes into a flood. The control plane owns it: an alarm can't run a stack deploy.                                                                                                                                                                        |
| Uptime from traffic; health checks only for quiet stages                              | A Web Function bills held memory until ~290 s after its last request, so 5-minute checks kept every prod server warm (~$2.30 per app per month) and cold-started most checks. A stage's own requests already say whether it's up; checks stay where nothing else tells (no server, quiet 6 hours, just gone quiet, failing). Health probes are left out of the rollups.                                                                                                                                                                                  |
| Two compute modes for servers, chosen by cost (revisits the row above)                | Eric's call (2026-11-16), after measuring Web Functions here: they bill the memory an environment uses for its whole life, ~290 s past its last request, with no free tier and billed spare environments, so a visit to an idle app costs ~$0.00027. A regular Lambda bills by the millisecond from the free tier. So previews and quiet prod stages run request mode, and a busy prod stage moves to a Web Function.                                                                                                                                    |
| Request mode behind public function URLs and an origin secret, not OAC                | OAC to a function URL still needs clients to send `x-amz-content-sha256` with a body, which webhooks and forms can't. The router adds a header derived from the stage key, which the SDK checks before app code: no new resource or secret store. API Gateway would add a per-request charge and another origin type.                                                                                                                                                                                                                                    |
| One server bundle for both modes, two aliases like two endpoints                      | A mode switch is a redeploy of the same artifacts, with no rebuild, and app code can't tell the modes apart. Two aliases with a URL each keep the route flip switching files and server together, and rollback a route write.                                                                                                                                                                                                                                                                                                                            |
| A mode switch is a platform deployment, after three days at 25% cheaper               | It goes through the deployer, so it is logged, shows in the history and rolls back like any deploy. The margin and the streak absorb the estimate's error and keep a stage from flapping.                                                                                                                                                                                                                                                                                                                                                                |
| Request mode defaults to 1024 MB                                                      | Measured on the template app: INIT doesn't speed up with memory, requests do. Warm requests took 5–11 ms at 1024 MB against 12–148 at 512, so 1024 also costs less per request; 1769 MB was no faster.                                                                                                                                                                                                                                                                                                                                                   |
| Web Function endpoints capped, runtime logs at WARN                                   | Spare environments are billed, and the cap bounds them (previews 2, prod 10 unless `web.maxEnvironments`). The runtime's own log records repeat the SDK's `env` and `req` lines and cost ingest.                                                                                                                                                                                                                                                                                                                                                         |
| The control plane's server runs in instance mode                                      | It must keep answering when apps' request-mode servers and workers use up the account's shared Lambda concurrency; Web Functions scale on their own quota.                                                                                                                                                                                                                                                                                                                                                                                               |
| `auto` waits for the account to have Lambda concurrency to spare                      | A new account can run 10 Lambda invocations at once, shared by request-mode servers and every worker; past that, function URLs answer errors. Web Functions scale on their own quota, so on such an account `auto` keeps servers there, with a warning that names the fix (raise "Concurrent executions" to at least 100).                                                                                                                                                                                                                               |
| The console: dark only, one sidebar, TanStack Router, Charts and Table                | Eric's call (2026-11-16): CloudWatch's depth with a simpler face. Typed search params put the window, filters and queries of every view in its URL, so a link reproduces what someone saw.                                                                                                                                                                                                                                                                                                                                                               |
| Alert rules are evaluated by the control plane from the rollups                       | CloudWatch alarms would need a custom metric per series ($0.30 a month) and $0.10 per alarm, per app and stage. The rollups already hold every series the explorer charts, so one cron a minute serves every rule for cents, and a rule can watch anything a chart shows.                                                                                                                                                                                                                                                                                |
| A rule's state is written when it changes, else every 10 minutes                      | A write per rule per minute is ~$0.05 a rule a month, even for idle apps; reads cost less, and the history keeps every change.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Members' Logs Insights queries run only on their stage's log groups                   | The control plane can read every log group, so the API picks the groups and refuses queries that name their own (`SOURCE`, `logGroups(`).                                                                                                                                                                                                                                                                                                                                                                                                                |
| Explorer expressions run in the browser                                               | Each query's series is fetched and cached once, and arithmetic over aligned buckets is cheap. Alert rules watch a single query, so the server never needs them.                                                                                                                                                                                                                                                                                                                                                                                          |
| Page views come from the router's access log, through the telemetry processor         | Apps' telemetry sees only server requests, so static sites read as idle. CloudFront's standard logging to CloudWatch Logs carries the real status and content type, costs nothing under its 750 bytes per request, and reuses the processor and rollups; the router function logging each request would bill every line and can't see the response. The log arrives up to an hour late, which daily counts and charts tolerate and alert rules don't.                                                                                                    |
| The public directory lists every prod by default                                      | Eric's call (2026-11-26): his site should show every app he runs here without a step per app. What it shows is what a visitor of the app could see; `listed: false` keeps one out.                                                                                                                                                                                                                                                                                                                                                                       |
| A repo's visibility comes from the CI deploy's OIDC token                             | The token already states it, for free, on every prod deploy. Asking GitHub on each read would add a dependency and a rate limit to a public endpoint.                                                                                                                                                                                                                                                                                                                                                                                                    |
| Long-running services are removed (0.5.0)                                             | Eric's call (2026-11-28). A service's container was billed all month whether it was used or not (its vCPU, memory and public IPv4 address), the only part of an app billed while idle: about $6 of the platform's ~$13 a month. A stream source is listened to by a cron for a while each run instead, with its own `memoryMb` and `timeoutSeconds`, merging what arrives into what it stored.                                                                                                                                                           |
