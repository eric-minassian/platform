import { names, type PlatformRuntimeConfig } from '@eric-minassian/platform-core';
import { strToU8, zipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureRole } from '../../src/drivers/iam.ts';
import { createRevision, ensureWebFunction, pruneRevisions } from '../../src/drivers/web-function.ts';
import {
  createEngine,
  type EmulatorConnection,
  type Engine,
  engineContext,
  ensureLocalPlatform,
  findEmulatorBinary,
  policies,
  startEmulator,
} from '../../src/index.ts';

// The emulator implements Web Functions and revisions (but not endpoints yet);
// this exercises the driver and the timestamp compat middleware.
describe.skipIf(!findEmulatorBinary() && !process.env.PLAT_EMULATOR_ENDPOINT)(
  'Web Function revisions on the emulator',
  () => {
    let conn: EmulatorConnection;
    let engine: Engine;
    let platform: PlatformRuntimeConfig;

    beforeAll(async () => {
      conn = await startEmulator({ idleTimeoutSeconds: 300 });
      engine = createEngine({
        region: conn.region,
        emulator: { endpoint: conn.endpoint, caFile: conn.caFile, credentials: conn.credentials },
      });
      platform = await ensureLocalPlatform(engine, { port: 3000, jwksBaseUrl: conn.endpoint });
    });
    afterAll(() => conn?.stop());

    it('creates a function, revisions, and prunes old ones', async () => {
      const ctx = engineContext(engine);
      const role = await ensureRole(ctx, {
        name: 'web--test',
        path: '/platform/apps/',
        trust: policies.stageTrustPolicy(),
      });
      const fnName = names.webFunction('web', 'test');
      const revision = async (i: number) => ({
        functionName: fnName,
        code: await engine.putArtifact(
          platform,
          `web/test/d${i}/server.zip`,
          zipSync({ 'index.mjs': strToU8(`console.log(${i})`) }),
        ),
        runtime: 'nodejs24.x',
        roleArn: role.arn,
        env: { AWS_LAMBDA_NODEJS_ENTRYPOINT: 'index.mjs' },
        timeoutSeconds: 30,
        maxConcurrency: 64,
        logGroup: names.logGroup('web', 'test', 'web'),
      });

      // AWS creates a function together with its first revision and endpoint.
      const created = await ensureWebFunction(ctx, {
        name: fnName,
        initial: { revision: await revision(0), endpointName: names.webEndpoint() },
      });
      expect(created.arn).toContain(':web-function/');
      const again = await ensureWebFunction(ctx, {
        name: fnName,
        initial: { revision: await revision(0), endpointName: names.webEndpoint() },
      });
      expect(again).toEqual({ arn: created.arn });

      const ids: string[] = created.initialRevisionId ? [created.initialRevisionId] : [];
      while (ids.length < 3) ids.push(await createRevision(ctx, await revision(ids.length)));
      expect(new Set(ids).size).toBe(3);
      await pruneRevisions(ctx, fnName, { keepNewest: 2, keep: [] });
    });
  },
);
