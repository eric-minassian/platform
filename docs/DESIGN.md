# Platform design

A personal, AI-first PaaS on a single AWS account. An agent (or a person) can
take an idea to `https://<app>.ericminassian.com` with auth, a database,
queues, events, cron, file storage, live updates to browsers, email,
long-running services, CI/CD, preview environments and built-in observability,
with no setup per app. Idle apps cost about nothing.

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
  balancers, customer-managed KMS keys or Secrets Manager. The one exception
  is opt-in: a long-running service an app declares bills while it runs. Its
  network (a VPC with public subnets, no NAT) is free.
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
                          │                 │  server (OAC, always-amz-auth)         ▼
                          ▼                 ▼                              AppSync Event API (one;
         S3 sites bucket (per deploy)   Lambda Web Function  <app>--<stage>  a namespace per stage)
                                            │  (fetch handler, SDK wrapper)          ▲ publish (IAM)
     ┌──────────────────────────────────────┼─────────────────────────────────────┐  │
     │ per stage:  DynamoDB table · SQS queues+DLQs · EventBridge bus · Scheduler  ├─┘
     │             group · worker Lambda (queues/events/crons) · Cognito client ·  │
     │             channel namespace · SES tenant · IAM role (scoped, boundary) ·  ├──► SES (mail.platform…,
     │             log groups · ECS services (Fargate, opt-in) ──► WebSocket/SSE   │     a tenant per stage)
     └──────────────────────────────────────┬─────────────────────────────────────┘
                                            │ stdout JSON telemetry
                              CloudWatch Logs ──(account-level subscription)──► telemetry processor
                                                                                   │ rollups, error groups
     platform.ericminassian.com  (the control plane, itself a platform app)       ▼
       API /v1 + console · deployer · pinger · cost · reaper ◄────────── telemetry + state tables
```

### Components

| Component                                  | What it is                                                                                                                                                                                                                                                                     |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/core`                            | Contracts shared by everything: naming, app config schema, bindings, telemetry schema, router decision, and the control plane API (`PlatformApi`), all as Effect schemas. Isomorphic.                                                                                          |
| `packages/sdk` (`@ericminassian/platform`) | What app code imports: every resource as an Effect service, `toFetchHandler`/`defineWorker`, and an in-memory platform for tests. Also the Web Function server wrapper and the worker dispatcher, both auto-instrumented.                                                      |
| `packages/engine`                          | Idempotent "ensure" drivers over the AWS SDK. Deploys, rolls back and destroys stages. Also wraps the AWS Emulator.                                                                                                                                                            |
| `packages/cli` (`@ericminassian/plat`)     | `init`, `dev`, `test`, `build`, `deploy`, `apps`, `logs`, `metrics`, `errors`, `traces`, `data`, `secrets`, `rollback`, `destroy`.                                                                                                                                             |
| `services/control-plane`                   | The `platform` app: API, console, deployer, telemetry processor, uptime pinger, cost collector, preview reaper, storage expiry.                                                                                                                                                |
| `foundation/`                              | The platform's shared resources (DNS, certificates, router, buckets, tables, Cognito, the realtime Event API and its authorizer, the SES mail domain, container network, cluster and registry, IAM) as one CDK stack, and the deploy that brings up the control plane on them. |
| `templates/app`                            | What `plat init` copies: an Effect app (HttpApi server, worker, React SPA on a generated client) with auth, a todo collection, a queue, an event, a cron, a file store, and agent docs.                                                                                        |

## The app contract

### `plat.config.ts`

