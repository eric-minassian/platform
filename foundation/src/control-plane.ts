import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import {
  appItem,
  deploymentItem,
  type StageItem,
  stageItem,
  stageKey,
} from '@ericminassian/platform-control-plane/records';
import {
  type ArtifactFile,
  names,
  newDeploymentId,
  type PlatformConfig,
  type PlatformRuntimeConfig,
  PROD_STAGE,
  type ResolvedManifest,
} from '@ericminassian/platform-core';
import type { Engine, EngineContext } from '@ericminassian/platform-engine';

export const CONTROL_PLANE_DIR = 'services/control-plane';

type DeployResult = Awaited<ReturnType<Engine['deployStage']>>;

/**
 * Build services/control-plane and deploy it as the `platform` app (stage
 * prod) with the engine, like any other app. The API can't deploy itself,
 * so this runs from the platform's own deploy.
 */
export async function deployControlPlane(opts: {
  engine: Engine;
  ctx: EngineContext;
  config: PlatformConfig;
  runtime: PlatformRuntimeConfig;
  roleArn: string;
  repoRoot: string;
}): Promise<DeployResult & { deploymentId: string }> {
  const { engine, runtime } = opts;
  const spec = '@ericminassian/plat';
  const cli = (await import(spec)) as {
    buildApp(opts: {
      cwd: string;
    }): Promise<{ manifest: ResolvedManifest; files: Partial<Record<ArtifactFile, string>> }>;
  };
  const build = await cli.buildApp({ cwd: join(opts.repoRoot, CONTROL_PLANE_DIR) });
  const deploymentId = newDeploymentId();
  const upload = async (file: ArtifactFile) => {
    const path = build.files[file];
    if (!path) return undefined;
    return engine.putArtifact(
      runtime,
      names.artifactKey(build.manifest.name, PROD_STAGE, deploymentId, file),
      readFileSync(path),
    );
  };
  const [server, worker, stat] = await Promise.all([
    upload('server.zip'),
    upload('worker.zip'),
    upload('static.zip'),
  ]);
  await upload('manifest.json');
  const result = await engine.deployStage({
    manifest: build.manifest,
    stage: PROD_STAGE,
    deploymentId,
    platform: runtime,
    artifacts: {
      ...(server ? { server } : {}),
      ...(worker ? { worker } : {}),
      ...(stat ? { static: stat } : {}),
    },
    roleArn: opts.roleArn,
    webMode: 'function',
    logRetentionDays: 30,
  });
  await registerControlPlane(opts.ctx, opts.config, runtime, build.manifest, deploymentId, result);
  return { ...result, deploymentId };
}

/**
 * Write the records the API would have written for a deploy, so the console
 * lists the `platform` app, the pinger checks it, and rollback has a previous
 * deployment to return to.
 */
async function registerControlPlane(
  ctx: EngineContext,
  config: PlatformConfig,
  runtime: PlatformRuntimeConfig,
  manifest: ResolvedManifest,
  deploymentId: string,
  result: DeployResult,
): Promise<void> {
  const ddb = DynamoDBDocumentClient.from(ctx.clients.dynamodb, {
    marshallOptions: { removeUndefinedValues: true },
  });
  const TableName = runtime.stateTable;
  const now = new Date().toISOString();
  const admins = config.members.filter((m) => m.role === 'admin').map((m) => m.github);
  const app = manifest.name;

  await ddb
    .send(
      new PutCommand({
        TableName,
        Item: appItem({
          name: app,
          repo: `${config.github.owner}/${config.github.repo}`,
          description: 'The platform control plane: console, API, deployer and telemetry.',
          owners: admins,
          createdBy: 'foundation',
          createdAt: now,
        }),
        ConditionExpression: 'attribute_not_exists(pk)',
      }),
    )
    .catch((err: { name?: string }) => {
      if (err.name !== 'ConditionalCheckFailedException') throw err;
    });

  const prev = (await ddb.send(new GetCommand({ TableName, Key: stageKey(app, PROD_STAGE) }))).Item as
    | StageItem
    | undefined;
  const revisionId = result.webFunction?.revisionId;
  await ddb.send(
    new PutCommand({
      TableName,
      Item: deploymentItem({
        id: deploymentId,
        app,
        stage: PROD_STAGE,
        status: 'succeeded',
        actor: 'foundation',
        manifest,
        url: result.url,
        events: [{ ts: Date.now(), level: 'info', msg: 'deployed by the foundation' }],
        createdAt: now,
        startedAt: now,
        finishedAt: now,
        ...(result.route ? { route: result.route } : {}),
        ...(revisionId ? { revisionId } : {}),
      }),
    }),
  );
  await ddb.send(
    new PutCommand({
      TableName,
      Item: stageItem({
        app,
        stage: PROD_STAGE,
        host: result.host,
        url: result.url,
        status: 'active',
        preview: false,
        currentDeployment: deploymentId,
        ...(prev?.currentDeployment ? { previousDeployment: prev.currentDeployment } : {}),
        ...(revisionId ? { currentRevision: revisionId } : {}),
        ...(prev?.currentRevision ? { previousRevision: prev.currentRevision } : {}),
        ...(result.route ? { route: result.route } : {}),
        ...(prev?.route ? { previousRoute: prev.route } : {}),
        createdAt: prev?.createdAt ?? now,
        updatedAt: now,
      }),
    }),
  );
}
