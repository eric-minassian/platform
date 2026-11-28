# Moving an app to its own AWS account

This is rare (an app outgrows the shared account, or gets handed off), so it's
a manual runbook rather than tooling.

## Why it's mostly re-hosting

App code only talks to `@ericminassian/platform`. At runtime the SDK needs two
things:

- the `PLATFORM_BINDINGS` environment variable (resource names; the format is
  in `packages/core/src/bindings.ts`);
- IAM permissions on those resources.

So a move means four things, and the app's code doesn't change:

1. Recreate the app's resources in the new account with ordinary infrastructure
   code, such as CDK like the other app repos.
2. Set `PLATFORM_BINDINGS` on the two functions.
3. Copy the data.
4. Switch DNS.

`plat build` still produces the deploy artifacts (`server.zip`, `worker.zip`
and `static.zip`).

Work through it in order. The old stage keeps serving until the DNS switch
(step 6), and nothing is deleted before step 7.

## 1. Inventory the app on the platform

```sh
plat apps show <app>
aws resourcegroupstaggingapi get-resources --profile platform-prod \
  --tag-filters Key=platform:app,Values=<app> Key=platform:stage,Values=prod
aws lambda get-function-configuration --profile platform-prod \
  --function-name <app>--prod--worker --query Environment.Variables
```

The worker's environment holds the live `PLATFORM_BINDINGS`; the server
(Web Function or request-mode function) gets the same value. The IAM the app needs is what `stageRolePolicy`
(`packages/engine/src/policy.ts`) grants, which is also live on the role
`/platform/apps/<app>--prod`. The resource names come from `names` in
`packages/core/src/naming.ts`.

## 2. Create the account (github.com/eric-minassian/aws)

1. Add `<app>-prod` (and `<app>-beta` if wanted) to `ACCOUNTS`.
2. **Leave out `subdomain` for now.** Delegating `<app>.ericminassian.com`
   moves its DNS immediately, which is step 6.
3. `pnpm deploy`, then add a `<app>-prod` profile to `~/.aws/config`.

## 3. Build the infrastructure (in the app repo)

Recreate what the engine built. Each manifest field maps to:

| `plat.config.ts` | Resource                                                                 | Settings to carry over                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `web.server`     | Lambda Web Function, `nodejs24.x` (arm64), code `server.zip`             | env `PLATFORM_BINDINGS`, `AWS_LAMBDA_NODEJS_ENTRYPOINT=index.mjs`, `NODE_OPTIONS=--enable-source-maps`; endpoint `IamAuth`, reached through CloudFront OAC (`always-amz-auth`). The same `server.zip` also runs as a plain Lambda (handler `index.handler`, `web.memoryMb`) behind a function URL (auth `NONE`, invoke mode `RESPONSE_STREAM`), for a quiet app: CloudFront then sends `x-platform-origin` with `originSecret(stageKey)` (`packages/core/src/web-compute.ts`) as an origin custom header, without OAC |
| `web.static`     | S3 bucket + CloudFront                                                   | Default behavior → S3. `serverRoutes` (default `/api/*`) and `/__platform/*` → the Web Function, origin request policy `AllViewerExceptHostHeader`. SPA: serve `/index.html` for unknown paths. Hashed assets immutable, `index.html` revalidated (`cacheControlFor` in `packages/engine/src/static.ts`)                                                                                                                                                                                                              |
| worker           | Lambda, `nodejs24.x` (arm64), handler `index.handler`, code `worker.zip` | Same env                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `db`             | DynamoDB on-demand, PITR                                                 | `pk`/`sk` (S); GSIs `gsi1`–`gsi3` on `gsi{n}pk`/`gsi{n}sk` (S, projection ALL); TTL attribute `_ttl`                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `queues`         | SQS + dead-letter queue                                                  | Redrive and visibility timeout from the manifest; event source mapping to the worker with `ReportBatchItemFailures`                                                                                                                                                                                                                                                                                                                                                                                                   |
| `events`         | EventBridge bus + one rule per type                                      | `{"detail-type":[type]}` → worker                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `crons`          | EventBridge Scheduler                                                    | → worker, input `{"__platform":"cron","name":"<key>"}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `storage`        | S3 bucket                                                                | CORS for the app's origin                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `secrets`        | SSM SecureString                                                         | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `auth`           | see step 5                                                               | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

Notes on the routing and the bindings:

- No router function is needed here. A dedicated distribution routes with
  plain behaviors, and the SDK takes its public origin from `bindings.url`.
- Point `PLATFORM_BINDINGS` at the new names:
  - `storage.prefix` is `""` with one bucket.
  - `secrets.path` / `sharedPath` are wherever you put the secrets.
  - `worker` is the worker's function name.
  - `revision` can be the commit SHA.

**CI.** Replace `.github/workflows/platform.yml` with a workflow that:

1. assumes a role in the new account via OIDC;
2. runs `pnpm exec plat build`;
3. deploys `.plat/build/*` with the infrastructure code.

When writing the role's trust policy, check the repo's OIDC subject format
first (`gh api repos/<owner>/<repo>/actions/oidc/customization/sub`). Newer
repos sign with `repo:<owner>@<id>/<repo>@<id>:…`, and that cost a failed
deploy here once.

## 4. Copy the data

Deploy the empty infrastructure first. For a clean final copy, stop writes
briefly (a maintenance flag in the app), or accept a short window.

- **DynamoDB.** Items copy verbatim: the SDK's keys (`pk`, `sk`, `gsi*`, `_c`,
  `_ttl`) don't depend on the account.
  - **Small tables:** scan the old table and `BatchWriteItem` into the new one.
  - **Large tables:** `aws dynamodb export-table-to-point-in-time` (PITR is on
    for prod) to S3, then `aws dynamodb import-table` in the new account. The
    import creates the table, so add TTL and adopt it into your infrastructure
    code afterwards.
- **Files:** copy each store, keeping the store names as prefixes:
  `aws s3 sync s3://platform-<acct>-us-east-1-storage/<app>/prod/ s3://<new-bucket>/`.
- **Secrets:** copy `/platform/apps/<app>/prod/secrets/*` and
  `/platform/apps/<app>/_shared/secrets/*`. The SDK reads the stage value
  first, then the shared one.

## 5. Users

Users live in the platform's shared Cognito pool, and app data is keyed by the
user's `sub`. Pick one:

- **Keep the shared pool (simplest, and enough unless you're handing the app
  off).**
  1. In the platform account, add an app client to `platform-users` by hand,
     with callback `https://<host>/__platform/auth/callback` and logout
     `https://<host>/`. Copy the settings from `<app>--prod`.
  2. Leave the `auth` bindings pointing at the shared pool, with the new client
     id.

  Token verification works from any account, `sub`s don't change, and users
  notice nothing.

- **Dedicated pool.**
  - Cognito can't export passwords or passkeys, and the new pool assigns new
    `sub`s. So either:
    - add a user-migration Lambda trigger on the new pool that signs users in
      against the shared pool on first login; or
    - bulk-create users and have them reset their password.
  - Then rewrite user-keyed data from old to new `sub`. Record the old one as a
    custom attribute so you can map them.
  - Social sign-in providers must be configured on the new pool.

## 6. Switch DNS

### Keeping `<app>.ericminassian.com`

Explicit records in the root zone beat the platform's `*` wildcard.

1. Before the switch, the new account needs:
   - its hosted zone for `<app>.ericminassian.com`;
   - a certificate (validated in that zone, so delegate first or use email
     validation);
   - a CloudFront distribution with that alias, plus the records.
2. Add `subdomain: "<app>.ericminassian.com"` to the account in the `aws` repo
   and `pnpm deploy`.
3. Register the NS record from the new account with
   `CrossAccountZoneDelegationRecord` (README of the `aws` repo). Use a short
   TTL at first so a rollback is quick.
4. Clients follow within the wildcard's TTL (300 s).

CloudFront allows a more specific alias on another account's distribution than
the platform's `*.ericminassian.com`. If it reports a conflict anyway, use
AWS's "move an alternate domain name" process (a TXT record proves ownership).

### Moving to a new domain

No conflict to deal with. The old host stops working when you decommission
(step 7), so keep the platform stage up until users have moved over.

## 7. Decommission on the platform

1. `plat destroy --app <app> --stage pr-<n> --yes` for any previews.
2. `plat destroy --app <app> --stage prod --force --yes`. Prod keeps its table
   and storage objects. Once the copy is verified, remove them yourself:
   - turn off deletion protection on `<app>--prod`, then delete the table;
   - delete the storage prefix.
3. `plat apps delete <app> --yes`.
4. If the app kept `<app>.ericminassian.com`, add the name to
   `reservedAppNames` in `platform.config.ts`, so nobody registers it on the
   platform again.

Telemetry: the SDK keeps writing the same JSON lines. In the new account, read
them with CloudWatch Logs Insights. The platform console and `plat
logs/metrics` only cover apps on the platform.
