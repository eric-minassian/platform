# template-app: agent guide

This app runs on **the platform** (github.com/eric-minassian/platform), a PaaS for small apps. You write
the app; the platform provisions, deploys, routes, signs users in and monitors it. Live at
`https://template-app.ericminassian.com`.

The app is written with [Effect](https://effect.website) v4. Effect's own agent docs ship inside the
package: start with `node_modules/effect/AGENTS.md` and its `ai-docs/` examples, and treat them as the
reference over anything you remember about Effect 2 or 3.

## Golden rules

1. **No infrastructure code and no AWS SDK in this repo.** Declare what you need in `plat.config.ts`; use
   it through `@ericminassian/platform`. No CDK, CloudFormation, Terraform or `@aws-sdk/*` imports.
2. **`plat.config.ts` is the source of truth for names and payload types.** `pnpm typecheck` fails unless
   `src/worker.ts` handles exactly its queues, events and crons, and every queue, event, store, secret and
   realtime channel name used in code is declared with the declared payload type. Declare message types there
   (`queue<EmailJob>()`, `event<TodoCreated>()`) rather than annotating handlers, and keep the `Register`
   block at the end of the file.
3. **All data has a schema.** Request bodies, responses, documents and messages are `Schema`s in
   `src/domain.ts`. Decode anything from outside (queue messages, event details) with them; never cast.
4. **Never commit secrets.** Use `plat secrets set NAME` for deployed stages and `.env.local` (git-ignored)
   for `plat dev`. Declare each name under `secrets`.
5. **Run `pnpm format && pnpm typecheck && pnpm lint && pnpm test` before you push.** CI runs the same
   checks (`pnpm format:check` for formatting), plus `plat test` when `*.integration.test.ts` files exist, and
   after deploying it runs `pnpm test:e2e` against the stage. `typecheck` includes Effect's diagnostics (an
   Effect that is never run, a missing `yield*`) and `lint` is type-aware oxlint (a floating promise, an unsafe
   cast), so fix what they report rather than disabling rules.

## Layout

| Path                         | What                                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------------ |
| `plat.config.ts`             | Everything the app needs (web, auth, db, queues, events, crons, storage, secrets, env, realtime) |
| `src/domain.ts`              | Schemas and tagged errors, shared by server, worker and web                                      |
| `src/api.ts`                 | The HTTP API as an `HttpApi` definition. The web app imports it: no server-only code             |
| `src/todos.ts`               | The `Todos` service: the app's rules, over the platform's services                               |
| `src/http.ts`                | Handlers for `src/api.ts` (`HttpLive`)                                                           |
| `src/server.ts`              | `export default toFetchHandler(HttpLive.pipe(Layer.provide(Platform.layer)))`                    |
| `src/worker.ts`              | Background handlers: `defineWorker({ layer, queues, events, crons })`                            |
| `web/`                       | React SPA (Vite) on a client generated from `src/api.ts`; built into `web/dist`                  |
| `test/*.test.ts`             | Unit tests on the in-memory platform (`pnpm test`)                                               |
| `test/*.integration.test.ts` | The real services against the AWS Emulator (`plat test`)                                         |
| `e2e/*.spec.ts`              | Browser tests (Playwright) against a running stage (`pnpm test:e2e`)                             |

Requests for `/api/*` and `/__platform/*` go to the server; files go to `web/dist`. Any other path
serves `index.html`, which is how client-side routing works. Change the server prefixes with
`web.serverRoutes` (default `['/api/']`). The API's OpenAPI document is at `/api/openapi.json`.

## How the code fits together

- **API first.** Endpoints, payloads, responses and errors are declared once in `src/api.ts`. The server
  implements them with `HttpApiBuilder.group` (`src/http.ts`); the browser calls them through a client
  generated from the same definition (`web/src/client.ts`), so a change that breaks either side fails
  `pnpm typecheck`.
