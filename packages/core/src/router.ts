import { Schema } from 'effect';

export type { RouteDecision } from './router/decide.js';
export { decide } from './router/decide.js';

/**
 * Value stored in the CloudFront KeyValueStore under the public hostname, and
 * kept with each deployment for rollbacks. Keys are short because KVS values
 * are capped at 1 KB.
 */
export const RouteRecordSchema = Schema.Struct({
  v: Schema.Literal(1),
  app: Schema.String,
  stage: Schema.String,
  /** Deployment id currently live. */
  d: Schema.String,
  /** Web Function endpoint domain. */
  o: Schema.optional(Schema.String),
  /** Static prefix in the sites bucket (no leading slash). */
  s: Schema.optional(Schema.String),
  /** Server route prefixes (only meaningful when both `o` and `s` exist). */
  r: Schema.optional(Schema.Array(Schema.String)),
  spa: Schema.optional(Schema.Literals([0, 1])),
  /**
   * Realtime (`plat.config.ts` `realtime`): the stage's channel namespace and
   * who subscribes (`p` public with the API key, `s` signed-in with a token).
   * The router answers `REALTIME_PATH` only for records that have it.
   */
  rt: Schema.optional(Schema.Struct({ n: Schema.String, m: Schema.Literals(['p', 's']) })),
  /** Public stores, which the router serves from the storage bucket at `STORAGE_PATH`. */
  p: Schema.optional(Schema.Array(Schema.String)),
});
export type RouteRecord = typeof RouteRecordSchema.Type;

export function encodeRouteRecord(rec: RouteRecord): string {
  const json = JSON.stringify(rec);
  if (new TextEncoder().encode(json).length > 1024)
    throw new Error(`route record for ${rec.app}/${rec.stage} exceeds 1 KB`);
  return json;
}
