import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type {
  ArtifactFile,
  DeploymentEventEntry,
  DeploymentRecord,
  DeploymentStatus,
  ManifestInput,
  PresignedPost,
} from '@ericminassian/platform-core';
import pc from 'picocolors';
import type { ApiClient } from './api.ts';
import { buildApp } from './build.ts';
import { type EdgeChecks, edgeChecksFor, hasEdgeChecks, waitForEdge } from './edge.ts';
import { appendStepSummary, deriveStage, gitInfo, isGitHubActions, setOutput } from './github.ts';
import { loadProject } from './project.ts';
import { CliError, EXIT, info, step, success } from './util/output.ts';

export const TERMINAL_STATUSES: readonly DeploymentStatus[] = ['succeeded', 'failed', 'rolled_back'];

export interface DeployOptions {
  cwd: string;
  stage?: string;
  wait: boolean;
  timeoutMs?: number;
  pollMs?: number;
  /** How long to wait for this machine's nearest edge to serve the deployment. */
  edgeTimeoutMs?: number;
}

export interface DeployResult {
  deployment: DeploymentRecord;
  url?: string;
}

export async function deploy(api: ApiClient, opts: DeployOptions): Promise<DeployResult> {
  const project = await loadProject(opts.cwd);
  const stage = deriveStage(opts.stage);
  const app = project.manifest.name;

  const { files } = await buildApp({ cwd: project.root, project });
  // The API always issues an upload for manifest.json; `files` lists the optional bundles.
  const fileNames = (Object.keys(files) as ArtifactFile[]).filter((f) => f !== 'manifest.json');
  const git = gitInfo(project.root);

  step(`creating deployment of ${pc.bold(app)} to ${pc.bold(stage)}`);
  const created = await api.createDeployment(app, {
    stage,
    manifest: project.raw as ManifestInput,
    files: fileNames,
    ...git,
  });
  const id = created.deployment.id;
  const edge = edgeChecksFor({
    root: project.root,
    manifest: project.manifest,
    stage,
    deploymentId: id,
    hasStatic: !!files['static.zip'],
  });

  for (const name of Object.keys(files) as ArtifactFile[]) {
    const post = created.uploads[name];
    if (!post) throw new CliError(`the API did not return an upload URL for ${name}`);
    step(`uploading ${name}`);
    await uploadPresignedPost(post, files[name]!, name);
  }

  step('starting deployment');
  let deployment = await api.startDeployment(id);
  if (!opts.wait) {
    info(`deployment ${id} is ${deployment.status}; follow with \`plat deployments --stage ${stage}\``);
    return { deployment, url: deployment.url };
  }

  deployment = await waitForDeployment(api, id, {
    timeoutMs: opts.timeoutMs ?? 15 * 60_000,
    pollMs: opts.pollMs ?? 2_000,
    onEvent: printEvent,
  });
  if (deployment.status !== 'succeeded') {
    throw new CliError(
      `deployment ${id} ${deployment.status}${deployment.error ? `: ${deployment.error}` : ''}`,
      {
        hint: `see \`plat logs --stage ${stage}\` and the events above`,
        exitCode: EXIT.deployFailed,
      },
    );
  }
  const url = deployment.url;
  if (url) await waitUntilServedHere(url, id, edge, opts.edgeTimeoutMs ?? 60_000);
  success(`deployed ${app} to ${stage}${url ? `: ${pc.underline(url)}` : ''}`);
  if (isGitHubActions()) {
    if (url) setOutput('url', url);
    setOutput('deployment', id);
    appendStepSummary(
      `### Deployed \`${app}\` → \`${stage}\`\n\n${url ? `**URL:** ${url}\n\n` : ''}Deployment \`${id}\`${git.commit ? ` at \`${git.commit.slice(0, 7)}\`` : ''}`,
    );
  }
  return { deployment, url };
}

/**
 * The API reports success once the edge nearest the control plane serves the
 * deployment; return only once the edge nearest this machine does too.
 */
async function waitUntilServedHere(
  url: string,
  id: string,
  checks: EdgeChecks,
  timeoutMs: number,
): Promise<void> {
  if (!hasEdgeChecks(checks)) return;
  step(`waiting for ${url} to serve ${id} to this machine`);
  const r = await waitForEdge(url, id, checks, { timeoutMs });
  if (!r.ok) {
    throw new CliError(
      `deployment ${id} is live, but ${url} did not serve it to this machine within ${Math.round(r.ms / 1000)}s`,
      { hint: `last seen: ${r.pending.join('; ')}`, exitCode: EXIT.deployFailed },
    );
  }
  info(`  ${pc.dim(`served to this machine after ${(r.ms / 1000).toFixed(1)}s`)}`);
}

/** Builds the multipart body for an S3 presigned POST (policy fields first, file last). */
export function presignedPostForm(post: PresignedPost, data: Uint8Array, filename: string): FormData {
  const form = new FormData();
  for (const [k, v] of Object.entries(post.fields)) form.append(k, v);
  form.append('file', new Blob([new Uint8Array(data)]), filename);
  return form;
}

export async function uploadPresignedPost(post: PresignedPost, path: string, name: string): Promise<void> {
  const data = readFileSync(path);
  const res = await fetch(post.url, { method: 'POST', body: presignedPostForm(post, data, basename(name)) });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new CliError(`upload of ${name} failed (HTTP ${res.status})`, {
      hint: text.slice(0, 300) || undefined,
    });
  }
}

export async function waitForDeployment(
  api: ApiClient,
  id: string,
  opts: { timeoutMs: number; pollMs: number; onEvent?: (e: DeploymentEventEntry) => void },
): Promise<DeploymentRecord> {
  const deadline = Date.now() + opts.timeoutMs;
  let seen = 0;
  for (;;) {
    const d = await api.getDeployment(id);
    const events = d.events ?? [];
    for (const e of events.slice(seen)) opts.onEvent?.(e);
    seen = Math.max(seen, events.length);
    if (TERMINAL_STATUSES.includes(d.status)) return d;
    if (Date.now() > deadline) {
      throw new CliError(`timed out waiting for deployment ${id} (status ${d.status})`, {
        exitCode: EXIT.deployFailed,
      });
    }
    await new Promise((r) => setTimeout(r, opts.pollMs));
  }
}

function printEvent(e: DeploymentEventEntry): void {
  const color = e.level === 'error' ? pc.red : e.level === 'warn' ? pc.yellow : pc.dim;
  info(
    `  ${color(new Date(e.ts).toISOString().slice(11, 19))} ${e.msg}${e.resource ? pc.dim(` (${e.resource})`) : ''}`,
  );
}