- **Services and layers.** App logic lives in services (`Context.Service`) built by layers from the
  platform's services. `Platform.layer` provides the real ones at the entry points (`src/server.ts`,
  `src/worker.ts`); tests provide `Platform.layerMemory()` instead. Handlers stay thin.
- **Errors.** Expected failures are `Schema.TaggedError`s. Give one an `httpApiStatus` and list it in the
  endpoint's `error` to answer with that status. Anything else (a bug, a failed AWS call, a document that no
  longer decodes) is a defect: the request answers 500 and the platform records it as an error group with
  its stack and trace id. A job that fails retries.
- **Functions.** Write service methods with `Effect.fn('Service.method')` and inline code with `Effect.gen`.
  Use `DateTime` and `Clock` rather than `Date`, so tests control time.

## SDK reference (`@ericminassian/platform`)

```ts
import {
  AppInfo,
  Auth,
  clientInfo,
  CurrentUser,
  Db,
  Events,
  Jobs,
  Metrics,
  Platform,
  Queues,
  Realtime,
  Secrets,
  Storage,
} from '@ericminassian/platform';
import { Authentication, User, loginUrl, logoutUrl } from '@ericminassian/platform/api'; // browser-safe
import { RealtimeClient } from '@ericminassian/platform/client'; // browser only
```

| Export                           | Example                                                                                                   |
| -------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `AppInfo`                        | `const app = yield* AppInfo`: `app.name`, `app.stage` (`prod`, `pr-12`, `local`, `test`), `app.url`       |
| `Db.collection`                  | `db.collection('todos', { schema: Todo, partition: 'userId', sort: 'id' })` with `const db = yield* Db`   |
| `.get/.put/.delete`              | `yield* todos.get({ userId, id })` → `Option<Todo>`; `put` creates or replaces                            |
| `.insert/.update`                | `todos.insert(t)` fails `DocumentExists`; `todos.update(key, { done: true })` fails `DocumentNotFound`    |
| `.query`                         | `yield* todos.query({ userId }, { beginsWith: '2026', limit: 20, reverse: true })` → `{ items, cursor }`  |
| `.queryAll`                      | `yield* todos.queryAll({ userId })` → every matching document, across all pages                           |
| `.putMany/.deleteMany`           | `yield* tiles.putMany(copies)`, `yield* tiles.deleteMany(keys)`: batches of 25, not atomic                |
| `db.transact`                    | `yield* db.transact([tiles.tx.put(t), feed.tx.insert(e)])`: all or none; fails `TransactionCanceled`      |
| `Queues`                         | `yield* queues.send('emails', { to, subject, body }, { delay: '1 minute' })`, `sendBatch`                 |
| `Events`                         | `yield* events.publish('todo.created', { userId, id, title })`                                            |
| `Storage`                        | `const uploads = storage.store('uploads')`: `put`, `get`, `getText` (`Option`), `list(prefix)`, `delete`  |
|                                  | `yield* uploads.uploadUrl(key, { contentType })`: browser-direct upload URL (HTTP PUT); `downloadUrl`     |
| `Secrets`                        | `yield* secrets.get('STRIPE_KEY')` → `Redacted` (a defect naming the fix if unset), `getOptional`         |
| `Realtime`                       | `yield* realtime.publish('boards/b1', event)`, `publishMany`: to browsers subscribed right now            |
| `RealtimeClient` (browser)       | `RealtimeClient.subscribe('boards/b1')` → `Stream` of events; `.status` → `Stream` of connection states   |
| `Authentication`, `CurrentUser`  | `.middleware(Authentication)` on a group, then `yield* CurrentUser` in its handlers; signed out → 401     |
| `Auth`                           | `yield* auth.currentUser` → `Option<User>` for endpoints that work signed in or out                       |
| `loginUrl/logoutUrl`             | `loginUrl('/dashboard')` → `/__platform/auth/login?redirect=...`                                          |
| `clientInfo`                     | `const client = yield* clientInfo`: `client.network` to rate-limit by, `client.ip`, `client.country`      |
| `Jobs`                           | `yield* jobs.invoke('reindex', { id })`: runs the worker's `invoke.reindex` handler asynchronously        |
| `Metrics`                        | `yield* metrics.count('signups')`, `metrics.value('cart.total', 42.5, 'usd')`: free, shown in the console |
| `Effect.log*`                    | `Effect.logInfo('charged').pipe(Effect.annotateLogs({ orderId }))`: structured, traced, searchable        |
| `defineWorker`                   | `defineWorker({ layer: Platform.layer, queues: { emails: (msg) => Effect... }, events, crons, invoke })`  |
| `toFetchHandler`                 | `export default toFetchHandler(layer)` in `src/server.ts`                                                 |
| `Platform.layer` / `layerMemory` | Every service for real, or in memory for tests; `Platform.Memory` shows what was sent and published       |

