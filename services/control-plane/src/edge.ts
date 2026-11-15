/**
 * After the route flip, CloudFront edges pick up the new KeyValueStore entry
 * within seconds, not instantly. A deployment is reported live only once the
 * public URL serves it to the control plane. Edges near other viewers can lag
 * a few seconds more, so `plat deploy` repeats the check from the machine it
 * runs on (`packages/cli/src/edge.ts`) before it returns.
 */
import { HEALTH_PATH } from '@ericminassian/platform-core';

export async function waitForEdge(
  url: string,
  deploymentId: string,
  opts: { timeoutMs?: number; intervalMs?: number; fetch?: typeof fetch } = {},
): Promise<boolean> {
  const doFetch = opts.fetch ?? fetch;
  const deadline = Date.now() + (opts.timeoutMs ?? 90_000);
  for (;;) {
    try {
      const res = await doFetch(`${url}${HEALTH_PATH}`, {
        signal: AbortSignal.timeout(10_000),
        headers: { 'cache-control': 'no-cache' },
      });
      if (res.ok) {
        const body = (await res.json()) as { revision?: string };
        if (body.revision === deploymentId) return true;
      } else {
        await res.body?.cancel();
      }
    } catch {
      // DNS, TLS or edge errors while propagating: keep polling until the deadline.
    }
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, opts.intervalMs ?? 3_000));
  }
}
