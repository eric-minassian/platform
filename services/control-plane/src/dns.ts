/**
 * Guard against creating an app whose hostname is already taken in the root
 * zone (a delegated subdomain or an explicit record beats the platform's `*`
 * wildcard, so such an app would never receive traffic).
 */
import { promises as dnsPromises } from 'node:dns';

export interface Resolver {
  resolveNs(host: string): Promise<string[]>;
  resolveCname(host: string): Promise<string[]>;
  resolve4(host: string): Promise<string[]>;
}

const NO_RECORD = new Set(['ENODATA', 'ENOTFOUND', 'NXDOMAIN']);

async function tryResolve(fn: () => Promise<string[]>): Promise<string[] | null> {
  try {
    return await fn();
  } catch (err) {
    if (NO_RECORD.has((err as { code?: string }).code ?? '')) return null;
    throw err;
  }
}

/**
 * Returns null when `host` is free (no records, or the wildcard CNAME to the
 * platform edge), otherwise a reason. DNS failures other than "no record"
 * are treated as free so an outage never blocks app creation.
 */
export async function hostConflict(
  host: string,
  edgeHost: string,
  resolver: Resolver = dnsPromises,
): Promise<string | null> {
  try {
    const ns = await tryResolve(() => resolver.resolveNs(host));
    if (ns?.length) return `${host} is delegated to other name servers`;
    const cname = await tryResolve(() => resolver.resolveCname(host));
    if (cname?.length) {
      const target = cname[0]!.replace(/\.$/, '').toLowerCase();
      return target === edgeHost.toLowerCase() ? null : `${host} already points at ${target}`;
    }
    const a = await tryResolve(() => resolver.resolve4(host));
    if (a?.length) return `${host} already has an A record`;
    return null;
  } catch {
    return null;
  }
}