User ids (`user.id`) are stable and shared across all platform apps. Every request, job, database call,
queue send and `fetch` is traced automatically. Don't add your own tracing or metrics plumbing.

## Recipes

- **Endpoint.**
  1. Add it to a group in `src/api.ts`: `HttpApiEndpoint.get('stats', '/stats', { success: Stats })`, with
     `params`, `query` or `payload` schemas as needed and `error` for its tagged errors.
  2. Implement it in that group's handlers in `src/http.ts` (a missing handler is a type error).
  3. Call it from the web app: `ApiClient.query('todos', 'stats', {})` or `ApiClient.mutation(...)`.
- **New collection or index.** Declare it in code; no infra change is needed. `db: true` must be in
  `plat.config.ts`. For a secondary index:
  `db.collection('users', { schema: User, partition: 'id', indexes: { byEmail: { slot: 1, partition: 'email' } } })`,
  then `users.query({ email }, { index: 'byEmail' })`.
  - Slots 1-3 are fixed GSIs. Never reuse a slot for a different key in the same collection.
  - For expiry, set `ttl: 'expiresAt'` (epoch seconds).
  - Documents are encoded with the schema on write and decoded on read. When you change a schema, keep it
    able to decode what's already stored (optional fields, defaults), or migrate the data first.
- **Reading your own writes.** Reads are eventually consistent: a `get` or `query` right after a write
  can miss it for a moment. Pass `{ consistent: true }` to `get`, `query` or `queryAll` to see every write
  that finished first, at twice the read cost. Indexes are always eventually consistent, so an index
  query can't take it (a type error).
- **Writes that belong together.** When data is stored more than once (a copy per tile, a count beside a
  list) or a change has a feed event, write it with `db.transact([...])`: up to 100 documents, all or none.
  - Build the writes with each collection's `tx`: `put`, `insert`, `update`, `delete`, and `check(key)`
    (`{ exists: false }` for absent), which writes nothing but must hold.
  - A failed condition (`insert` over an existing key, `update` or `check` of a missing document) cancels
    all of it with `TransactionCanceled`; its `failed` lists the positions of the writes that failed. A
    transaction of only `put` and `delete` can't fail that way, and its type says so.
  - A transaction writes each document once. Its `update` doesn't read the document, so a patch that
    changes a field of a secondary index must give every field of that index.
  - Many writes that needn't be atomic (imports, cleanup): `putMany`/`deleteMany`.
- **Pagination.** Return `page.cursor` to the client and pass it back as `{ cursor }`, with the same
  partition, index and sort condition.
  - `cursor` set means there may be more pages, even when `items` is shorter than `limit`: a page also
    ends at 1 MB. Stop when `cursor` is absent, never on the item count. The next page can be empty.
  - Cursors are opaque and safe to send to browsers. A query given one that was edited or issued for
    another query fails with `InvalidCursor`; list it in the endpoint's `error` to answer with a 400.
  - On the server, `queryAll` follows the pages for you.