```ts
import { channel, defineApp, event, queue } from '@ericminassian/platform/config';
import type { EmailJob, TodoCreated, TodoChanged } from './src/domain.ts';

const app = defineApp({
  name: 'todo',
  web: {
    server: 'src/server.ts',
    static: 'web/dist',
    build: 'pnpm --dir web build',
    dev: { command: 'pnpm --dir web dev' }, // listens on $PLATFORM_DEV_WEB_PORT
    spa: true,
    serverRoutes: ['/api/'],
  },
  auth: true, // or { required: true }
  db: true, // one document DB per stage; collections are declared in code
  worker: { timeoutSeconds: 120, memoryMb: 1024 }, // every handler's, unless it sets its own
  queues: { emails: queue<EmailJob>({ batchSize: 10 }) },
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
  services: { firehose: { entry: 'src/firehose.ts' } }, // long-running; cpu, memoryMb, spot, previewMinutes
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
  behind a 500 to the platform's telemetry. The SDK's wrapper listens on
  `AWS_LAMBDA_HTTP_ENDPOINT`, the Web Function contract, and adds the
  platform routes and request telemetry around it.
- **Worker**: `export default defineWorker({ layer, queues, events, crons })`.
  One bundle per stage handles all of them; the wrapper dispatches on event
  shape and reports partial SQS batch failures. Handlers get the payload types
  declared in `plat.config.ts` and run on `layer`.
  - The worker's Lambda runs every handler with `worker.memoryMb` and
    `worker.timeoutSeconds`.
  - A queue, event or cron that sets its own `memoryMb` or `timeoutSeconds`
    (`queue<T>({ memoryMb })`, `event<T>({ timeoutSeconds })`, a cron's
    object form) runs in a Lambda of its own: the same bundle, environment
    and log group, with its triggers pointed there. A setting it leaves out
    is the worker's, and its queue's visibility timeout follows its own
    timeout.
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
- **Services**: `export default defineService({ layer, run })`. `run` holds a
  connection open and writes what arrives through the same SDK services. See
  [Long-running services](#long-running-services).
- **Unit tests**: `Platform.layerMemory()` runs every resource in memory. Its
  `Db` stores items exactly as DynamoDB holds them, and one test scenario runs
  against both it and DynamoDB in the emulator.

### Bindings

The engine passes resource names to the runtime in one environment variable,
`PLATFORM_BINDINGS` (JSON, `packages/core/src/bindings.ts`): table, queue URLs,
bus, storage prefix, secrets paths, auth settings, realtime namespace and
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
| Web Function | `todo--prod` (endpoints `live`, `live-b`)                                                                                                                             |
| Worker       | `todo--prod--worker`; a handler's own `…--worker--<queue\|event\|cron>-<name>` (`.` and `:` in event types become `_`; hashed past 64)                                |
| Table        | `todo--prod`                                                                                                                                                          |
| Queue / DLQ  | `todo--prod--emails` / `…--dlq`                                                                                                                                       |
| Bus / rules  | `todo--prod` / `todo--prod--<event>`                                                                                                                                  |
| Schedules    | group `todo--prod` (crons; `<service>--stop` for preview services)                                                                                                    |
| Services     | ECS service and task definition family `todo--prod--<service>`                                                                                                        |
| Images       | `platform-containers:todo--prod--<service>--<deploymentId>`                                                                                                           |
| Channels     | namespace `todo--prod` in `platform-realtime` (hashed past 50)                                                                                                        |
| Email        | `todo@mail.platform.ericminassian.com` (previews `todo--pr-12@…`); SES tenant and configuration set `todo--prod`; usage rows `mail#todo#prod` in `platform-telemetry` |
| Role         | `/platform/apps/todo--prod`                                                                                                                                           |
| Logs         | `/platform/apps/todo/prod/{web,web.local,worker,services/<name>}`                                                                                                     |
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

- `/__platform/*` and server routes (`/api/` by default) go to the stage's Web
  Function. The function calls `cf.updateRequestOrigin()` with OAC (origin type
  `lambda`, signing `always-amz-auth`). That signing mode sends bodies as
  `UNSIGNED-PAYLOAD`, so browsers can POST without hashing, unlike Function URL
  origins.
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

