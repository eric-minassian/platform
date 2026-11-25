import { randomUUID } from 'node:crypto';
import {
  DeleteWebFunctionRevisionCommand,
  ListWebFunctionRevisionsCommand,
} from '@aws-sdk/client-lambda-web';
import { names, type PlatformRuntimeConfig } from '@ericminassian/platform-core';
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
import { isNotImplemented } from '../../src/util.ts';

// The emulator implements Web Functions, revisions and (since after 1.0.385)
// endpoints and revision deletion; this exercises the driver and the
// timestamp compat middleware.
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
        initial: { revision: await revision(0), endpointName: names.webEndpoints()[0] },
      });
      expect(created.arn).toContain(':web-function/');
      const again = await ensureWebFunction(ctx, {
        name: fnName,
        initial: { revision: await revision(0), endpointName: names.webEndpoints()[0] },
      });
      expect(again).toEqual({ arn: created.arn });

      const ids: string[] = created.initialRevisionId ? [created.initialRevisionId] : [];
      while (ids.length < 4) ids.push(await createRevision(ctx, await revision(ids.length)));
      expect(new Set(ids).size).toBe(4);
      const lw = ctx.clients.lambdaWeb;

      // The first revision serves the endpoint, so it's kept the way a stage keeps
      // its endpoints' revisions: AWS refuses to delete one serving traffic.
      const [serving, , ...newest] = ids as [string, string, string, string];
      await pruneRevisions(ctx, fnName, { keepNewest: 2, keep: [serving] });
      const after = (await lw.send(new ListWebFunctionRevisionsCommand({ functionName: fnName }))).revisions;
      // Emulator 1.0.385 doesn't implement deleting revisions, so pruning leaves them all there.
      const deletes = await lw
        .send(new DeleteWebFunctionRevisionCommand({ functionName: fnName, revisionId: randomUUID() }))
        .then(
          () => true,
          (e: unknown) => !isNotImplemented(e),
        );
      expect((after ?? []).map((r) => r.revisionId ?? '').toSorted()).toEqual(
        (deletes ? [serving, ...newest] : ids).toSorted(),
      );
    });
  },
);