- **Queue.**
  1. Add `thumbnails: queue<ThumbnailJob>({ batchSize: 5 })` under `queues` in `plat.config.ts`, with the
     `ThumbnailJob` schema and type in `src/domain.ts`.
  2. Add a `queues.thumbnails` handler in `src/worker.ts` that decodes `message.body` with the schema.
  3. Send with `queues.send('thumbnails', job)`.

  A failed handler retries the message; after `maxReceiveCount` (default 5) it goes to the dead-letter
  queue, which you can inspect and redrive from the console.

- **Event subscription.** Add `'order.paid': event<OrderPaid>()` under `events`, then an
  `events['order.paid']` handler. Publish with `events.publish('order.paid', detail)`.
- **Cron.** Add `digest: '0 8 * * 1-5'` under `crons` (5-field cron, UTC; or
  `{ schedule: '...', timezone: 'America/Los_Angeles' }`, or `'rate(15 minutes)'`), then a `crons.digest`
  handler.
- **File store.** Add `'avatars'` to `storage`, then use `storage.store('avatars')`. For browser uploads,
  return `uploadUrl(...)` from an endpoint and `PUT` the file to it.
- **Secret.**
  1. Add `'STRIPE_KEY'` to `secrets` in `plat.config.ts`.
  2. Set it: `plat secrets set STRIPE_KEY --stage prod`, or `--shared` for all stages.
  3. Locally, put `STRIPE_KEY=...` in `.env.local`.
  4. Read it in a layer or handler: `Redacted.value(yield* secrets.get('STRIPE_KEY'))`.
- **Protected endpoints.** Add `.middleware(Authentication)` to the group and read `yield* CurrentUser`.
  To require sign-in for everything, including pages, set `auth: { required: true }`.
- **Rate limits and dedupe.** Key abuse controls (rate limits, one vote per client, signup throttles) by
  `client.network` from `yield* clientInfo`: the IPv4 address, or the IPv6 /64, since one IPv6 client
  rotates through the addresses in its /64. The edge sets the client address and replaces any copy a
  client sends, so trust it, and never read `X-Forwarded-For` or other headers yourself. `client.country`
  is absent under `plat dev`.
  - One per client: `votes.insert({ pollId, network: client.network })` fails `DocumentExists` the second
    time; add `ttl` to let it lapse.
  - Unit test requests need the address: `headers: clientHeaders('203.0.113.7')` from
    `@ericminassian/platform/testing`. Without it, `clientInfo` is a defect (500).
- **Plain config.** Use `env: { FEATURE_X: 'on' }` and read it with `yield* Config.String('FEATURE_X')`.
  Not for secrets.
- **Custom metric.** `yield* metrics.count('name')` or `metrics.value('name', n)`. It appears in the
  console and in `plat metrics`.
- **Live updates (realtime).** For anything browsers should see without polling: shared boards, presence,
  notifications.
  1. Declare the channels and their event types under `realtime` in `plat.config.ts`:
     `realtime: { channels: { 'boards/*': channel<BoardEvent>() } }` (`boards/<id>`; a plain `board` is one
     channel). Names are 1-4 segments of a-z, 0-9 and hyphens: no underscores, dots or capitals.
  2. After the change is saved, publish from an endpoint or a worker handler:
     ``yield* realtime.publish(`boards/${id}`, { type: 'stroke', id: stroke.id })``.
  3. In the browser, run ``RealtimeClient.subscribe(`boards/${id}`)`` (a `Stream`, e.g. in an atom) and re-read
     the data whenever `RealtimeClient.status` becomes `connected`: events aren't stored, so a browser that
     was offline or reconnecting missed them.

  Who may subscribe:
  - `subscribe: 'public'` (the default): anyone, on every channel.
  - `subscribe: 'signed-in'` (needs `auth`): signed-in users of this app. Channels under `user/<user id>`
    (declare `'user/*': channel<Notice>()`) reach only that user: ``realtime.publish(`user/${user.id}`, …)``.
    For anything finer (rooms, teams), publish a hint and let the browser fetch through an endpoint that
    checks access.

  Browsers never publish; send through an endpoint. Each event reaches every subscriber and is billed per
  5 KB delivered, so publish small hints (ids, small diffs) and batch fast streams such as cursors on the
  server (a few per second, `publishMany`). Events over 240 KB are refused.

