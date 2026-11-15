# Working on the platform repo

Read `docs/DESIGN.md` first. These are the invariants that aren't obvious from
a single file.

## Boundaries

- **Apps never own infrastructure.** Anything an app needs is a
  `plat.config.ts` field (`AppConfig` and `ManifestSchema` in
  `packages/core/src/manifest.ts`) plus an SDK export, implemented by an engine
  driver. Don't add escape hatches that make apps call AWS directly. `db.raw()`
  is the one intentional exception.
- **App config is evaluated only by the CLI.** `plat` imports `plat.config.ts`
  and sends the JSON result; the control plane never runs app code and must
  keep accepting manifests stored by earlier deployments. A new field touches
  `AppConfig`, `ManifestSchema` (a type test keeps them in step) and, if it
  names a resource, the SDK's `Register` types in `packages/sdk/src/register.ts`.
- **`packages/core` is the contract.** Naming, bindings, telemetry lines,
  route records, the cron dialect and API DTOs all live there. They're used by
  the SDK (inside every deployed app), the engine, the CLI and the control
  plane. A change there is a cross-package change: update every user in the
  same PR. Core must stay isomorphic: the console imports its types, and
  node-only code goes in `cloudfront-function.ts`.
- **No CloudFormation/CDK/Terraform** for apps or the foundation. The engine
  calls the AWS SDK directly with idempotent "ensure" drivers.

## Names are the state

Resources for a stage are named `<app>--<stage>…` (`names` in core) and tagged
`platform:app` / `platform:stage`. The engine finds what it owns from names and
tags, never from a state file. Never rename a pattern without a migration:
existing stages would be orphaned.

## Telemetry

- The SDK writes core `TelemetryEvent` JSON lines to stdout.
- The account-level log subscription forwards `req|err|job|metric|env` lines
  to the control plane's telemetry processor.
- Don't add CloudWatch custom metrics, alarms or dashboards per app. They cost
  money per app; that's the whole point of the rollup tables.

## Public repo

No AWS account ids, ARNs, emails or secrets in commits. They come from GitHub
Actions variables (`AWS_ACCOUNT_ID`, `DNS_DELEGATION_ROLE_ARN`), Actions
secrets (`ALERT_EMAIL`; variables are printed in public workflow logs) and SSM
(`/platform/config/*`).

## Testing

- Unit tests: `pnpm test`.
- Integration tests run against the **AWS Emulator**:
  `PLAT_EMULATOR_BIN=… pnpm test:integration`.
  - Always start it with `startEmulator({ port: 0 })` so runs don't collide,
    and stop it in `afterAll`.
- Emulator gaps (v1.0.385) are listed in `docs/DESIGN.md` under "Local
  development". Don't assert on behavior it doesn't implement: Web Function
  endpoints, Scheduler firing, Cognito hosted UI, `FilterLogEvents`, or
  Lambda running networked Node code. Its `nodejs24.x` is a sandbox, so
  `plat dev` and `plat test` run workers as local Node processes.

## Members

Invite-only. Members are GitHub usernames in `platform.config.ts`. Adding one
is a reviewed PR; the control plane reads the list at build time.
