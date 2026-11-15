# One-time setup

This is done once for the platform, never per app. It's deliberately manual.
After it, creating an app needs nothing beyond `plat apps create` + `git push`.

Everything account-specific stays out of this repo (it's public). It goes into
GitHub Actions variables and SSM instead.

## 0. Prerequisites

- SSO access to the management account (github.com/eric-minassian/aws, `pnpm login`).
- Node 24+, pnpm, AWS CLI v2, `gh` (logged in as `eric-minassian`).
- For local development: the AWS Emulator (step 9).

## 1. Create the platform account and DNS hooks (eric-minassian/aws)

Done in [eric-minassian/aws#15](https://github.com/eric-minassian/aws/pull/15). In that repo:

```sh
pnpm login && pnpm deploy
```

This creates:

- the `platform-prod` account in OU `platform`, with an SSO assignment and budget;
- the role `route53-delegation-platform-ericminassian-com`, which lets
  `platform-prod` write only the NS record for `platform.ericminassian.com`;
- the root-zone record `*.ericminassian.com CNAME edge.platform.ericminassian.com`.

Add a `platform-prod` profile to `~/.aws/config`, in the same shape as the
other `<app>-prod` profiles (`sso_session = ericm`, AdministratorAccess,
`region = us-east-1`). Then check it:

```sh
aws sts get-caller-identity --profile platform-prod
```

## 2. GitHub Actions variables (this repo)

```sh
gh variable set AWS_ACCOUNT_ID --body <platform-prod account id>
gh variable set DNS_DELEGATION_ROLE_ARN --body arn:aws:iam::<management account id>:role/route53-delegation-platform-ericminassian-com
gh secret set ALERT_EMAIL --body <where platform alerts go>     # a secret: variables show in public logs
```

## 3. First foundation run (local)

```sh
export AWS_PROFILE=platform-prod
export DNS_DELEGATION_ROLE_ARN=...   # ALERT_EMAIL too, once you've picked one
pnpm install
pnpm platform:deploy -- --plan   # prints every step, changes nothing
pnpm platform:deploy
```

The first run creates the delegated `platform.ericminassian.com` zone and
registers its NS record in the root zone. It requests two certificates:

- `*.platform.ericminassian.com`: validated automatically in the delegated zone.
- `*.ericminassian.com`: needs one record in the root zone. The run **stops
  here** and prints the validation CNAME.

## 4. Certificate validation record (eric-minassian/aws)

Done in [eric-minassian/aws#19](https://github.com/eric-minassian/aws/pull/19).
It adds the printed record to `DNS_ZONES` in `cdk/config.ts`; ACM re-checks it
at every renewal, so it stays. After `pnpm deploy` there, the certificate
showed `ISSUED` within a few minutes:

```sh
aws acm list-certificates --region us-east-1 --profile platform-prod
```

## 5. Finish the foundation

```sh
pnpm platform:deploy
```

This creates:

- the router (KeyValueStore, CloudFront Function, distribution, `edge` and
  console aliases);
- buckets, tables and the Cognito user pool with `login.platform.ericminassian.com`;
- IAM (permission boundary, control plane role, GitHub OIDC provider,
  `platform-ci` role);
- the alerts topic, session key and runtime config;
- the control plane app;
- the account-level log subscription that feeds telemetry.

On a first run the Cognito step waits a few minutes. Cognito accepts the
custom domain only once `platform.ericminassian.com` resolves, and that
record aliases the distribution, which is still deploying.

From now on, every merge to `main` re-runs this through
`.github/workflows/deploy-platform.yml`.

## 6. Alerts email

Without `ALERT_EMAIL`, the `platform-alerts` topic exists but nobody is
subscribed. To subscribe:

1. Set the `ALERT_EMAIL` secret (step 2).
2. Re-run `pnpm platform:deploy` with it exported.
3. Click the confirmation link SNS sends.

## 7. GitHub App (console sign-in + error issues)

Create it at https://github.com/settings/apps/new (GitHub → Settings → Developer
settings → GitHub Apps → New GitHub App):

- **Homepage:** `https://platform.ericminassian.com`
- **Callback URL:** `https://platform.ericminassian.com/auth/github/callback`
- **Webhook:** uncheck Active
- **Permissions:** Repository → Issues: read & write (Metadata: read is added automatically)
- **Where can it be installed:** only on this account

On the App's General page:

- Note the **App ID** and **Client ID** at the top.
- Under **Client secrets**, generate a new client secret.
- Under **Private keys**, generate a private key; GitHub downloads a `.pem` file.

Then choose **Install App** in the left sidebar and install it on your account
with **All repositories**, so error issues can open in any app repo. You don't
need the installation id or a JWT: the control plane signs its own JWT with the
private key and looks up the installation for each repo.

Store the settings:

```sh
P=/platform/config/github-app
aws ssm put-parameter --profile platform-prod --name $P/app_id --type String --value <app id>
aws ssm put-parameter --profile platform-prod --name $P/client_id --type String --value <client id>
aws ssm put-parameter --profile platform-prod --name $P/client_secret --type SecureString --value <client secret>
aws ssm put-parameter --profile platform-prod --name $P/private_key --type SecureString --value "$(cat app.private-key.pem)"
```

## 8. Cost allocation tags (management account)

Once the platform has created tagged resources (a day after step 5), run:

```sh
aws ce update-cost-allocation-tags-status --profile management \
  --cost-allocation-tags-status TagKey=platform:app,Status=Active TagKey=platform:stage,Status=Active
```

## 9. Local development machines

Install the AWS Emulator once per machine (Debian/Ubuntu shown; for RPM,
arm64 and Docker on macOS/Windows see the AWS docs):

```sh
curl -fsSLo aws-emulator.deb https://downloads.aws.com/aws-emulator/packages/aws-emulator/LTS/latest/aws-emulator_amd64.deb
sudo apt-get install -y ./aws-emulator.deb
aws-emulator -v
```

`plat dev` finds it on `PATH`, or via `PLAT_EMULATOR_BIN`. With Docker, run
the container and set `PLAT_EMULATOR_ENDPOINT` + `PLAT_EMULATOR_HOME`.

## 10. npm packages

The four public packages are `@eric-minassian/platform-core`,
`@eric-minassian/platform`, `@eric-minassian/platform-engine` and
`@eric-minassian/plat`. npm trusted publishing can only be configured on a
package that already exists, so:

1. Publish once by hand: `npm login`, then `pnpm -r --filter './packages/*' publish --access public`.
2. On npmjs.com, add a trusted publisher to each package: GitHub Actions,
   repository `eric-minassian/platform`, workflow `release.yml`.
3. Later releases go through the `release` workflow with no tokens.

## 11. Smoke test

```sh
plat login
plat apps create hello --repo eric-minassian/hello
plat init hello && cd hello
gh repo create eric-minassian/hello --private --source . --push
gh run watch                       # app CI deploys prod
curl -s https://hello.ericminassian.com/__platform/health
curl -s -X POST https://hello.ericminassian.com/api/todos -H 'content-type: application/json' -d '{}' -i | head -1   # 401 = body reached the Web Function via OAC
```

Then open a PR in `hello` and check that:

- the preview URL comment appears;
- `https://hello--pr-1.ericminassian.com` serves the preview build, and
  `https://hello.ericminassian.com` keeps serving prod (no cross-host cache
  sharing);
- closing the PR removes the preview.

## Inviting someone later

1. Add `{ github: '<username>', role: 'member' }` to `members` in
   `platform.config.ts` and merge. CI redeploys the platform.
2. They run `plat login`, which uses their own `gh` token.
