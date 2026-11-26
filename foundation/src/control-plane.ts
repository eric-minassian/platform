import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  appItem,
  appKey,
  deploymentItem,
  type StageItem,
  stageCompute,
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
  RepoVisibility,
  type ResolvedManifest,
  webComputeFor,
} from '@ericminassian/platform-core';
import type { Engine, EngineContext } from '@ericminassian/platform-engine';

export const CONTROL_PLANE_DIR = 'services/control-plane';

const isRepoVisibility = (v: unknown): v is RepoVisibility =>
  (RepoVisibility.literals as readonly unknown[]).includes(v);

/**
 * The repository's visibility in a GitHub Actions event payload
 * (`GITHUB_EVENT_PATH`). An app's CI deploy records it from its OIDC token
 * through the API, which the control plane's own deploy doesn't go through,
 * so the public directory would never link the platform's repo otherwise.
 */
export function repoVisibilityOf(event: unknown): RepoVisibility | undefined {
  const repository =
    typeof event === 'object' && event !== null ? (event as { repository?: unknown }).repository : undefined;
  const visibility =
    typeof repository === 'object' && repository !== null
      ? (repository as { visibility?: unknown }).visibility
      : undefined;
  return isRepoVisibility(visibility) ? visibility : undefined;
}

/** The visibility of the repository this deploy runs from in GitHub Actions; none when run by hand. */
function actionsRepoVisibility(): RepoVisibility | undefined {
  const path = process.env.GITHUB_EVENT_PATH;
  if (!path) return undefined;
  try {
    return repoVisibilityOf(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return undefined;
  }
}

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
  const prev = await getStage(opts.ctx, runtime, build.manifest.name);
  // The control plane builds with the workspace's SDK.
  const sdk = (
    JSON.parse(readFileSync(join(opts.repoRoot, 'packages/sdk/package.json'), 'utf8')) as { version: string }
  ).version;
  const choice = webComputeFor({
    setting: build.manifest.web?.compute ?? 'auto',
    stage: PROD_STAGE,
    current: prev ? stageCompute(prev) : undefined,
    sdk,
  });
  if ('error' in choice) throw new Error(choice.error);
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
    webCompute: choice.compute,
    logRetentionDays: 30,
  });
  await registerControlPlane(opts.ctx, opts.config, runtime, build.manifest, deploymentId, result, {
    sdk,
    ...(prev ? { prev } : {}),
  });
  return { ...result, deploymentId };
}

const documentClient = (ctx: EngineContext) =>
  DynamoDBDocumentClient.from(ctx.clients.dynamodb, { marshallOptions: { removeUndefinedValues: true } });

async function getStage(ctx: EngineContext, runtime: PlatformRuntimeConfig, app: string) {
  const res = await documentClient(ctx).send(
    new GetCommand({ TableName: runtime.stateTable, Key: stageKey(app, PROD_STAGE) }),
  );
  return res.Item as StageItem | undefined;
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
  build: { sdk: string; prev?: StageItem },
): Promise<void> {
  const ddb = documentClient(ctx);
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
  const repoVisibility = actionsRepoVisibility();
  if (repoVisibility) {
    await ddb.send(
      new UpdateCommand({
        TableName,
        Key: appKey(app),
        UpdateExpression: 'SET repoVisibility = :v',
        ExpressionAttributeValues: { ':v': repoVisibility },
      }),
    );
  }

  const { prev } = build;
  const revisionId = result.webFunction?.revisionId;
  const version = result.requestFunction?.version;
  // The chooser's estimate stays; its count toward a switch starts over in a new mode.
  const sameMode = prev !== undefined && stageCompute(prev) === result.compute;
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
        sdk: build.sdk,
        ...(result.compute ? { compute: result.compute } : {}),
        ...(result.route ? { route: result.route } : {}),
        ...(revisionId ? { revisionId } : {}),
        ...(version ? { version } : {}),
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
        ...((revisionId ?? version) ? { currentRevision: revisionId ?? version } : {}),
        ...(prev?.currentRevision ? { previousRevision: prev.currentRevision } : {}),
        ...(result.compute ? { compute: result.compute } : {}),
        ...(prev?.computeEstimate ? { computeEstimate: prev.computeEstimate } : {}),
        ...(sameMode && prev?.computeStreak ? { computeStreak: prev.computeStreak } : {}),
        ...(result.route ? { route: result.route } : {}),
        ...(prev?.route ? { previousRoute: prev.route } : {}),
        createdAt: prev?.createdAt ?? now,
        updatedAt: now,
      }),
    }),
  );
}
