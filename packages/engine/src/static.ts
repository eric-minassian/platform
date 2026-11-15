/** Content types for static assets served from the sites bucket. */
const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  cjs: 'text/javascript; charset=utf-8',
  map: 'application/json; charset=utf-8',
  json: 'application/json; charset=utf-8',
  webmanifest: 'application/manifest+json',
  txt: 'text/plain; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  wasm: 'application/wasm',
  pdf: 'application/pdf',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
};

export function contentTypeFor(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return TYPES[ext] ?? 'application/octet-stream';
}

export const IMMUTABLE = 'public, max-age=31536000, immutable';
export const REVALIDATE = 'public, max-age=0, must-revalidate';

/**
 * Hashed build output (Vite puts it under `assets/`, or any file with an 8+
 * char content hash in its name) never changes, so the edge caches it for a
 * year. Everything else (index.html, robots.txt, ...) revalidates.
 */
export function cacheControlFor(path: string): string {
  const p = path.replace(/^\/+/, '');
  if (p.startsWith('assets/')) return IMMUTABLE;
  const file = p.slice(p.lastIndexOf('/') + 1);
  // A content hash has a digit or capital letter; plain words like `-component.js` don't.
  if (/[.-](?=[A-Za-z0-9_]*[A-Z0-9])[A-Za-z0-9_]{8,}\.[a-z0-9]+$/.test(file) && !/\.html?$/.test(file)) {
    return IMMUTABLE;
  }
  return REVALIDATE;
}
