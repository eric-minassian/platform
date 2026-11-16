/**
 * Stable short hashes (FNV-1a 32-bit): no crypto dependency so the SDK stays
 * tiny. Their own module so naming (and the `./naming` subpath) doesn't pull
 * in Effect through telemetry.
 */

/** FNV-1a of `s`'s code points, as an unsigned 32-bit integer. */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (const ch of s) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** `fnv1a` of the parts joined with `|`, as 8 hex digits. */
export function fingerprint(parts: readonly string[]): string {
  return fnv1a(parts.join('|')).toString(16).padStart(8, '0');
}
