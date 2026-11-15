# Platform design

A personal, AI-first PaaS on a single AWS account. An agent (or a person) can
take an idea to `https://<app>.ericminassian.com` with auth, a database,
queues, events, cron, file storage, CI/CD, preview environments and built-in
observability, with no setup per app. Idle apps cost about nothing.

Status: scaffold (November 2026). Decisions below were made with Eric; the
"Decision log" at the end records why.

## Goals and constraints

- **Zero setup per app.** Creating an app needs no DNS change, no
  certificate, no AWS credentials, no infrastructure code.
- **Apps never own infrastructure.** An app repo contains code plus a small,
  cloud-neutral `plat.config.ts`. No CloudFormation, CDK or AWS SDK calls in
  apps; the platform's control plane provisions everything with direct AWS API
  calls. Apps stay portable.
- **Cheap at rest.** Everything scales to zero. No VPCs, NAT gateways, load
  balancers, customer-managed KMS keys or Secrets Manager by default.
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
                  └───────┬─────────────────┬────────┘
              static      │                 │  server (OAC, always-amz-auth)
                          ▼                 ▼
         S3 sites bucket (per deploy)   Lambda Web Function  <app>--<stage>
                                            │  (fetch handler, SDK wrapper)
     ┌──────────────────────────────────────┼─────────────────────────────────────┐
     │ per stage:  DynamoDB table · SQS queues+DLQs · EventBridge bus · Scheduler  │
     │             group · worker Lambda (queues/events/crons) · Cognito client ·  │
     │             IAM role (scoped, boundary) · log groups                        │
     └──────────────────────────────────────┬─────────────────────────────────────┘
                                            │ stdout JSON telemetry
                              CloudWatch Logs ──(account-level subscription)──► telemetry processor
                                                                                   │ rollups, error groups
     platform.ericminassian.com  (the control plane, itself a platform app)       ▼
       API /v1 + console · deployer · pinger · cost · reaper ◄────────── telemetry + state tables
```

### Components

| Component                                  | What it is                                                                                                                                                                                                            |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core`                            | Contracts shared by everything: naming, app config schema, bindings, telemetry schema, router decision, API types. Isomorphic.                                                                                        |
| `packages/sdk` (`@ericminassian/platform`) | What app code imports: every resource as an Effect service (`/effect`, with an in-memory platform for tests), or as promises. Also the Web Function server wrapper and the worker dispatcher, both auto-instrumented. |
| `packages/engine`                          | Idempotent "ensure" drivers over the AWS SDK. Deploys, rolls back and destroys stages. Also wraps the AWS Emulator.                                                                                                   |
| `packages/cli` (`@ericminassian/plat`)     | `init`, `dev`, `test`, `build`, `deploy`, `apps`, `logs`, `metrics`, `errors`, `traces`, `data`, `secrets`, `rollback`, `destroy`.                                                                                    |
| `services/control-plane`                   | The `platform` app: API, console, deployer, telemetry processor, uptime pinger, cost collector, preview reaper.                                                                                                       |
| `foundation/`                              | The platform's shared resources (DNS, certificates, router, buckets, tables, Cognito, IAM) as one CDK stack, and the deploy that brings up the control plane on them.                                                 |
| `templates/app`                            | What `plat init` copies: an Effect app (HttpApi server, worker, React SPA on a generated client) with auth, a todo collection, a queue, an event, a cron, a file store, and agent docs.                               |

## The app contract

### `plat.config.ts`

