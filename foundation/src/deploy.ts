/**
 * Apply the platform's shared resources, in order, with the engine's
 * idempotent drivers (no CloudFormation, no state file). Safe to re-run.
 *
 *   node src/deploy.ts            # apply against AWS (admin credentials)
 *   node src/deploy.ts --plan     # print the steps, touch nothing
 *   node src/deploy.ts --emulator # apply against a throwaway AWS Emulator
 *   node src/deploy.ts --only iam,parameters
 *
 * See docs/SETUP.md for the one-time manual steps around it.
 */
import { fileURLToPath } from 'node:url';
import {
  createEngine,
  type EmulatorConnection,
  type EngineLogEntry,
  engineContext,
  errorName,
  isNotImplemented,
  startEmulator,
} from '@eric-minassian/platform-engine';
import config from '../../platform.config.ts';
import { BlockedError, type FoundationContext } from './context.ts';
import { STEPS } from './steps.ts';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const plan = flag('plan');
const emulator = flag('emulator');
const only = option('only')?.split(',');
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

function printEngineLog(e: EngineLogEntry) {
  const mark = e.level === 'error' ? '✗' : e.level === 'warn' ? '!' : '·';
  console.log(`    ${mark} ${e.msg}${e.resource ? `  (${e.resource})` : ''}`);
}

async function main(): Promise<number> {
  const steps = STEPS.filter((s) => !only || only.includes(s.id));
  if (plan) {
    console.log(`Foundation plan for ${config.domain} (${config.region}):`);
    for (const [i, s] of steps.entries()) {
      console.log(
        `  ${String(i + 1).padStart(2)}. ${s.id.padEnd(14)} ${s.describe(config)}${s.awsOnly ? '  [AWS only]' : ''}`,
      );
    }
    return 0;
  }

  let conn: EmulatorConnection | undefined;
  try {
    if (emulator) conn = await startEmulator({ region: config.region, idleTimeoutSeconds: 600 });
    const engine = createEngine({
      region: config.region,
      ...(conn
        ? { emulator: { endpoint: conn.endpoint, caFile: conn.caFile, credentials: conn.credentials } }
        : {}),
      log: printEngineLog,
    });
    const f: FoundationContext = {
      config,
      engine,
      ctx: engineContext(engine),
      emulator,
      repoRoot,
      env: {
        ...(process.env.DNS_DELEGATION_ROLE_ARN
          ? { dnsDelegationRoleArn: process.env.DNS_DELEGATION_ROLE_ARN }
          : {}),
        ...(process.env.ALERT_EMAIL ? { alertEmail: process.env.ALERT_EMAIL } : {}),
      },
      state: {},
      log: (msg) => console.log(`    ${msg}`),
    };

    for (const step of steps) {
      if (emulator && step.awsOnly) {
        console.log(`- ${step.id}: skipped on the emulator`);
        continue;
      }
      console.log(`▸ ${step.id}: ${step.describe(config)}`);
      try {
        await step.run(f);
      } catch (e) {
        if (e instanceof BlockedError) {
          console.error(`\n⏸  ${step.id} is blocked:\n\n${e.message}\n`);
          return 2;
        }
        if (emulator && (isNotImplemented(e) || errorName(e) === 'UnknownOperationException')) {
          console.log(`    ! not supported by the emulator, continuing: ${(e as Error).message}`);
          continue;
        }
        console.error(`\n✗ ${step.id} failed: ${(e as Error).stack ?? e}`);
        return 1;
      }
    }

    console.log('\nFoundation is up to date.');
    const s = f.state;
    const summary: Record<string, string | undefined> = {
      account: s.accountId,
      distribution: s.distribution ? `${s.distribution.id} (${s.distribution.domainName})` : undefined,
      userPool: s.userPoolId,
      controlPlaneRole: s.controlPlaneRoleArn,
      ciRole: s.ciRoleArn,
      controlPlaneWorker: s.controlPlaneWorkerArn,
    };
    for (const [k, v] of Object.entries(summary)) if (v) console.log(`  ${k.padEnd(19)} ${v}`);
    if (s.ciRoleArn && s.accountId && !emulator)
      console.log(
        `\nCI (deploy-platform.yml) assumes ${s.ciRoleArn}; it needs repository variable` +
          ` AWS_ACCOUNT_ID=${s.accountId} on ${config.github.owner}/${config.github.repo} (docs/SETUP.md step 2).`,
      );
    return 0;
  } finally {
    await conn?.stop();
  }
}

process.exitCode = await main();