- **Browser test.** Add a test to `e2e/`. Use it for what only a browser shows: rendering, styles, focus,
  client-side state.
  - CI runs the suite against the PR's preview and, after each deploy, production, with the stage's URL in
    `BASE_URL`. A failure in production doesn't roll back; fix forward or run `plat rollback`.
  - Tests share those stages' data, so leave nothing behind: only read, or remove what a test writes. Keep
    each test's data apart, for example under a random id, so tests can run in parallel.
  - Deployed stages sign in through the real user pool, so tests there run signed out.
  - When it fails, the run's `playwright-traces` artifact has a trace per failed test:
    `pnpm exec playwright show-trace <trace.zip>`.

## Testing

- **Unit tests** (`test/*.test.ts`, `@effect/vitest`) run the whole app on `Platform.layerMemory()`: the
  platform's server wrapper, routing, validation, sign-in and handlers, with no emulator. In memory,
  `Authorization: Bearer <id>` signs a request in as the user with that id (`layerMemory({ users })`).
  `Platform.Memory` returns what was sent, published (events and realtime) and counted. The in-memory `Db` follows DynamoDB's
  key, index, ordering and cursor rules.
- **Integration tests** (`test/*.integration.test.ts`, `plat test`) use `Platform.layer` against the AWS
  Emulator with a provisioned `test` stage.
- `it.effect` runs on a test clock that starts at 0; use `it.live` or `layer(..., { excludeTestServices:
  true })` where real time matters.

## Local loop

```sh
pnpm install
pnpm dev                     # whole app on the AWS Emulator: http://template-app.localhost:3000
pnpm test                    # unit tests (in-memory platform)
pnpm lint                    # oxlint, type-aware; `pnpm lint --fix` applies safe fixes
pnpm format                  # oxfmt (CI runs `pnpm format:check`)
pnpm test:integration        # plat test: the real services against a throwaway emulator
pnpm test:e2e                # browser tests against plat dev (started if needed), or BASE_URL=<url>
plat dev run-cron cleanup    # fire a cron in the running `plat dev`
```

`plat dev` has these properties:

- It provisions real (emulated) DynamoDB, SQS, EventBridge, S3, Cognito, SSM and realtime channels.
  Signed-in realtime tokens aren't checked locally (the emulator skips the authorizer).
- The worker runs as a real Lambda inside the emulator.
- The server restarts when you edit, and so does the worker.
- Sign-in uses a local page where any email works.
- State is in memory and is gone when it stops.
- It needs the `aws-emulator` binary (see the hint it prints).

Browser tests need Chromium once: `pnpm exec playwright install chromium`.

## Deploying

- **Pull request:** deploys a preview to `https://template-app--pr-<n>.ericminassian.com`, then runs the
  browser tests against it as their own check. The URL is commented on the PR, and the preview is
  destroyed when the PR closes.
- **Merge to `main`:** deploys `https://template-app.ericminassian.com`, then runs the browser tests
  against it.
- Deploys take seconds. A failed deploy never goes live. Roll back with `plat rollback`.
- One-time per app: `plat apps create template-app --repo <owner>/<repo>` registers the repo with the
  platform. Without it, CI deploys are rejected.

## Debugging (add `--json` for machine output)

```sh
plat logs --since 30m [--stage pr-12] [--filter "error"] [--follow]
plat errors                         # grouped errors with sample stack + trace id
plat traces <traceId>               # one request across server → queue → worker
plat metrics --since 6h             # requests, 5xx, p95, cold starts, per-route and per-job stats
plat data todos --partition userId=<id>
plat deployments / plat stages / plat rollback
```

The console at https://platform.ericminassian.com shows the same data with graphs.
