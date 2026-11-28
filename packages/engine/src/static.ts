// Shared with store files put without a content type.
export { contentTypeFor } from '@ericminassian/platform-core';

export const IMMUTABLE = 'public, max-age=31536000, immutable';
export const REVALIDATE = 'public, max-age=0, must-revalidate';

/**
 * Hashed build output (Vite puts it under `assets/`, Astro under `_astro/`,
 * or any file with an 8+ char content hash in its name) never changes, so the
 * edge caches it for a year. Everything else (index.html, robots.txt, ...)
 * revalidates.
 */
export function cacheControlFor(path: string): string {
  const p = path.replace(/^\/+/, '');
  if (p.startsWith('assets/') || p.startsWith('_astro/')) return IMMUTABLE;
  const file = p.slice(p.lastIndexOf('/') + 1);
  // A content hash has a digit or capital letter; plain words like `-component.js` don't.
  if (/[.-](?=[A-Za-z0-9_]*[A-Z0-9])[A-Za-z0-9_]{8,}\.[a-z0-9]+$/.test(file) && !/\.html?$/.test(file)) {
    return IMMUTABLE;
  }
  return REVALIDATE;
}
