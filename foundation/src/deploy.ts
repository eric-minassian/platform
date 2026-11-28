/**
 * Deploy the platform itself, in three phases. Safe to re-run.
 *
 *  1. foundation     the platform-foundation stack (CDK), plus the session
 *                    key, a generated secret CloudFormation can't hold
 *  2. control-plane  services/control-plane as the `platform` app, through
 *                    the engine like any other app; then realtime's public
 *                    subscribe key and route-store entry, the route-store
 *                    entries of `hosts`, and the edge floor alarm's
 *                    permission to invoke the worker
 *  3. telemetry      the account-level log subscription and the router access
 *                    log's, which target the control plane's worker and so
 *                    come after it
 *
 *   node src/deploy.ts                       # everything (admin credentials)
 *   node src/deploy.ts --only control-plane  # a subset of phases
 *
 * See docs/SETUP.md for the one-time manual steps around it.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import {
  names,
  type PlatformRuntimeConfig,
  PROD_STAGE,
  platformNames,
  TELEMETRY_FILTER_PATTERN,
} from '@ericminassian/platform-core';
import {
  createEngine,
  type EngineContext,
  type EngineLogEntry,
  engineContext,
  ensureAccountSubscriptionFilter,
  ensureParameterOnce,
  ensurePermission,
  ensureSubscriptionFilter,
  getParameter,
  removePermission,
} from '@ericminassian/platform-engine';
import config from '../../platform.config.ts';
import { deployControlPlane } from './control-plane.ts';
import { CONTROL_PLANE_APP, FOUNDATION_STACK } from './stack.ts';

const PHASES = ['foundation', 'control-plane', 'telemetry'] as const;
/** The worker's resource-policy statement that lets the edge floor's trigger invoke it. */
const EDGE_FLOOR_PERMISSION = 'platform-edge-floor';
type Phase = (typeof PHASES)[number];

const foundationDir = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

function parsePhases(args: string[]): Phase[] {
  const i = args.indexOf('--only');
  if (i < 0) return [...PHASES];
  const wanted = (args[i + 1] ?? '').split(',').filter(Boolean);
  const unknown = wanted.filter((p) => !(PHASES as readonly string[]).includes(p));
  if (!wanted.length || unknown.length)
    throw new Error(`--only takes a comma-separated list of: ${PHASES.join(', ')}`);
  return PHASES.filter((p) => wanted.includes(p));
}

function printEngineLog(e: EngineLogEntry) {
  const mark = e.level === 'error' ? '✗' : e.level === 'warn' ? '!' : '·';
  console.log(`    ${mark} ${e.msg}${e.resource ? `  (${e.resource})` : ''}`);
}

async function describeStack() {
  const cfn = new CloudFormationClient({ region: config.region });
  try {
    return (await cfn.send(new DescribeStacksCommand({ StackName: FOUNDATION_STACK }))).Stacks?.[0];
  } catch (e) {
    if (/does not exist/.test((e as Error).message)) return undefined;
    throw e;
  }
}

/** `cdk deploy` with the CLI pinned in this package. */
async function deployStack(): Promise<void> {
  const cdk = createRequire(import.meta.url).resolve('aws-cdk/bin/cdk');
  const args = [cdk, 'deploy', FOUNDATION_STACK, '--require-approval', 'never', '--progress', 'events'];
  // The template is the source of truth: a drift-aware change set also undoes
  // changes made outside it (console edits). CloudFormation only offers it
  // for stacks that already exist.
  if (await describeStack()) args.push('--revert-drift');
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: foundationDir, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', resolve);
  });
  if (code !== 0) throw new Error(`cdk deploy exited with ${code}`);
}

async function stackOutput(key: string): Promise<string> {
  const value = (await describeStack())?.Outputs?.find((o) => o.OutputKey === key)?.OutputValue;
  if (!value) throw new Error(`stack ${FOUNDATION_STACK} has no output ${key}; deploy the foundation first`);
  return value;
}

async function runtimeConfig(ctx: EngineContext): Promise<PlatformRuntimeConfig> {
  const raw = await getParameter(ctx, platformNames.runtimeConfigParameter);
  if (!raw)
    throw new Error(`${platformNames.runtimeConfigParameter} is missing; deploy the foundation first`);
  return JSON.parse(raw) as PlatformRuntimeConfig;
}

