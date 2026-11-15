/**
 * Stable short hash (FNV-1a 32-bit, hex): no crypto dependency so the SDK
 * stays tiny. Its own module so naming (and the `./naming` subpath) doesn't
 * pull in Effect through telemetry.
 */
export function fingerprint(parts: readonly string[]): string {
  let h = 0x811c9dc5;
  for (const ch of parts.join('|')) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
