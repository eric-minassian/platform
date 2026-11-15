/**
 * The control plane calls a deployment live once the CloudFront edge nearest
 * to it serves the new route. Other edge locations read the KeyValueStore
 * change seconds later, so `plat deploy` waits until the edge nearest to this
 * machine serves it too. Whatever runs next (smoke or e2e checks in CI) then
 * tests the new version, not the previous one.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { decide, HEALTH_PATH, type ResolvedManifest } from '@ericminassian/platform-core';
import pc from 'picocolors';
import { localRouteRecord } from './dev/router.ts';
import { CliError, EXIT, info, step } from './util/output.ts';

export const INDEX_PATH = '/index.html';

/** What this machine can request to tell the new deployment from the previous one. */
export interface EdgeChecks {
  /** The server reports the deployment id as `revision` at `/__platform/health`. */
  health: boolean;
  /** The built `index.html`; the edge must serve exactly these bytes at `/index.html`. */
  indexHtml?: Buffer;
}

/** Picks the checks the new route record supports, from the manifest and what was built. */
export function edgeChecksFor(opts: {
  root: string;
  manifest: ResolvedManifest;
  stage: string;
  deploymentId: string;
  /** `static.zip` is part of this deployment. */
  hasStatic: boolean;
}): EdgeChecks {
  const { manifest } = opts;
  const record = localRouteRecord({
    app: manifest.name,
    stage: opts.stage,
    deploymentId: opts.deploymentId,
    hasServer: !!manifest.web?.server,
    hasStatic: opts.hasStatic,
    serverRoutes: [...(manifest.web?.serverRoutes ?? ['/api/'])],
    spa: manifest.web?.spa ?? true,
  });
  // The server answers health; for a stage without one, the edge router does.
  const health = decide(record, HEALTH_PATH).t !== 'notfound';
  // `serverRoutes` can claim `/index.html` for the server; only a static answer is the built file.
  const index =
    opts.hasStatic && manifest.web?.static && decide(record, INDEX_PATH).t === 'static'
      ? join(resolve(opts.root, manifest.web.static), 'index.html')
      : undefined;
  return { health, ...(index && existsSync(index) ? { indexHtml: readFileSync(index) } : {}) };
}

export function hasEdgeChecks(checks: EdgeChecks): boolean {
  return checks.health || checks.indexHtml !== undefined;
}

export interface EdgeWaitResult {
  ok: boolean;
  /** Time from the first request until every check passed (or the deadline). */
  ms: number;
  /** What each check that never passed saw last, e.g. `/__platform/health → revision d01…`. */
  pending: string[];
}

/**
 * The platform reports a deployment live once the edge nearest the control
 * plane serves it; return only once the edge nearest this machine does too.
 * Throws after `timeoutMs`.
 */
export async function confirmServedHere(
  url: string,
  deploymentId: string,
  checks: EdgeChecks,
  opts: { timeoutMs?: number; fetch?: typeof fetch } = {},
): Promise<void> {
  if (!hasEdgeChecks(checks)) return;
  step(`waiting for ${url} to serve ${deploymentId} to this machine`);
  const r = await waitForEdge(url, deploymentId, checks, opts);
  if (!r.ok) {
    throw new CliError(
      `the platform reports ${deploymentId} live, but ${url} did not serve it to this machine within ${Math.round(r.ms / 1000)}s`,
      { hint: `last seen: ${r.pending.join('; ')}`, exitCode: EXIT.deployFailed },
    );
  }
  info(`  ${pc.dim(`served to this machine after ${(r.ms / 1000).toFixed(1)}s`)}`);
}

/** Polls `url` until every check sees `deploymentId`, or `timeoutMs` passes. */
export async function waitForEdge(
  url: string,
  deploymentId: string,
  checks: EdgeChecks,
  opts: { timeoutMs?: number; intervalMs?: number; fetch?: typeof fetch } = {},
): Promise<EdgeWaitResult> {
  const doFetch = opts.fetch ?? fetch;
  const start = performance.now();
  const deadline = start + (opts.timeoutMs ?? 60_000);
  const get = (path: string) =>
    doFetch(new URL(path, url), {
      headers: { 'cache-control': 'no-cache' },
      signal: AbortSignal.timeout(Math.max(1_000, Math.min(10_000, deadline - performance.now()))),
    });

  // Each probe returns undefined once it sees this deployment, else what it saw instead.
  type Probe = () => Promise<string | undefined>;
  const probes = new Map<string, Probe>();
  if (checks.health) {
    probes.set(HEALTH_PATH, async () => {
      const res = await get(HEALTH_PATH);
      if (!res.ok) return `HTTP ${await discard(res)}`;
      const body = (await res.json().catch(() => undefined)) as { revision?: unknown } | undefined;
      if (body?.revision === deploymentId) return undefined;
      return typeof body?.revision === 'string' ? `revision ${body.revision}` : 'no revision';
    });
  }
  const expected = checks.indexHtml;
  if (expected) {
    probes.set(INDEX_PATH, async () => {
      const res = await get(INDEX_PATH);
      if (!res.ok) return `HTTP ${await discard(res)}`;
      return expected.equals(new Uint8Array(await res.arrayBuffer())) ? undefined : 'not this build';
    });
  }

  const last = new Map<string, string>();
  for (;;) {
    const seen = await Promise.all(
      [...probes].map(async ([path, probe]) => [path, await probe().catch(describeFetchError)] as const),
    );
    for (const [path, saw] of seen) {
      if (saw === undefined) probes.delete(path);
      else last.set(path, saw);
    }
    const now = performance.now();
    if (probes.size === 0) return { ok: true, ms: now - start, pending: [] };
    if (now >= deadline) {
      return { ok: false, ms: now - start, pending: [...probes.keys()].map((p) => `${p} → ${last.get(p)}`) };
    }
    await new Promise((r) => setTimeout(r, Math.min(opts.intervalMs ?? 1_000, deadline - now)));
  }
}

async function discard(res: Response): Promise<number> {
  await res.body?.cancel();
  return res.status;
}

// DNS, TLS and connection errors while a new hostname propagates: keep polling until the deadline.
function describeFetchError(err: unknown): string {
  const cause = err instanceof Error ? err.cause : undefined;
  if (cause instanceof Error) return cause.message;
  return err instanceof Error ? err.message : String(err);
}
