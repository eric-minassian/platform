# platform.ericminassian.com

A private, invite-only PaaS. It runs TypeScript apps at `https://<app>.ericminassian.com` with sign-in, a document database, queues, events, crons, file storage, secrets, per-PR previews, and logs, traces, metrics and errors built in. App repos contain no infrastructure code and no AWS credentials.

## For AI agents

- Work through the `plat` CLI, not this website. The web console needs a person to sign in with GitHub, so don't try to sign in.
- Every command accepts `--json`. `plat --help` and `plat <command> --help` list the flags.
- This guide is also plain text at https://platform.ericminassian.com/llms.txt. If your fetch tool summarized this page, download that file (for example with `curl`) to get the exact commands.

## 1. Set up

You need Node.js 24+, pnpm, git, and the GitHub CLI (`gh`) signed in to an invited GitHub account.

```sh
npm install -g @ericminassian/plat
gh auth status
plat login      # exchanges `gh auth token` for a platform token
plat whoami
```

If `plat login` fails with `not_a_member`, stop and tell the user. Their GitHub account must be added to `members` in `platform.config.ts` at https://github.com/eric-minassian/platform.

## 2. Create an app

```sh
plat init <name>
cd <name>
pnpm install
plat apps create <name> --repo <owner>/<name>   # before the first push, or CI deploys are rejected
git init && git add -A && git commit -m "Initial commit"
gh repo create <owner>/<name> --private --source . --push
```

Then read `AGENTS.md` in the new app before you change anything. It covers `plat.config.ts`, the `@ericminassian/platform` SDK, recipes, local development and debugging.

## 3. Ship

- The repo's `.github/workflows/platform.yml` (from the template) tests and deploys. It signs in with GitHub OIDC; don't add AWS credentials or deploy secrets.
- A pull request deploys a preview to `https://<name>--pr-<n>.ericminassian.com` and comments the URL on the PR. Closing the PR removes it.
- A merge to `main` deploys `https://<name>.ericminassian.com`.

## Existing apps

```sh
plat apps list
plat apps show <name>
```

Clone the app's repo and read its `AGENTS.md`.

## Observe and operate

Run these in the app's directory, or pass `--app <name>`. `--stage` defaults to `prod`; previews are `pr-<n>`.

```sh
plat logs --since 30m [--filter error] [--follow]
plat errors
plat traces <traceId>
plat metrics --since 6h
plat data [collection] [--partition key=value]
plat deployments
plat rollback [--to <deploymentId>]
plat secrets set <NAME> [--shared] < value.txt
plat cron run <name>
```

## Rules

- No CDK, CloudFormation, Terraform or `@aws-sdk/*` in apps. Declare what the app needs in `plat.config.ts` and use it through `@ericminassian/platform`.
- Never commit secrets. Use `plat secrets set`, and `.env.local` (git-ignored) for local development.