async function main(): Promise<void> {
  const phases = parsePhases(process.argv.slice(2));
  const engine = createEngine({ region: config.region, log: printEngineLog });
  const ctx = engineContext(engine);

  if (phases.includes('foundation')) {
    console.log(`▸ foundation: stack ${FOUNDATION_STACK}`);
    await deployStack();
    await ensureParameterOnce(ctx, {
      name: platformNames.sessionKeyParameter,
      secure: true,
      description: 'HMAC key for platform sessions and CLI tokens',
      generate: () => randomBytes(32).toString('base64url'),
    });
  }

  if (phases.includes('control-plane')) {
    console.log(`▸ control-plane: app "${CONTROL_PLANE_APP}" (stage ${PROD_STAGE})`);
    const runtime = await runtimeConfig(ctx);
    const result = await deployControlPlane({
      engine,
      ctx,
      config,
      runtime,
      roleArn: await stackOutput('ControlPlaneRoleArn'),
      repoRoot,
    });
    console.log(`    control plane ${result.deploymentId} → ${result.url}`);
    // The edge floor's trigger (stack.ts) invokes the worker, which only exists from here on.
    // The sid doesn't start with `events-`: the engine prunes those it didn't make for the stage.
    if (runtime.edgeFloor) {
      await ensurePermission(ctx, {
        functionName: names.workerFunction(CONTROL_PLANE_APP, PROD_STAGE),
        statementId: EDGE_FLOOR_PERMISSION,
        principal: 'events.amazonaws.com',
        action: 'lambda:InvokeFunction',
        sourceArn: runtime.edgeFloor.ruleArn,
      });
      console.log('    edge floor: its alarm can reach the worker');
    } else {
      await removePermission(ctx, names.workerFunction(CONTROL_PLANE_APP, PROD_STAGE), EDGE_FLOOR_PERMISSION);
    }
    // The public subscribe key and the router's realtime entry live outside the stack (the
    // control plane extends the key nightly); make sure both exist as soon as the API does.
    if (await engine.ensureRealtimePlatform(runtime))
      console.log('    realtime: key and route entry current');
    // platform.config.ts `hosts`: each is an entry in the route store, which no app deploy writes.
    const hosts = await engine.ensureHosts(runtime);
    console.log(`    hosts: ${hosts.length ? `updated ${hosts.join(', ')}` : 'current'}`);
  }

  if (phases.includes('telemetry')) {
    console.log('▸ telemetry: account-level log subscription → control plane worker');
    const runtime = await runtimeConfig(ctx);
    const workerArn = runtime.telemetryFunctionArn;
    if (!workerArn) throw new Error('runtime config has no telemetryFunctionArn');
    await ensurePermission(ctx, {
      functionName: workerArn,
      statementId: 'cloudwatch-logs-account-subscription',
      principal: 'logs.amazonaws.com',
      action: 'lambda:InvokeFunction',
      sourceArn: `arn:aws:logs:${runtime.region}:${runtime.accountId}:log-group:*`,
    });
    // The processor's own log group is excluded so it can't feed itself, and the router's access
    // log has a filter of its own: none of its lines are telemetry lines, and all of them count.
    await ensureAccountSubscriptionFilter(ctx, {
      name: 'platform-telemetry',
      destinationArn: workerArn,
      filterPattern: TELEMETRY_FILTER_PATTERN,
      excludeLogGroups: [names.logGroup(CONTROL_PLANE_APP, PROD_STAGE, 'worker'), platformNames.edgeLogGroup],
    });
    await ensureSubscriptionFilter(ctx, {
      name: platformNames.edgeLogDelivery,
      logGroup: platformNames.edgeLogGroup,
      destinationArn: workerArn,
      filterPattern: '',
    });
  }

  console.log('\nPlatform is up to date.');
}

try {
  await main();
} catch (e) {
  console.error(`\n✗ ${e instanceof Error ? (e.stack ?? String(e)) : String(e)}`);
  process.exitCode = 1;
}
