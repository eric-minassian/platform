/**
 * CDK app for the platform's shared resources (one stack). The CDK CLI runs
 * it and sets CDK_DEFAULT_ACCOUNT from the current credentials:
 *
 *   pnpm platform:diff     # what a deploy would change
 *   pnpm platform:deploy   # this stack, then the control plane (src/deploy.ts)
 */
import { App } from 'aws-cdk-lib';
import config from '../../platform.config.ts';
import { FOUNDATION_STACK, FoundationStack } from './stack.ts';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing environment: ${name} (see docs/SETUP.md)`);
  return value;
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
});
