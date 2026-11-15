# template-app: agent guide

This app runs on **the platform** (github.com/eric-minassian/platform), a PaaS for small apps. You write
the app; the platform provisions, deploys, routes, signs users in and monitors it. Live at
`https://template-app.ericminassian.com`.

## Golden rules

1. **No infrastructure code and no AWS SDK in this repo.** Declare what you need in `plat.config.ts`; use
   it through `@ericminassian/platform`. No CDK, CloudFormation, Terraform or `@aws-sdk/*` imports.
2. **`plat.config.ts` is the source of truth for names and payload types.** `pnpm typecheck` fails unless
   `src/worker.ts` handles exactly its queues, events and crons, and every `queue()`, `events.publish()`,
   `storage()` and `secrets.get()` uses a declared name with the declared payload type. Declare message
   types there (`queue<EmailJob>()`, `event<TodoCreated>()`) rather than annotating handlers, and keep the
   `Register` block at the end of the file.
3. **Never commit secrets.** Use `plat secrets set NAME` for deployed stages and `.env.local` (git-ignored)
   for `plat dev`. Declare each name under `secrets`.
4. **Run `pnpm typecheck && pnpm test` before you push.** CI runs the same checks, plus `plat test` when
   `*.integration.test.ts` files exist. After deploying, it runs `pnpm test:e2e` against the stage.

## Layout

| Path                         | What                                                                                   |
| ---------------------------- | -------------------------------------------------------------------------------------- |
| `plat.config.ts`             | Everything the app needs (web, auth, db, queues, events, crons, storage, secrets, env) |
| `src/server.ts`              | HTTP API (Hono). `export default app`. Routes under `/api/*`                           |
| `src/worker.ts`              | Background handlers: `defineWorker({ queues, events, crons })`                         |
| `src/types.ts`               | Types shared by server, worker and web                                                 |
| `web/`                       | React SPA (Vite), built into `web/dist`, served from the edge                          |
| `test/*.test.ts`             | Unit tests with a mocked SDK (`pnpm test`)                                             |
| `test/*.integration.test.ts` | Real SDK against the AWS Emulator (`plat test`)                                        |
| `e2e/*.spec.ts`              | Browser tests (Playwright) against a running stage (`pnpm test:e2e`)                   |

Requests for `/api/*` and `/__platform/*` go to the server; files go to `web/dist`. Any other path
serves `index.html`, which is how client-side routing works. Change the server prefixes with
`web.serverRoutes` (default `['/api/']`).

## SDK reference (`@ericminassian/platform`)

```ts
import { app, auth, db, events, log, metrics, queue, secrets, storage } from '@ericminassian/platform';
import { defineWorker, invokeJob } from '@ericminassian/platform/worker';
```

| Export                      | Example                                                                                                     |
| --------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `app`                       | `app.name`, `app.stage` (`prod`, `pr-12`, `local`, `test`), `app.url`, `app.isLocal`                        |
| `db.collection`             | `const todos = db.collection<Todo>('todos', { partition: 'userId', sort: 'id' })`                           |
| `.get/.put/.update/.delete` | `await todos.put(t, { ifNotExists: true })`, `await todos.update({ userId, id }, { done: true })`           |
| `.query`                    | `await todos.query({ userId }, { beginsWith: '2026', limit: 20, reverse: true })` → `{ items, cursor }`     |
| `.queryAll`                 | `await todos.queryAll({ userId })` → every matching item, across all pages                                  |
| `queue(name).send`          | `await queue('emails').send({ to, subject, body }, { delaySeconds: 60 })`                                   |
| `events.publish`            | `await events.publish('todo.created', { userId, id, title })`                                               |
| `storage(name)`             | `await storage('uploads').put(key, bytes, { contentType })`, `.get`, `.getText`, `.list(prefix)`, `.delete` |
|                             | `await storage('uploads').uploadUrl(key, { contentType })`: browser-direct upload URL (HTTP PUT)            |
| `secrets.get`               | `await secrets.get('STRIPE_KEY')` (throws if unset), `secrets.getOptional(...)`                             |
| `auth.getUser`              | `await auth.getUser(c.req.raw)` → `{ id, email, name, groups }` or `null`                                   |
| `auth.requireUser`          | `await auth.requireUser(c.req.raw)`: throws a 401 `Response` when signed out                                |
| `auth.loginUrl/logoutUrl`   | `auth.loginUrl('/dashboard')` → `/__platform/auth/login?redirect=...`                                       |
| `metrics`                   | `metrics.count('signups')`, `metrics.value('cart.total', 42.5, 'usd')`: free, shows up in the console       |
| `log`                       | `log.info('charged', { orderId })`, `log.error('failed', err)`: structured, traced, searchable              |
| `defineWorker`              | `defineWorker({ queues: { emails: async (msg) => {} }, events: {...}, crons: {...} })`; `msg.body` is typed |
| `invokeJob`                 | `await invokeJob('reindex', { id })`: async call to an `invoke` handler on this stage's worker              |

