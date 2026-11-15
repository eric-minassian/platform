/**
 * CDK app for the platform's shared resources (one stack). The CDK CLI runs
 * it and sets CDK_DEFAULT_ACCOUNT from the current credentials:
 *
 *   pnpm platform:diff     # what a deploy would change
 *   pnpm platform:deploy   # this stack, then the control plane (src/deploy.ts)
 */
import { GetAccountCommand, GetEmailIdentityCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import { emailDomain } from '@ericminassian/platform-core';
import { App } from 'aws-cdk-lib';
import config from '../../platform.config.ts';
import { FOUNDATION_STACK, FoundationStack, type FoundationStackProps } from './stack.ts';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing environment: ${name} (see docs/SETUP.md)`);
  return value;
}

/**
 * Whether the user pool sends its mail through the platform's SES domain.
 * While the account is in the SES sandbox, SES delivers only to verified
 * addresses, so Cognito's sign-up and reset codes would never reach users:
 * until AWS grants production access the pool keeps Cognito's own sender, and
 * the first platform deploy after that switches it. The domain must also have
 * verified already (the deploy that creates it only publishes its DNS
 * records), so the pool never names an identity that can't send yet.
 */
async function userPoolEmail(): Promise<FoundationStackProps['userPoolEmail']> {
  const client = new SESv2Client({ region: config.region });
  const account = await client.send(new GetAccountCommand({}));
  if (!account.ProductionAccessEnabled) {
    console.warn('SES has no production access yet: the user pool keeps sending with Cognito');
    return 'cognito';
  }
  const domain = emailDomain(config.zone);
  const identity = await client
    .send(new GetEmailIdentityCommand({ EmailIdentity: domain }))
    .catch((e: Error) => (e.name === 'NotFoundException' ? undefined : Promise.reject(e)));
  if (!identity?.VerifiedForSendingStatus) {
    console.warn(`${domain} isn't verified in SES yet: the user pool keeps sending with Cognito`);
    return 'cognito';
  }
  return 'ses';
}

const alertEmail = process.env.ALERT_EMAIL || undefined;
if (!alertEmail)
  console.warn(
    'ALERT_EMAIL is not set: the alerts topic has no email subscription (an existing one is removed)',
  );

new FoundationStack(new App(), FOUNDATION_STACK, {
  env: { account: required('CDK_DEFAULT_ACCOUNT'), region: config.region },
  config,
  dnsDelegationRoleArn: required('DNS_DELEGATION_ROLE_ARN'),
  ...(alertEmail ? { alertEmail } : {}),
  userPoolEmail: await userPoolEmail(),
});
