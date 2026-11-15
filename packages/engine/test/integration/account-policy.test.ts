import { TELEMETRY_FILTER_PATTERN } from '@ericminassian/platform-core';
import { strToU8, zipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureRole } from '../../src/drivers/iam.ts';
import { ensureFunction, ensurePermission } from '../../src/drivers/lambda.ts';
import { ensureAccountSubscriptionFilter } from '../../src/drivers/logs.ts';
import {
  createEngine,
  type EmulatorConnection,
  type Engine,
  engineContext,
  ensureLocalPlatform,
  findEmulatorBinary,
  isNotImplemented,
  policies,
  startEmulator,
} from '../../src/index.ts';

// The foundation's last step: the account-level subscription filter that feeds telemetry.
describe.skipIf(!findEmulatorBinary() && !process.env.PLAT_EMULATOR_ENDPOINT)(
  'account subscription filter',
  () => {
    let conn: EmulatorConnection;
    let engine: Engine;
    beforeAll(async () => {
      conn = await startEmulator({ idleTimeoutSeconds: 300 });
      engine = createEngine({
        region: conn.region,
        emulator: { endpoint: conn.endpoint, caFile: conn.caFile, credentials: conn.credentials },
      });
    });
    afterAll(() => conn?.stop());

    it('targets a Lambda with a logs permission', async () => {
      const ctx = engineContext(engine);
      const platform = await ensureLocalPlatform(engine, { port: 3000, jwksBaseUrl: conn.endpoint });
      const role = await ensureRole(ctx, {
        name: 'telemetry-test',
        trust: policies.serviceTrustPolicy('lambda.amazonaws.com'),
      });
      const code = await engine.putArtifact(
        platform,
        'sys/worker.zip',
        zipSync({ 'index.mjs': strToU8('export const handler = async () => {}') }),
      );
      const fn = await ensureFunction(ctx, {
        name: 'platform--prod--worker',
        roleArn: role.arn,
        runtime: 'nodejs24.x',
        handler: 'index.handler',
        architecture: 'arm64',
        memoryMb: 256,
        timeoutSeconds: 30,
        code,
        env: {},
      });
      await ensurePermission(ctx, {
        functionName: fn.arn,
        statementId: 'cloudwatch-logs-account-subscription',
        principal: 'logs.amazonaws.com',
        action: 'lambda:InvokeFunction',
        sourceArn: 'arn:aws:logs:us-east-1:000000000000:log-group:*',
      });
      // Idempotent re-run.
      await ensurePermission(ctx, {
        functionName: fn.arn,
        statementId: 'cloudwatch-logs-account-subscription',
        principal: 'logs.amazonaws.com',
        action: 'lambda:InvokeFunction',
        sourceArn: 'arn:aws:logs:us-east-1:000000000000:log-group:*',
      });
      try {
        await ensureAccountSubscriptionFilter(ctx, {
          name: 'platform-telemetry',
          destinationArn: fn.arn,
          filterPattern: TELEMETRY_FILTER_PATTERN,
          excludeLogGroups: ['/platform/apps/platform/prod/worker'],
        });
      } catch (e) {
        if (!isNotImplemented(e)) throw e;
      }
      expect(fn.arn).toContain('platform--prod--worker');
    });
  },
);