An AWS WAF web ACL runs before the function: the edge floor, which answers a
client sending one host more than `limits.edgeRequestsPerMinute` requests a
minute with a 429. See [Rate limits](#rate-limits).

The cache key includes the rewritten URI (static keys contain the deployment
id) plus `x-platform-host`, so apps never share cache entries. The origin
request policy is `AllViewerExceptHostHeader` (Web Functions 404 on a foreign
Host). Hashed assets are immutable; `index.html` revalidates.

A new app or preview is a single KVS entry: no DNS, certificate or
distribution change. Rollback is pointing the entry back.

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
  headers, `Range` and `If-None-Match`.

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
  from `login@mail.<zone>` once the account has production access. Until
  then Cognito's own sender (50 emails a day for the whole pool) stays: in
  the SES sandbox, Cognito could only mail verified addresses.
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
- **The edge floor** sits under every app's own limits: one AWS WAF web ACL
  (`platform-edge`, foundation stack) on the router distribution with one
  rate-based rule. A client (IP address) sending one host more than
  `limits.edgeRequestsPerMinute` requests a minute (1,000) is answered at the
  edge, static files and public stores' files included, before any function
  runs:
  - a 429 with `Retry-After: 60` and the `RateLimited` body, so a generated web
    client decodes it like an app's own;
  - counted per client and host (lowercased, so spelling it differently
    doesn't buy a second budget): a busy client of one app, or a CI runner
    testing several, isn't blocked from the others;
  - WAF checks the last minute's rate every few seconds and stops blocking
    once it falls back under the limit, usually within 30 seconds.

  The Admin page shows blocked and allowed requests (WAF's CloudWatch
  metrics) and a sample of recently blocked requests with their host and
  client (WAF's free three-hour sample), so a flood can be traced to an app.
  It costs about $6 a month plus $0.60 per million requests; without the
  setting the stack has no web ACL.

## Long-running services

Processes that hold a connection open: WebSocket and server-sent event
sources (ship positions, lightning, firehoses), or polling faster than a cron
can. Lambda stops at 15 minutes and crons fire at most once a minute, so a
reconnecting cron would drop data at every reconnect and still pay for a
full-time function.

```
plat build   services.zip: <service>/index.mjs (+ map), bundled like the worker
deployer     node:24-slim (arm64, pinned digest, copied from ECR Public once)
             + a layer with the bundle ──ECR layer API──► platform-containers:<app>--<stage>--<svc>--<deployment>
             task definition (stage role, bindings, PLATFORM_SERVICE) → ECS service in cluster `platform`
Fargate      one task per stage, public subnet + public IPv4, no inbound; stdout → /platform/apps/…/services/<svc>
```

- **Container compute is generic.** The foundation's network, cluster and
  registry (`platformNames.container*`), the engine's image builder
  (`images.ts`, `drivers/ecr.ts`: OCI images through ECR's API, no Docker)
  and its Fargate driver (`drivers/ecs.ts`) don't know about services; other
  container workloads can use them.
- **Runtime.** `defineService({ layer, run })` builds `layer` once per
  container. `run` should never finish. When it fails or returns, the SDK
  reports it (a `job` line kind `service`, and an error group for a failure)
  and runs it again in the same process after a backoff: 1 s, doubling to
  60 s, reset after a run of 5 minutes. A reconnect costs a second, not a new
  task. A process crash restarts the container in place if it had run 60 s
  (ECS restart policy), otherwise ECS replaces the task. SIGTERM (deploy,
  stop, Spot reclaim) interrupts `run`, so finalizers flush, within 25 s.
- **Units of work.** A service has no request or job to hang a trace on, so
  `traced(name)` gives a unit (a batch written) its own trace and a `job`
  line `service:<service>/<name>`. Inside a request or job it is a span.
- **At most one instance.** Deploys stop the old task before starting the
  new one (minimum healthy 0%, maximum 100%), so sources that allow one
  connection per key keep working; a deploy leaves a gap of about a minute.
  A Spot reclaim or a crash can briefly overlap or gap too, so services
  write idempotently.
- **Deploy.** Images and task definitions are built after the worker; the
  rollouts run while the static files and web revision go up, and the deploy
  waits for them before the route flip: until each new task has run 30 s
  with none failing (ECS itself marks a rollout complete about two minutes
  later), up to 6 minutes. ECS's circuit
  breaker returns a service that can't start to its previous build; the
  engine fails fast after two failed tasks, and the deployment's error
  carries the task's stop reason, exit code and last log lines. Since the
  old task stops first, a failed service deploy leaves a gap of about four
  minutes until the previous build runs again (measured 2026-11-16).
- **Previews.** A preview runs each service for `previewMinutes` (30) after
  each deploy; a one-shot EventBridge Scheduler schedule (universal target
  `ecs:updateService`, assumed as the platform's scheduler role, so app code
  can't scale its own service) then sets the desired count to 0.
  `previewMinutes: 0` creates it stopped. `plat services start` runs it again.
- **Rollback** points each service the target deployment had at that
  deployment's build (images and task definitions of the newest three
  deployments, the previous live one and whatever runs are kept), without
  waiting. Unlike the worker, which stays on the latest code.
- **Opt-in and cost.** Declaring `services` is the opt-in; `limits.servicesPerApp`
  (3) caps a manifest. `plat deploy`, `plat services` and the console's Cost
  tab show an estimate (core `estimateContainerCost`), because Cost Explorer
  lags a day and doesn't attribute a task's public IPv4 address to the app.
- **Spot by default.** Fargate Spot on ARM is about 70% cheaper; AWS reclaims
  it with two minutes' notice and ECS starts a replacement. `spot: false`
  opts out.

## Deploy flow

```
app CI ── plat build ──► server.zip, worker.zip, static.zip, services.zip, manifest.json
       ── plat deploy ─► POST /v1/apps/:app/deployments   (GitHub Actions OIDC token)
                         ◄─ presigned POSTs → upload → POST /v1/deployments/:id/start
control plane ─ worker job "deploy" ─ engine.deployStage():
   role → log groups → table → queues/DLQs → bus/rules → Cognito client → channel namespace
   → SES tenant → worker Lambda → ESMs/rules targets/schedules → service images, task
   definitions, ECS rollouts → static files → Web Function revision → the endpoint the live
   route doesn't use → resource policy → services running → KVS route (last step) → old builds cleaned up
CI polls, streams events, waits until its nearest edge serves the deployment,
comments the URL on the PR.
```

- The API accepts a deploy from CI only if the token's `repository` matches
  the registered app's repo and its owner is a member.
- `prod` deploys only from `refs/heads/main`; `pr-N` only from that PR. A
  merged PR's `closed` run carries the base branch as its ref, so it may
  destroy previews but never deploy one.
- A failure before the route flip leaves the live version untouched.
- Each stage's Web Function has two endpoints, each pinned to one revision.
  A deploy puts the new revision on the endpoint the live route doesn't use,
  and the route names its endpoint, so one route write switches static files
  and server together at each edge. Edges still on the old route keep getting
  the old version of both until they pick up the new one.
- Rollback writes the earlier deployment's route. Its revision is usually
  still pinned to an endpoint (always for the previous deployment); if not,
  the endpoint the live route doesn't use is pointed at it first.
- A deploy never deletes the static files the previous route points at:
  edges that haven't picked up the new route still serve them. Rollback
  refuses a deployment whose files or revision were cleaned up since.
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
   bindings) with hot reload, plus the frontend dev server on a free port it
   gets in `PLATFORM_DEV_WEB_PORT` (`web.dev.port` if that is free), so
   several apps run side by side.
4. A local router applies the same `decide()` at `http://<app>.localhost:3000`.
   Realtime runs on the emulator's Event API: the router answers the config
   and tunnels `/__platform/realtime` WebSockets to the emulator's realtime
   port. Email goes to the CLI's inbox at `/__platform/mail`. Public stores'
   files come from the emulator's storage bucket.
5. The worker and each service run as local Node processes with hot reload.
   The engine deploys with `servicesMode: 'external'`, so no image is built;
   a service process that exits is restarted with a backoff, as ECS would.
   - The engine still creates the real worker Lambda, queues, event source
     mappings and rules in the emulator, so provisioning is exercised.
   - The emulator's `nodejs24.x` Lambda is a restricted JS sandbox (no
     `node:http`, `https`, `net`, `tls`, `async_hooks` or `fetch`), so a
     worker that calls AWS can't run inside it.
   - `plat dev` therefore disables the emulator's mappings, polls the SQS
     queues itself and redirects event rules to a queue it polls.
   - Crons run from a local scheduler. `invokeJob` posts to the local worker
     (`PLATFORM_LOCAL_WORKER_URL`).

`plat test` does the same with a throwaway stage and runs vitest, locally and
in CI.

Emulator coverage, tested against v1.0.385 on 2026-11-14 (AppSync Events on
2026-11-15, ECS, ECR and one-shot schedules on 2026-11-16):

| Works                                                                               | Missing, so the wrapper fills in                                                                    |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| DynamoDB (GSIs, TTL, transactions)                                                  | Web Function endpoints (`CreateWebFunctionEndpoint` = NotImplemented): `plat dev` runs the server   |
| SQS + DLQ; SQS → Lambda ESM (checks role permissions)                               | Lambda `nodejs24.x` is a JS sandbox without networking modules: `plat dev` runs the worker locally  |
| EventBridge → SQS/Lambda (checks resource policies)                                 | Scheduler never fires: local cron runner                                                            |
| Lambda control plane (create/update, ESMs, permissions); logs reach CloudWatch Logs | Cognito hosted UI (404): local sign-in page in the SDK, real emulator tokens                        |
| S3 (presigned URLs, CORS), SSM SecureString, IAM/STS                                | CloudFront edge: local router                                                                       |
| Cognito tokens (RS256) + JWKS on the emulator endpoint                              | lambda-web timestamps break the JS SDK: engine compat middleware                                    |
| AppSync Events: Event APIs, namespaces, API keys, IAM publish, handlers, wildcards  | Lambda authorizer never invoked (any token passes): signed-in subscribe tokens go unchecked locally |
| ECS (Fargate tasks simulated once the VPC has an internet route), ECR layer uploads | Default VPC has no internet gateway: `ensureLocalPlatform` adds one and a default route             |
| Scheduler one-shot schedules with universal targets (`ecs:updateService`)           | ECS timestamps carry 9 decimals, which the JS SDK rejects: engine compat middleware                 |
| SESv2: identities, configuration sets, tenants and their associations               | `SendEmail` as a tenant is NotImplemented and sent mail can't be read back: the CLI's inbox         |
|                                                                                     | In-memory only: re-provisioned on each start (seconds)                                              |

As the emulator fills gaps (it releases several times a day), the wrapper
drops each stand-in.

## Observability (built in, ~$0 per app)

The SDK owns the process entry points, so every app gets telemetry without
writing any instrumentation:

- **Lines.** JSON lines on stdout (`packages/core/src/telemetry.ts`):
  - `req`: every request, with route pattern, status, latency, country and cold start
  - `err`: errors, with a fingerprint
  - `job`: every queue, event, cron or invoke run
  - `span`: SDK calls (including `realtime.publish` and `email.send`) and outgoing `fetch`
  - `log`, `metric` (from `metrics.count/value`) and `env` (cold start)
  - `limit`: every `RateLimits` check, with the limit's name and whether it fit
  - All carry `trace`. Traces propagate through queue message attributes and
    event detail.
- **Pipeline.** One account-level CloudWatch Logs subscription filter (one per
  account and region; destination is the control plane worker) forwards
  `req|err|job|metric|limit|env` lines to the telemetry processor. It writes:
  - per-minute, per-hour and per-day rollups to `platform-telemetry`: request
    counts by status class, a fixed-bucket latency histogram (so DynamoDB
    `ADD` works), per-route, per-job, custom-metric and rate-limit series,
    with TTL;
  - Sentry-style error groups. A new group sends an alert and can open a
    GitHub issue in the app repo.
- **No CloudWatch custom metrics, alarms or dashboards per app.** These are
  the costs that scale with app count. Infrastructure metrics (Web Function
  environments and throttles, queue age) are read from CloudWatch on demand.
- **Console** (`platform.ericminassian.com`):
  - **Home:** every app with status, traffic, error rate, p95, cost and last deploy.
  - **Per app:**
    - Overview graphs and per-route stats; custom metrics (`Metrics.count` by
      total, `Metrics.value` by average) and rate limits (allowed and denied
      checks per limit) for stages that recorded any.
    - Logs search plus live tail (CloudWatch Live Tail over SSE).
    - Trace waterfalls; grouped errors.
    - Jobs: queue depth, DLQ redrive, cron run-now.
    - Services: state from ECS, container starts and failed runs (telemetry),
      CPU and memory (ECS's free per-service metrics), recent ECS events and
      the last stop reason; restart, start and stop.
    - Realtime (stages that declare it): publishes, subscribes and errors,
      from AppSync's per-namespace CloudWatch metrics. Deliveries and
      connections are only reported for the whole API, so they aren't shown
      per app.
    - Email (stages that declare it): sending status, today's recipients
      against the limit, SES's per-tenant sends, deliveries, bounces and
      complaints, and the suppression list.
    - Data browser for collections and files.
    - Deployments with rollback; secrets; settings; cost.
  - **Admin:** members, platform cost, and the edge floor's blocked requests.
- **Uptime.** One pinger checks every prod app every 5 minutes.
- **Cost.** A daily Cost Explorer pull grouped by the `platform:app` tag.
- **CLI.** `plat logs|metrics|errors|traces|data --json` gives agents the same views.

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
  - The SDK implements `/__platform/auth/{login,callback,logout,me}`: PKCE,
    HttpOnly cookies on the app's own host, and refresh.
  - The result is one account across all of Eric's apps.
  - An app can graduate to a dedicated pool; Cognito's lazy-migration trigger
    moves users as they sign in.

## Isolation and security

- App repos have no AWS access. Only the control plane provisions.
  - is also what a service's container runs as. ECS pulls images and ships
    logs as a separate execution role; preview stop schedules run as a
    scheduler role that can only change a stage service's desired count.
- Service tasks accept no inbound traffic (a security group with no ingress).
- Each stage's runtime role:
  - lives under `/platform/apps/` with the platform permission boundary;
  - is scoped to that stage's table, queues, bus, storage prefix and secrets
    paths, and its own worker functions (Scheduler invokes crons as the role);
  - can't create log groups. The engine creates them, so logs still in
    flight when a stage is destroyed can't bring its groups back;
  - publishes only to its own channel namespace. Browsers never publish;
  - reaches its stores under `<app>/<stage>/` and `_public/<app>/<stage>/`;
  - sends email only from its own address, through its own SES tenant.
- Web Functions use `IamAuth` endpoints, and their resource policy trusts only
  the router distribution (`aws:SourceArn`).
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

| Item | Monthly |
| Long-running service (opt-in, 0.25 vCPU, 512 MB) | ~$5.90 on Spot, ~$10.90 on-demand, of which $3.65 is the task's public IPv4 address |

| Container network, cluster, registry                | $0 (no NAT); images cents                                                                                                    |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Hosted zone (delegated)                             | $0.50                                                                                                                        |
| CloudFront, CloudFront Functions, KVS               | free tier: 1 TB, 10M requests, 2M function and KVS reads; then cents                                                         |
| Idle app (table, bus, schedules, functions at zero) | ~$0                                                                                                                          |
| Queue with a Lambda consumer                        | ~$0.25 (Lambda long-polling)                                                                                                 |
| Web Function warm environment                       | memory billed while warm: ~$1 per 100 MB held 24/7, worst case for a steady trickle                                          |
| Logs                                                | $0.50/GB ingested (≈3M requests per GB), short retention                                                                     |
| Cognito                                             | free ≤ 10k MAU                                                                                                               |
| Realtime (AppSync Events)                           | $0 at rest; $1/M operations, $0.08/M connection-minutes (1,000 always-on users ≈ $3.50)                                      |
| Email (SES)                                         | $0 at rest; $0.10 per 1,000 emails, plus $0.005 per 1,000 sent as a tenant; 1,000 tenants included, then $0.005 a month each |
| Rate limit checks                                   | one DynamoDB write each (~$0.63 per million on demand); refusals an instance already knows about are free                    |
| Public stores                                       | S3 storage, plus a $0.0004 per 1,000 GET on each edge miss; transfer counts toward CloudFront's; no Lambda                   |
| Edge floor (AWS WAF)                                | $5 web ACL + $1 rule, plus $0.60 per million requests; none without `limits.edgeRequestsPerMinute`                           |
| Alarms / dashboards / custom metrics                | none per app                                                                                                                 |

Baseline is about $1–3 a month, plus about $6 for the edge floor. `eric-minassian/aws` already puts a budget on
the account.

## Graduation

Nothing in an app mentions AWS: the SDK needs only `PLATFORM_BINDINGS` and IAM
permissions. Moving an app to its own account is therefore re-hosting:

- recreate its resources with ordinary infrastructure code;
- set the bindings;
- copy the data;
- switch DNS.

App code is unchanged. A service's image runs anywhere with the same
environment. Because it's rare, it's a manual runbook,
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

- **Web Function economics.** Idle environment lifetime isn't documented, and
  memory is billed while warm. Watch the cost page. A future `compute:
  'event'` mode (Function URL origin with a shared-secret header) could serve
  near-zero-traffic apps from the Lambda free tier.
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
- **Long-running services.**
  - Fargate quotas of a young account (vCPUs for on-demand and Spot) are
    low; check them in Service Quotas before many apps declare services.
  - Subnets take the region's first three zones. Fargate hasn't always run
    in every zone (`use1-az3`); pin subnets by zone id if one is refused.
  - A public IPv4 address per task is most of a Spot service's cost.
    IPv6-only tasks would avoid it but can't reach IPv4-only sources without
    a NAT gateway.
- **Email, verified 2026-11-15 on throwaway resources.**
  - One domain identity can be associated with several tenants.
  - A role pinned to a from address, a tenant and a configuration set could
    send only with all three; another tenant, another address or no tenant
    was AccessDenied.
  - A paused tenant answers `MessageRejected: Sending disabled for <tenant>`.
  - Tenant metrics carry both `TenantId` and `TenantName` dimensions.
  - In the SES sandbox SES authorizes each recipient as an identity, so an
    unverified recipient is AccessDenied on `identity/<address>`; the SDK
    reports that as `rejected` with the reason.
  - SES production access was requested the same day. Within half an hour
    the API reported the review as `DENIED`, but the support case asked for
    more detail and a verified identity in the region, which the account
    gets with the foundation deploy. Until AWS grants it, apps can only mail
    verified addresses and the user pool keeps Cognito's sender. See
    `docs/SETUP.md` step 11.
- **The edge floor counts IPv6 clients per address.** WAF can't group by
  prefix, so a client rotating through its /64 gets a budget per address;
  apps' own limits group by /64 (`clientInfo().network`).
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
  | Long-running services on ECS Fargate (ARM, Spot by default) | Eric's call (#46). Streams need a process that outlives Lambda's 15 minutes. Fargate is per task and opt-in, with no hosts to patch; a Lambda relay would still reconnect every 15 minutes, and EC2 means a fixed instance to manage. Spot is ~70% cheaper and its reclaim looks like any restart. |
  | Service images built through ECR's API from a pinned Node base | No Docker in CI or the control plane, an image per deployment (immutable, rollback-able, portable at graduation), and nothing fetched at container start, which an S3-fetching init container would need (and artifacts expire after 90 days). |
  | A failing `run` is rerun in the same container | Most failures are a dropped connection: a rerun takes a second, while a new task takes about a minute and pulls the image again. Crashes still get a new container. |
  | At most one service instance; deploys stop then start | Sources that allow one connection per key keep working, and apps never see two writers from a deploy. The cost is a gap of about a minute per deploy. |
  | Rollback moves services to that deployment's build | Rolling back should undo a bad ingest as well as a bad page. Builds of recent deployments are kept for it. |

## Decision log

| Decision                                                                              | Why                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Control plane provisions with direct AWS SDK calls; apps ship code + `plat.config.ts` | Eric rejected app-owned CDK stacks: they couple apps to AWS and to CloudFormation. Direct calls deploy in seconds, and the platform owns a small, fixed resource vocabulary.                                                                                                                                                                                                                                                  |
| App config is TypeScript (`plat.config.ts`), evaluated by the CLI                     | Eric's call. The config is type-checked with editor docs, and the SDK checks resource names and payload types against it, so a misspelled queue or a missing worker handler fails `tsc`. The CLI sends the evaluated JSON, so the control plane never runs app code. Not `platform.config.ts`: that's this repo's own settings, and the CLI looks up through parent directories.                                              |
| Apps are written with Effect v4 (the template, the SDK's Effect API)                  | Eric's call (2026-11-15). One `HttpApi` definition gives the server, the typed web client and OpenAPI. Services and layers make every resource swappable, so unit tests run the whole app on an in-memory platform, and failures are typed instead of thrown `Response`s. The SDK is Effect-only, and so is every app (the control plane included).                                                                           |
| Foundation is one CDK stack; stages stay on the engine                                | Eric's call (2026-11-15). The shared resources are one fixed set that rarely changes and serves every app, which suits CloudFormation: `cdk diff`, rollback on failure, removal of resources dropped from code, drift-aware deploys. Stages keep the engine: many, short-lived, deployed in seconds. The engine's resources were imported into the stack, not recreated.                                                      |
| Lambda Web Functions for HTTP                                                         | A normal HTTP server, multi-concurrency per environment, scale to zero, and OAC with unsigned bodies. GA Oct 12, 2026 in 5 regions including us-east-1. CDK 2.277 has L1s only, which doesn't matter here.                                                                                                                                                                                                                    |
| One router distribution + KVS                                                         | Zero per-app DNS, certificate or distribution work, and instant rollbacks. CloudFront flat-rate plans stay an upgrade path for a big app (only 3 free plans per account).                                                                                                                                                                                                                                                     |
| AWS Emulator for local dev (Eric's call)                                              | One code path (AWS adapters everywhere), and the real engine runs locally.                                                                                                                                                                                                                                                                                                                                                    |
| Moving an app out is a runbook, not tooling (Eric's call)                             | It should almost never happen, so a manual, documented process beats code that would rot unused.                                                                                                                                                                                                                                                                                                                              |
| No MCP; CLI only                                                                      | Eric's call. Agents use `plat … --json`.                                                                                                                                                                                                                                                                                                                                                                                      |
| Members = GitHub usernames in config                                                  | Invite-only with a code-reviewed change, and no emails in a public repo. GitHub is already the identity for repos and CI.                                                                                                                                                                                                                                                                                                     |
| Shared Cognito pool for app users                                                     | SSO across apps, no per-app OAuth setup, 10k MAU free.                                                                                                                                                                                                                                                                                                                                                                        |
| `<app>--<stage>` hosts                                                                | Stays one DNS label under the single wildcard certificate.                                                                                                                                                                                                                                                                                                                                                                    |
| Realtime on AppSync Events, same-origin through the router                            | Managed WebSocket pub/sub at $0 at rest, with no connection table or fan-out to run. API Gateway WebSocket APIs cost ~5× as much for always-on users and need a connection table and one PostToConnection per subscriber; SSE from Web Functions bills held memory and needs a backplane; IoT Core fits auth and naming poorly. Routing `/__platform/realtime` through the existing router avoids DNS, certificates and CORS. |
| Browsers subscribe with platform tokens, never publish                                | The session cookie is HttpOnly and AppSync can't see it; exposing Cognito tokens to page JavaScript would let XSS steal sessions. AppSync can't rate-limit a client, so browser publishing could run up the fan-out bill. Channels under `user/<id>` are private to that user; finer access rules belong in the app's API.                                                                                                    |
| Email on SES with a tenant per stage                                                  | Tenants give each stage its own suppression list, metrics and reputation pause, so one app can't spoil mail for the rest, with nothing for the platform to process: no bounce notifications, no suppression table. The issue's first plan (SNS notifications into a control-plane suppression list) predates tenant-level suppression lists (June 2026).                                                                      |
| The daily email limit is counted by the SDK; the tenant pause is the backstop         | One conditional write per send is exact and immediate, and its failure is typed for the app. A control-plane pause driven by telemetry couldn't be bypassed, but would act minutes late; IAM still pins the role to its own tenant, whose reputation pause applies whatever the code does.                                                                                                                                    |
| One sender per stage, `<app>@mail.<zone>`, with a display name                        | Custom local parts on one shared domain would be a namespace across every app. Per-app subdomains would avoid that but add length for little gain; the display name carries the app's name.                                                                                                                                                                                                                                   |
| The user pool's mail moves to SES only with production access                         | In the sandbox SES delivers only to verified addresses, so switching earlier would stop every sign-up code. `foundation/src/app.ts` checks at synth time, so the first deploy after approval switches it.                                                                                                                                                                                                                     |
| Rate limits: a sliding window in the stage's table                                    | One conditional write per check in the app's own table is exact under concurrency, needs no new infrastructure and bills the app. A sliding window avoids fixed windows' 2× burst at boundaries, at the same cost. Not Effect's `persistence/RateLimiter`: its store must also keep token buckets and adaptive state, which DynamoDB can't update atomically.                                                                 |
| An edge floor on AWS WAF, per client and host                                         | Eric's call (2026-11-16), after rate limits shipped without it. Floods of static files never reach a function, so only the edge can stop them. Keyed per host so one app's busy client or a shared CI runner doesn't lose the others.                                                                                                                                                                                         |
| Public stores under `_public/` in the storage bucket, served by the router            | No Web Function invocation, memory or response-size cap per edge miss, and no DNS, certificate or CORS (same origin). A per-store grant in the bucket policy would be one document every deploy rewrites with no conditional write; a separate bucket would isolate as well, with one more bucket and runtime-config field.                                                                                                   |
| Store expiry is a daily control-plane sweep, not S3 lifecycle rules                   | One lifecycle document per bucket, shared by every app, can't be updated safely by concurrent deploys, and the foundation stack owns that bucket's configuration. The sweep touches only the stores that ask for it, for a LIST per 1,000 files a day.                                                                                                                                                                        |
| A store with files can't switch between public and private                            | Its files would have to move while the live deployment keeps writing to the old place until every edge switches, so some writes could be lost. A new store name is a one-line change.                                                                                                                                                                                                                                         |
| A handler with its own memory or timeout gets its own Lambda                          | Lambda sets both per function, so a handler idling 45 s on a socket paid for the 1 GB a snapshot parse needs. Same bundle, environment and log group: `defineWorker`, bindings, logs and telemetry don't change. One function per handler, not per setting, so changing one handler never moves another; setting either opts in. Stage roles may invoke `*--*--*`: a hashed name keeps only `<app>--<stage>--`.               |
| us-east-1                                                                             | Web Functions are available there, CloudFront certificates must live there anyway, and new features land first.                                                                                                                                                                                                                                                                                                               |