User ids (`user.id`) are stable and shared across all platform apps. Every request, job, database call,
queue send and `fetch` is traced automatically. Don't add your own tracing or metrics plumbing.

## Recipes

- **New collection or index.** Declare it in code; no infra change is needed. `db: true` must be in
  `plat.config.ts`. For a secondary index:
  `db.collection<User>('users', { partition: 'id', indexes: { byEmail: { slot: 1, partition: 'email' } } })`,
  then `users.query({ email }, { index: 'byEmail' })`.
  - Slots 1-3 are fixed GSIs. Never reuse a slot for a different key in the same collection.
  - For expiry, set `ttl: 'expiresAt'` (epoch seconds).
- **Pagination.** Return `page.cursor` to the client and pass it back as `{ cursor }`, with the same
  partition, index and sort condition.
  - `cursor` set means there may be more pages, even when `items` is shorter than `limit`: a page also
    ends at 1 MB. Stop when `cursor` is absent, never on the item count. The next page can be empty.
  - Cursors are opaque and safe to send to browsers. One that was edited or issued for another query
    throws `InvalidCursorError`, which the platform answers with a 400.
  - On the server, `queryAll` follows the pages for you.
- **Queue.**
  1. Add `thumbnails: queue<ThumbnailJob>({ batchSize: 5 })` under `queues` in `plat.config.ts`, with
     `ThumbnailJob` in `src/types.ts`.
  2. Add a `queues.thumbnails` handler in `src/worker.ts`.
  3. Send with `queue('thumbnails').send(...)`.

  Throwing in the handler retries the message; after `maxReceiveCount` (default 5) it goes to the
  dead-letter queue, which you can inspect and redrive from the console.
- **Event subscription.** Add `'order.paid': event<OrderPaid>()` under `events`, then add an
  `events['order.paid']` handler. Publish with `events.publish('order.paid', detail)`.
- **Cron.** Add `digest: '0 8 * * 1-5'` under `crons` (5-field cron, UTC; or
  `{ schedule: '...', timezone: 'America/Los_Angeles' }`, or `'rate(15 minutes)'`), then add a
  `crons.digest` handler.
- **File store.** Add `'avatars'` to `storage`, then use `storage('avatars')`. For browser uploads, return
  `uploadUrl(...)` from an API route and `PUT` the file to it.
- **Secret.**
  1. Add `'STRIPE_KEY'` to `secrets` in `plat.config.ts`.
  2. Set it: `plat secrets set STRIPE_KEY --stage prod`, or `--shared` for all stages.
  3. Locally, put `STRIPE_KEY=...` in `.env.local`.
  4. Read it: `await secrets.get('STRIPE_KEY')`.
- **Protected route.** Call `const user = await auth.requireUser(c.req.raw)` first. To require sign-in
  for everything, set `auth: { required: true }`.
- **Plain config.** Use `env: { FEATURE_X: 'on' }`, read via `process.env.FEATURE_X`. Not for secrets.
- **Custom metric.** Use `metrics.count('name')` or `metrics.value('name', n)`. It appears in the console
  and in `plat metrics`.
- **Browser test.** Add a test to `e2e/`. Use it for what only a browser shows: rendering, styles, focus,
  client-side state.
  - CI runs the suite against the PR's preview and, after each deploy, production, with the stage's URL in
    `BASE_URL`. A failure in production doesn't roll back; fix forward or run `plat rollback`.
  - Tests share those stages' data, so leave nothing behind: only read, or remove what a test writes. Keep
    each test's data apart, for example under a random id, so tests can run in parallel.
  - Deployed stages sign in through the real user pool, so tests there run signed out.
  - When it fails, the run's `playwright-traces` artifact has a trace per failed test:
    `pnpm exec playwright show-trace <trace.zip>`.

## Local loop

```sh
pnpm install
pnpm dev                     # whole app on the AWS Emulator: http://template-app.localhost:3000
pnpm test                    # unit tests (mocked SDK)
pnpm test:integration        # plat test: real SDK against a throwaway emulator
pnpm test:e2e                # browser tests against plat dev (started if needed), or BASE_URL=<url>
plat dev run-cron cleanup    # fire a cron in the running `plat dev`
```

`plat dev` has these properties:

- It provisions real (emulated) DynamoDB, SQS, EventBridge, S3, Cognito and SSM.
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
