/**
 * File stores (`storage` in `plat.config.ts`). Every stage's stores share the
 * platform's storage bucket:
 *
 * - a private store is `<app>/<stage>/<store>/` (`names.storagePrefix`);
 *   browsers reach its files only through presigned URLs;
 * - a public store is `_public/<app>/<stage>/<store>/`, which the edge serves
 *   at `/__platform/storage/<store>/<key>` on the app's own host. The router
 *   distribution may read `_public/*` and nothing else, so a routing mistake
 *   can't expose a private store. `_` can't start an app name, so no app's
 *   prefix collides with it.
 *
 * Isomorphic: the SDK, its browser client, the CLI and the engine share it.
 */

/** Where the edge serves public stores on every app host: `/__platform/storage/<store>/<key>`. */
export const STORAGE_PATH = '/__platform/storage/';

/** Top-level prefix of public stores in the storage bucket. */
export const PUBLIC_STORAGE_ROOT = '_public/';

/**
 * Headers the edge adds to every public-store response (the router
 * distribution's response headers policy; `plat dev` sends the same).
 * `script-src 'none'` keeps an uploaded HTML or SVG file from running script
 * on the app's origin, where its session cookie lives (`sandbox` would also
 * stop PDFs from opening in Chrome).
 */
export const STORAGE_RESPONSE_HEADERS = {
  'x-content-type-options': 'nosniff',
  'content-security-policy': "script-src 'none'",
} as const;

/**
 * The router's `x-platform-host` for a public store's file, in place of the
 * host. CloudFront's cache key is the rewritten URI plus that header, not the
 * behavior or origin, and an app's server could be asked for the same path
 * (`/<app>/<stage>/<store>/<key>`) on the app's host: with the host in both,
 * its response would be served for the file, and the file for that path. No
 * routed host has this value.
 */
export const STORAGE_CACHE_HOST = '__storage';

/** `Cache-Control` the edge adds to a public file that carries none: browsers revalidate it. */
export const STORAGE_DEFAULT_CACHE_CONTROL = 'no-cache';

/**
 * Whether the edge serves `key` (as it appears in a URL path, so still
 * percent-encoded): not empty, and without `.` or `..` segments. S3 decodes
 * the key once, so `%2e` counts as a dot and `%2f` as a slash. The router
 * inlines the same check (`router/decide.js`).
 */
export function isServableKey(key: string): boolean {
  if (!key) return false;
  return key
    .replace(/%2e/gi, '.')
    .replace(/%2f/gi, '/')
    .split('/')
    .every((part) => part !== '.' && part !== '..');
}

/**
 * The path the edge serves a public store's file at, with each key segment
 * percent-encoded: `storagePath('snapshots', 'fires/today 1.json')` →
 * `/__platform/storage/snapshots/fires/today%201.json`.
 */
export function storagePath(store: string, key: string): string {
  const k = key.replace(/^\/+/, '');
  const path = k.split('/').map(encodeURIComponent).join('/');
  if (!isServableKey(path)) throw new Error(`Storage key "${key}" can't be served from the edge`);
  return `${STORAGE_PATH}${store}/${path}`;
}

/** Content types by file extension: static files, and store files put without one. */
const CONTENT_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  cjs: 'text/javascript; charset=utf-8',
  map: 'application/json; charset=utf-8',
  json: 'application/json; charset=utf-8',
  geojson: 'application/geo+json',
  ndjson: 'application/x-ndjson',
  webmanifest: 'application/manifest+json',
  txt: 'text/plain; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
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
  zip: 'application/zip',
  gz: 'application/gzip',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
};

/** The content type for a file name (or key), `application/octet-stream` when the extension is unknown. */
export function contentTypeFor(path: string): string {
  const file = path.slice(path.lastIndexOf('/') + 1);
  const dot = file.lastIndexOf('.');
  return (
    (dot === -1 ? undefined : CONTENT_TYPES[file.slice(dot + 1).toLowerCase()]) ?? 'application/octet-stream'
  );
}
