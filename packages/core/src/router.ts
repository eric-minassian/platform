export type { RouteDecision } from './router/decide.js';
export { decide } from './router/decide.js';

/**
 * Value stored in the CloudFront KeyValueStore under the public hostname.
 * Keys are short because KVS values are capped at 1 KB.
 */
export interface RouteRecord {
  v: 1;
  app: string;
  stage: string;
  /** Deployment id currently live. */
  d: string;
  /** Web Function endpoint domain. */
  o?: string;
  /** Static prefix in the sites bucket (no leading slash). */
  s?: string;
  /** Server route prefixes (only meaningful when both `o` and `s` exist). */
  r?: readonly string[];
  spa?: 0 | 1;
}

export function encodeRouteRecord(rec: RouteRecord): string {
  const json = JSON.stringify(rec);
  if (new TextEncoder().encode(json).length > 1024)
    throw new Error(`route record for ${rec.app}/${rec.stage} exceeds 1 KB`);
  return json;
}