```ts
import { defineApp, event, queue } from '@ericminassian/platform/config';
import type { EmailJob, TodoCreated } from './src/domain.ts';

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
  queues: { emails: queue<EmailJob>({ batchSize: 10 }) },
  events: { 'todo.created': event<TodoCreated>() }, // event types the worker subscribes to
  crons: { cleanup: '0 3 * * *' }, // 5-field UTC cron or rate(...)
  storage: ['uploads'],
  secrets: ['STRIPE_KEY'],
  env: { FEATURE_X: 'on' },
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
  - Queue, event, store and secret names must be declared ones, in both the
    Effect services and the promise API.
  - Bodies and details must match `queue<T>()` / `event<T>()`.
  - `defineWorker` must handle exactly the declared queues, events and crons.

### Code

- **Server**: the default export of `web.server` is any web-standard fetch
  handler (`{ fetch }` or a function). The SDK wraps it and listens on
  `AWS_LAMBDA_HTTP_ENDPOINT`, the Web Function contract. Effect apps export
  `toFetchHandler(layer)`, which serves an `HttpApi` and passes route patterns,
  logs and the error behind a 500 to the platform's telemetry. Hono apps (the
  control plane) get the same through the wrapper's Hono hooks.
- **Worker**: `export default defineWorker({ queues, events, crons })` (the
  Effect variant also takes the `layer` its handlers run on). One Lambda per
  stage handles all of them; the wrapper dispatches on event shape and reports
  partial SQS batch failures. Handlers get the payload types declared in
  `plat.config.ts`.
- **Resources**: only through `@ericminassian/platform`. `Db.collection()`
  (`db.collection()` with promises) maps collections onto the stage's single
  table (partition/sort keys, up to three pinned index slots, TTL), so adding
  a collection needs no deploy-time provisioning. Effect collections encode
  and decode documents with a schema.
- **Unit tests**: `Platform.layerMemory()` runs every resource in memory. Its
  `Db` stores items exactly as DynamoDB holds them, and one test scenario runs
  against both it and DynamoDB in the emulator.

### Bindings

The engine passes resource names to the runtime in one environment variable,
`PLATFORM_BINDINGS` (JSON, `packages/core/src/bindings.ts`): table, queue URLs,
bus, storage prefix, secrets paths, auth settings, worker name, public URL, and
the stage key. The stage key is a random secret the engine creates once per stage
in SSM. The SDK seals `db` query cursors with it, so cursors are opaque and
can't be forged.

## Naming: names are the state

Everything for a stage shares the base `<app>--<stage>` (`--` cannot appear in
app or stage names), so the engine can always rediscover what it owns from
names plus `platform:app` / `platform:stage` tags. There is no state file to
lose. App names are 3–30 chars; stages 2–20 (`prod`, `pr-12`, `local`).

| Resource     | Name                                                               |
| ------------ | ------------------------------------------------------------------ |
| Host         | `todo.ericminassian.com`, previews `todo--pr-12.ericminassian.com` |
| Web Function | `todo--prod` (endpoints `live`, `live-b`)                          |
| Worker       | `todo--prod--worker`                                               |
| Table        | `todo--prod`                                                       |
| Queue / DLQ  | `todo--prod--emails` / `…--dlq`                                    |
| Bus / rules  | `todo--prod` / `todo--prod--<event>`                               |
| Schedules    | group `todo--prod`                                                 |
| Role         | `/platform/apps/todo--prod`                                        |
| Logs         | `/platform/apps/todo/prod/{web,worker}`                            |
| Secrets      | `/platform/apps/todo/{prod,_shared}/secrets/NAME`                  |
| Stage key    | `/platform/apps/todo/prod/stage-key`                               |
| Static files | `s3://platform-<acct>-<region>-sites/todo/prod/<deploymentId>/`    |
| Storage      | `s3://platform-<acct>-<region>-storage/todo/prod/<store>/`         |

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
- A stage without a server has nothing to answer `/__platform/health`, so the
  function answers it from the route record (`revision` is the record's
  deployment id). Every routed stage reports which deployment it serves, for
  the deployer, `plat deploy`/`plat rollback` and the uptime pinger.
- Unknown hosts get a 404.

The cache key includes the rewritten URI (static keys contain the deployment
id) plus `x-platform-host`, so apps never share cache entries. The origin
request policy is `AllViewerExceptHostHeader` (Web Functions 404 on a foreign
Host). Hashed assets are immutable; `index.html` revalidates.

A new app or preview is a single KVS entry: no DNS, certificate or
distribution change. Rollback is pointing the entry back.

## Deploy flow

