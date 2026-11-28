import {
  GetAliasCommand,
  GetFunctionConfigurationCommand,
  GetFunctionUrlConfigCommand,
  GetPolicyCommand,
  ListVersionsByFunctionCommand,
} from '@aws-sdk/client-lambda';
import {
  names,
  newDeploymentId,
  type PlatformRuntimeConfig,
  parseManifest,
} from '@ericminassian/platform-core';
import { strToU8, zipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createEngine,
  type EmulatorConnection,
  type Engine,
  engineContext,
  ensureLocalPlatform,
  findEmulatorBinary,
  isNotFound,
  startEmulator,
} from '../../src/index.ts';

const app = 'reqmode';
const stage = 'pr-7';
const server = names.requestFunction(app, stage);

const withServer = parseManifest({
  name: app,
  web: { server: 'src/server.ts', memoryMb: 512 },
  queues: { jobs: {} },
});
const withoutWorker = parseManifest({ name: app, web: { server: 'src/server.ts', memoryMb: 512 } });
const withoutServer = parseManifest({ name: app, web: { static: 'web/dist' } });

// The emulator has no CloudFront or route store, and its function URLs don't invoke streaming
// handlers, so this covers what the engine provisions: function, versions, aliases, URLs, grants.
describe.skipIf(!findEmulatorBinary() && !process.env.PLAT_EMULATOR_ENDPOINT)(
  'request-mode servers on the emulator',
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

    const deploy = async (manifest: typeof withServer) => {
      const deploymentId = newDeploymentId();
      const artifact = (file: string, code: string) =>
        engine.putArtifact(
          platform,
          names.artifactKey(app, stage, deploymentId, file),
          zipSync({ 'index.mjs': strToU8(code) }),
        );
      return engine.deployStage({
        manifest,
        stage,
        deploymentId,
        platform,
        artifacts: {
          server: await artifact('server.zip', 'export const handler = async () => {};'),
          worker: await artifact(
            'worker.zip',
            'export const handler = async () => ({ batchItemFailures: [] });',
          ),
          static: await engine.putArtifact(
            platform,
            names.artifactKey(app, stage, deploymentId, 'static.zip'),
            zipSync({ 'index.html': strToU8('<!doctype html>') }),
          ),
        },
        webMode: 'function',
        webCompute: 'request',
      });
    };
    const lambda = () => engineContext(engine).clients.lambda;
    const functionNames = async () =>
      (await engine.listStageResources(app, stage)).filter((r) => r.type === 'function').map((r) => r.name);

    it('publishes the server as a version behind an alias with a public, streaming function URL', async () => {
      const result = await deploy(withServer);
      expect(result.compute).toBe('request');
      expect(result.requestFunction).toMatchObject({ name: server, version: '1' });
      expect(result.webFunction).toBeUndefined();

      const config = await lambda().send(new GetFunctionConfigurationCommand({ FunctionName: server }));
      expect(config).toMatchObject({
        Handler: 'index.handler',
        Runtime: 'nodejs24.x',
        MemorySize: 512,
        Architectures: ['arm64'],
        LoggingConfig: {
          LogFormat: 'JSON',
          SystemLogLevel: 'WARN',
          LogGroup: names.logGroup(app, stage, 'web'),
        },
      });
      // The Web Function's entry variable is for Web Functions only.
      expect(config.Environment?.Variables?.AWS_LAMBDA_NODEJS_ENTRYPOINT).toBeUndefined();

      const alias = await lambda().send(new GetAliasCommand({ FunctionName: server, Name: 'live' }));
      expect(alias.FunctionVersion).toBe('1');
      const url = await lambda().send(
        new GetFunctionUrlConfigCommand({ FunctionName: server, Qualifier: 'live' }),
      );
      expect(url).toMatchObject({ AuthType: 'NONE', InvokeMode: 'RESPONSE_STREAM' });
      expect(result.requestFunction?.urlDomain).toBe(
        url.FunctionUrl!.replace(/^https:\/\//, '').replace(/\/$/, ''),
      );
      const policy = await lambda().send(new GetPolicyCommand({ FunctionName: server, Qualifier: 'live' }));
      const statements = (
        JSON.parse(policy.Policy!) as { Statement: Array<{ Action: string; Condition: unknown }> }
      ).Statement;
      expect(statements.map((s) => [s.Action, s.Condition])).toEqual([
        ['lambda:InvokeFunctionUrl', { StringEquals: { 'lambda:FunctionUrlAuthType': 'NONE' } }],
        ['lambda:InvokeFunction', { Bool: { 'lambda:InvokedViaFunctionUrl': 'true' } }],
      ]);
    });

    it('is never taken for one of the worker’s functions', async () => {
      // A redeploy reconciles the worker's functions, and one without a worker removes them all.
      await deploy(withServer);
      expect((await functionNames()).toSorted()).toEqual(
        [server, names.workerFunction(app, stage)].toSorted(),
      );
      await deploy(withoutWorker);
      expect(await functionNames()).toEqual([server]);
      const versions = await lambda().send(new ListVersionsByFunctionCommand({ FunctionName: server }));
      expect(versions.Versions?.map((v) => v.Version)).toEqual(['$LATEST', '1', '2', '3']);
    });

    it('removes the server when the manifest drops it, and on destroy', async () => {
      await deploy(withoutServer);
      expect(await functionNames()).toEqual([]);
      // SQS refuses to recreate a queue for a minute after deleting it, so this one has none.
      await deploy(withoutWorker);
      expect(await functionNames()).toEqual([server]);
      await engine.destroyStage({ app, stage, platform });
      const gone = await lambda()
        .send(new GetFunctionConfigurationCommand({ FunctionName: server }))
        .then(
          () => false,
          (e: unknown) => isNotFound(e),
        );
      expect(gone).toBe(true);
    });
  },
);
