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

## 3. Bootstrap CDK (once per account)

The platform's shared resources are one CDK stack, `platform-foundation`
(`foundation/src/stack.ts`). CDK deploys through a `CDKToolkit` stack (an
asset bucket and deploy roles) that has to exist first:

```sh
export AWS_PROFILE=platform-prod
export DNS_DELEGATION_ROLE_ARN=...   # ALERT_EMAIL too, once you've picked one
pnpm install
pnpm --filter @ericminassian/platform-foundation exec cdk bootstrap aws://<platform-prod account id>/us-east-1
```

## 4. First deploy (local)

```sh
pnpm platform:diff     # what the deploy would change
pnpm platform:deploy
```

This deploys the stack, then the control plane app, then the account-level
log subscription that feeds telemetry (`foundation/src/deploy.ts`). The
stack creates:

- the delegated `platform.ericminassian.com` zone, with its NS record in the
  root zone (written through the delegation role);
- certificates for `platform.ericminassian.com` + `*.platform.ericminassian.com`
  (validated in the delegated zone) and `*.ericminassian.com` (step 5);
- the router (KeyValueStore, CloudFront Function, distribution, `edge` and
  console aliases);
- buckets, tables and the Cognito user pool with `login.platform.ericminassian.com`;
- IAM (permission boundary, control plane role, GitHub OIDC provider,
  `platform-ci` role);
- the alerts topic and runtime config.

The deploy also generates the session key once. It's a SecureString, which
CloudFormation can't create.

## 5. Certificate validation record (eric-minassian/aws)

On a first deploy the stack waits on the `*.ericminassian.com` certificate:
its validation CNAME belongs in the root zone, which this account can't
write. While it waits, read the record:

```sh
aws acm list-certificates --region us-east-1 --profile platform-prod \
  --query "CertificateSummaryList[?DomainName=='*.ericminassian.com'].CertificateArn" --output text
aws acm describe-certificate --region us-east-1 --profile platform-prod --certificate-arn <arn> \
  --query 'Certificate.DomainValidationOptions[0].ResourceRecord'
```

Add it to `DNS_ZONES` in `cdk/config.ts` in eric-minassian/aws and
`pnpm deploy` there (done in
[eric-minassian/aws#19](https://github.com/eric-minassian/aws/pull/19)). ACM
issues the certificate within a few minutes and the stack carries on; if the
deploy gave up first, run it again. ACM re-checks the record at every
renewal, so it stays.

From now on, every merge to `main` diffs and deploys through
`.github/workflows/deploy-platform.yml`. Deploys use drift-aware change sets,
so changes made to the stack's resources outside the template are undone.

## 6. Alerts email

Without `ALERT_EMAIL`, the `platform-alerts` topic exists but nobody is
subscribed, and a deploy without it removes an existing subscription. To
subscribe:

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

The four public packages are `@ericminassian/platform-core`,
`@ericminassian/platform`, `@ericminassian/platform-engine` and
`@ericminassian/plat`. The scope is the npm username (`ericminassian`, no
hyphen), so there is no npm organization to create. Each package builds
itself on pack (`prepack`), since `publishConfig` points at `dist/`.

npm trusted publishing can only be configured on a package that already
exists, so:

1. Publish once by hand from an up-to-date `main`: `npm login`, then
   `pnpm -r --filter './packages/*' publish --access public`.
2. Add a trusted publisher to each package that allows `npm publish` (npm
   ≥ 11.15, account 2FA):

   ```sh
   for p in @ericminassian/platform-core @ericminassian/platform @ericminassian/platform-engine @ericminassian/plat; do
     npm trust github "$p" --file release.yml --repo eric-minassian/platform --allow-publish --yes
   done
   ```

   On npmjs.com this is "npm publish" under Allowed actions, which is off by
   default; without it the workflow fails with "OIDC permission denied for
   this action". A publisher can't be edited: `npm trust revoke` it and add it
   again.

3. Release within 2 days of adding the publishers, or npm expires them: bump
   the package versions, merge, then run the `release` workflow. It publishes
   only versions that aren't on npm yet.

## 11. Email: SES production access

A new account's SES is in the sandbox: 200 emails a day, and only to
addresses verified in SES. Apps that declare `email` deploy and send, but a
send to anyone else fails with `EmailNotSent` (`rejected`), and the user pool
keeps Cognito's own sender (50 emails a day for the whole pool).

After the foundation deploy has verified `mail.platform.ericminassian.com`,
ask AWS for production access:

```sh
aws sesv2 put-account-details --profile platform-prod --region us-east-1 \
  --production-access-enabled --mail-type TRANSACTIONAL \
  --website-url https://platform.ericminassian.com --contact-language EN \
  --use-case-description '<who receives mail, how bounces and complaints are handled, volume>'
aws sesv2 get-account --profile platform-prod --region us-east-1 --query Details.ReviewDetails
```

AWS answers in the account's Support Center case (the `CaseId` above),
usually within a day. A denial can be answered there with more detail. Once
`ProductionAccessEnabled` is true, the next platform deploy moves the user
pool's mail to SES (`login@mail.platform.ericminassian.com`).

While in the sandbox, verify an address to test with:

```sh
aws sesv2 create-email-identity --profile platform-prod --region us-east-1 --email-identity you@example.com
```

## 12. Smoke test

```sh
npm install -g @ericminassian/plat
plat login
plat apps create hello --repo eric-minassian/hello
plat init hello && cd hello
pnpm install                       # creates the lockfile CI installs from
git init && git add -A && git commit -m "Initial commit"
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