```
app CI ── plat build ──► server.zip, worker.zip, static.zip, manifest.json
       ── plat deploy ─► POST /v1/apps/:app/deployments   (GitHub Actions OIDC token)
                         ◄─ presigned POSTs → upload → POST /v1/deployments/:id/start
control plane ─ worker job "deploy" ─ engine.deployStage():
   role → log groups → table → queues/DLQs → bus/rules → Cognito client → worker Lambda
   → ESMs/rules targets/schedules → static files → Web Function revision → the endpoint
   the live route doesn't use → resource policy → KVS route (last step)
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
5. The worker runs as a local Node process with hot reload.
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

Emulator coverage, tested against v1.0.385 on 2026-11-14:

| Works                                                                               | Missing, so the wrapper fills in                                                                   |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| DynamoDB (GSIs, TTL, transactions)                                                  | Web Function endpoints (`CreateWebFunctionEndpoint` = NotImplemented): `plat dev` runs the server  |
| SQS + DLQ; SQS → Lambda ESM (checks role permissions)                               | Lambda `nodejs24.x` is a JS sandbox without networking modules: `plat dev` runs the worker locally |
| EventBridge → SQS/Lambda (checks resource policies)                                 | Scheduler never fires: local cron runner                                                           |
| Lambda control plane (create/update, ESMs, permissions); logs reach CloudWatch Logs | Cognito hosted UI (404): local sign-in page in the SDK, real emulator tokens                       |
| S3 (presigned URLs, CORS), SSM SecureString, IAM/STS                                | CloudFront edge: local router                                                                      |
| Cognito tokens (RS256) + JWKS on the emulator endpoint                              | lambda-web timestamps break the JS SDK: engine compat middleware                                   |
|                                                                                     | In-memory only: re-provisioned on each start (seconds)                                             |

As the emulator fills gaps (it releases several times a day), the wrapper
drops each stand-in.

## Observability (built in, ~$0 per app)

The SDK owns the process entry points, so every app gets telemetry without
writing any instrumentation:

- **Lines.** JSON lines on stdout (`packages/core/src/telemetry.ts`):
  - `req`: every request, with route pattern, status, latency, country and cold start
  - `err`: errors, with a fingerprint
  - `job`: every queue, event, cron or invoke run
  - `span`: SDK calls and outgoing `fetch`
  - `log`, `metric` (from `metrics.count/value`) and `env` (cold start)
  - All carry `trace`. Traces propagate through queue message attributes and
    event detail.
- **Pipeline.** One account-level CloudWatch Logs subscription filter (one per
  account and region; destination is the control plane worker) forwards
  `req|err|job|metric|env` lines to the telemetry processor. It writes:
  - per-minute, per-hour and per-day rollups to `platform-telemetry`: request
    counts by status class, a fixed-bucket latency histogram (so DynamoDB
    `ADD` works), per-route, per-job and custom-metric series, with TTL;
  - Sentry-style error groups. A new group sends an alert and can open a
    GitHub issue in the app repo.
- **No CloudWatch custom metrics, alarms or dashboards per app.** These are
  the costs that scale with app count. Infrastructure metrics (Web Function
  environments and throttles, queue age) are read from CloudWatch on demand.
- **Console** (`platform.ericminassian.com`):
  - **Home:** every app with status, traffic, error rate, p95, cost and last deploy.
  - **Per app:**
    - Overview graphs and per-route stats.
    - Logs search plus live tail (CloudWatch Live Tail over SSE).
    - Trace waterfalls; grouped errors.
    - Jobs: queue depth, DLQ redrive, cron run-now.
    - Data browser for collections and files.
    - Deployments with rollback; secrets; settings; cost.
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
- Each stage's runtime role:
  - lives under `/platform/apps/` with the platform permission boundary;
  - is scoped to that stage's table, queues, bus, storage prefix and secrets
    paths, and its own worker.
- Web Functions use `IamAuth` endpoints, and their resource policy trusts only
  the router distribution (`aws:SourceArn`).
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
  - `login.platform.ericminassian.com` for Cognito.
- The root zone has one static `*` CNAME to `edge.platform.ericminassian.com`,
  plus the ACM validation record for the `*.ericminassian.com` certificate.
- Explicit records and delegated siblings (orbit, forma, …) beat the wildcard.
  Those names are listed in `reservedAppNames`.
- App creation also checks DNS, so it never shadows an existing name.

## Cost model

| Item                                                | Monthly                                                                             |
| --------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Hosted zone (delegated)                             | $0.50                                                                               |
| CloudFront, CloudFront Functions, KVS               | free tier: 1 TB, 10M requests, 2M function and KVS reads; then cents                |
| Idle app (table, bus, schedules, functions at zero) | ~$0                                                                                 |
| Queue with a Lambda consumer                        | ~$0.25 (Lambda long-polling)                                                        |
| Web Function warm environment                       | memory billed while warm: ~$1 per 100 MB held 24/7, worst case for a steady trickle |
| Logs                                                | $0.50/GB ingested (≈3M requests per GB), short retention                            |
| Cognito                                             | free ≤ 10k MAU                                                                      |
| Alarms / dashboards / custom metrics                | none per app                                                                        |

Baseline is about $1–3 a month. `eric-minassian/aws` already puts a budget on
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
- **Custom domains** (non-`ericminassian.com`) need their own certificate.
  The plan is a second, multi-tenant (SaaS Manager) distribution reusing the
  same function and KVS.
- **Workflows.** Lambda durable functions (`app.workflow()`) are not wired yet.
  The deployer is a plain async job with idempotent steps.

## Decision log

| Decision                                                                              | Why                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Control plane provisions with direct AWS SDK calls; apps ship code + `plat.config.ts` | Eric rejected app-owned CDK stacks: they couple apps to AWS and to CloudFormation. Direct calls deploy in seconds, and the platform owns a small, fixed resource vocabulary.                                                                                                                                                                                                     |
| App config is TypeScript (`plat.config.ts`), evaluated by the CLI                     | Eric's call. The config is type-checked with editor docs, and the SDK checks resource names and payload types against it, so a misspelled queue or a missing worker handler fails `tsc`. The CLI sends the evaluated JSON, so the control plane never runs app code. Not `platform.config.ts`: that's this repo's own settings, and the CLI looks up through parent directories. |
| Apps are written with Effect v4 (the template, the SDK's Effect API)                  | Eric's call (2026-11-15). One `HttpApi` definition gives the server, the typed web client and OpenAPI. Services and layers make every resource swappable, so unit tests run the whole app on an in-memory platform, and failures are typed instead of thrown `Response`s. The promise API stays for the Hono control plane.                                                      |
| Foundation is one CDK stack; stages stay on the engine                                | Eric's call (2026-11-15). The shared resources are one fixed set that rarely changes and serves every app, which suits CloudFormation: `cdk diff`, rollback on failure, removal of resources dropped from code, drift-aware deploys. Stages keep the engine: many, short-lived, deployed in seconds. The engine's resources were imported into the stack, not recreated.         |
| Lambda Web Functions for HTTP                                                         | A normal HTTP server, multi-concurrency per environment, scale to zero, and OAC with unsigned bodies. GA Oct 12, 2026 in 5 regions including us-east-1. CDK 2.277 has L1s only, which doesn't matter here.                                                                                                                                                                       |
| One router distribution + KVS                                                         | Zero per-app DNS, certificate or distribution work, and instant rollbacks. CloudFront flat-rate plans stay an upgrade path for a big app (only 3 free plans per account).                                                                                                                                                                                                        |
| AWS Emulator for local dev (Eric's call)                                              | One code path (AWS adapters everywhere), and the real engine runs locally.                                                                                                                                                                                                                                                                                                       |
| Moving an app out is a runbook, not tooling (Eric's call)                             | It should almost never happen, so a manual, documented process beats code that would rot unused.                                                                                                                                                                                                                                                                                 |
| No MCP; CLI only                                                                      | Eric's call. Agents use `plat … --json`.                                                                                                                                                                                                                                                                                                                                         |
| Members = GitHub usernames in config                                                  | Invite-only with a code-reviewed change, and no emails in a public repo. GitHub is already the identity for repos and CI.                                                                                                                                                                                                                                                        |
| Shared Cognito pool for app users                                                     | SSO across apps, no per-app OAuth setup, 10k MAU free.                                                                                                                                                                                                                                                                                                                           |
| `<app>--<stage>` hosts                                                                | Stays one DNS label under the single wildcard certificate.                                                                                                                                                                                                                                                                                                                       |
| us-east-1                                                                             | Web Functions are available there, CloudFront certificates must live there anyway, and new features land first.                                                                                                                                                                                                                                                                  |
