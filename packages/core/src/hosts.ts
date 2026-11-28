/**
 * Hosts the platform serves beyond `<app>[--<stage>].<domain>`: `hosts` in
 * platform.config.ts. Each is one route-store entry the platform's deploy
 * writes. An alias names the app's own prod host, whose route record the
 * router reads in its place, so the app's deploys and rollbacks never touch
 * it; a redirect is answered at the edge.
 */
import { PROD_STAGE } from './constants.ts';
import { APP_NAME_PATTERN, parseStageHost, stageHost } from './naming.ts';

/** What a host in `hosts` does: serve an app's prod stage, or redirect to another host. */
export type HostTarget = { readonly app: string } | { readonly redirect: string };

export type Hosts = Readonly<Record<string, HostTarget>>;

/**
 * An alias's (`a`: the app's own host) or a redirect's (`x`: the host to send
 * visitors to, path and query kept) entry in the route store. Neither has the
 * route record's `app`, so the two can't be mistaken for each other.
 */
export type HostRecord = { readonly v: 1; readonly a: string } | { readonly v: 1; readonly x: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

export function isHostRecord(v: unknown): v is HostRecord {
  return isObject(v) && v.v === 1 && (typeof v.a === 'string' || typeof v.x === 'string') && !('app' in v);
}

/** The route-store entry for each host in `hosts`. */
export function hostRecords(hosts: Hosts | undefined, domain: string): Record<string, HostRecord> {
  return Object.fromEntries(
    Object.entries(hosts ?? {}).map(([host, t]): [string, HostRecord] => [
      host,
      'app' in t ? { v: 1, a: stageHost(t.app, PROD_STAGE, domain) } : { v: 1, x: t.redirect },
    ]),
  );
}

/** The hosts that serve `app`'s prod stage, in config order: the first is its public URL's. */
export function hostsOf(hosts: Hosts | undefined, app: string): string[] {
  return Object.entries(hosts ?? {}).flatMap(([host, t]) => ('app' in t && t.app === app ? [host] : []));
}

/**
 * The stage a host's traffic belongs to: its own (`parseStageHost`), the app
 * an alias serves, or for a redirect, whatever its target belongs to.
 */
export function resolveHost(
  host: string,
  domain: string,
  hosts: Hosts | undefined,
): { app: string; stage: string } | null {
  const h = host.toLowerCase().replace(/:\d+$/, '');
  const t = hosts?.[h];
  if (!t) return parseStageHost(h, domain);
  if ('app' in t) return { app: t.app, stage: PROD_STAGE };
  const target = hosts[t.redirect];
  if (target) return 'app' in target ? { app: target.app, stage: PROD_STAGE } : null;
  return parseStageHost(t.redirect, domain);
}

/**
 * The labels `hosts` uses under the domain: no app may take one, since the
 * host's entry would shadow the app's own.
 */
export function hostLabels(hosts: Hosts | undefined, domain: string): string[] {
  const suffix = `.${domain}`;
  return Object.keys(hosts ?? {}).flatMap((h) => (h.endsWith(suffix) ? [h.slice(0, -suffix.length)] : []));
}

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * The problems with `hosts`, for `definePlatformConfig`. A host must be the
 * domain itself or one label under it: the names the edge certificate
 * (`*.<domain>`, plus the apex when a host is the apex) covers. `--` would
 * read as a stage, and a label in `reserved` already has a record of its own
 * in the root zone, which would win over the edge.
 */
export function hostsErrors(hosts: Hosts, domain: string, reserved: readonly string[]): string[] {
  const errors: string[] = [];
  const suffix = `.${domain}`;
  const labelOf = (host: string) => (host === domain ? '' : host.slice(0, -suffix.length));
  const isOurs = (host: string) =>
    host === domain || (host.endsWith(suffix) && LABEL.test(labelOf(host)) && !labelOf(host).includes('--'));
  for (const [host, t] of Object.entries(hosts)) {
    if (!isOurs(host)) {
      errors.push(`hosts: "${host}" must be ${domain} or one lowercase label under it, without "--"`);
      continue;
    }
    if (reserved.includes(labelOf(host)))
      errors.push(`hosts: "${host}" is in reservedAppNames, so the root zone answers it, not the edge`);
    if ('app' in t) {
      if (!APP_NAME_PATTERN.test(t.app))
        errors.push(`hosts: "${host}" names "${t.app}", which isn't an app name`);
    } else if (t.redirect === host) {
      errors.push(`hosts: "${host}" redirects to itself`);
    } else if (!isOurs(t.redirect)) {
      errors.push(
        `hosts: "${host}" redirects to "${t.redirect}", which must be ${domain} or one label under it`,
      );
    } else if (hosts[t.redirect] && !('app' in hosts[t.redirect]!)) {
      errors.push(`hosts: "${host}" redirects to "${t.redirect}", which redirects again`);
    }
  }
  return errors;
}
