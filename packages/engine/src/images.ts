/**
 * OCI image assembly without Docker: a layer is a deterministic tarball of
 * files, an image is a base image's layers plus that layer, described by a
 * config and a manifest. Pure functions; the registry calls live in
 * `drivers/ecr.ts`.
 *
 * Determinism matters: the same files on the same base give byte-identical
 * blobs, so redeploying unchanged code pushes nothing new and the image
 * digest says whether a build changed.
 */

import { createHash } from 'node:crypto';
import { gzipSync } from 'fflate';

export const MEDIA_TYPES = {
  ociManifest: 'application/vnd.oci.image.manifest.v1+json',
  ociIndex: 'application/vnd.oci.image.index.v1+json',
  ociConfig: 'application/vnd.oci.image.config.v1+json',
  ociLayerGzip: 'application/vnd.oci.image.layer.v1.tar+gzip',
  dockerManifest: 'application/vnd.docker.distribution.manifest.v2+json',
  dockerManifestList: 'application/vnd.docker.distribution.manifest.list.v2+json',
} as const;

/** Single-platform manifest types a base image may have. */
export const IMAGE_MANIFEST_TYPES: readonly string[] = [MEDIA_TYPES.ociManifest, MEDIA_TYPES.dockerManifest];

export interface Descriptor {
  mediaType: string;
  digest: string;
  size: number;
  annotations?: Record<string, string>;
}

export interface ImageManifest {
  schemaVersion: 2;
  mediaType?: string;
  config: Descriptor;
  layers: Descriptor[];
  annotations?: Record<string, string>;
}

/** The parts of an OCI image config the platform reads or writes; the rest passes through. */
export interface ImageConfig {
  architecture: string;
  os: string;
  created?: string;
  config?: {
    Env?: string[];
    Entrypoint?: string[] | null;
    Cmd?: string[] | null;
    WorkingDir?: string;
    User?: string;
    [key: string]: unknown;
  };
  rootfs: { type: 'layers'; diff_ids: string[] };
  history?: Array<{ created?: string; created_by?: string; comment?: string; empty_layer?: boolean }>;
  [key: string]: unknown;
}

export interface ImageFile {
  /** Absolute path inside the image (`/app/index.mjs`). */
  path: string;
  content: Uint8Array;
  /** Default 0o644. */
  mode?: number;
}

export interface Layer {
  /** The gzipped tarball as pushed. */
  blob: Uint8Array;
  /** sha256 of `blob`: the layer's digest in the manifest. */
  digest: string;
  /** sha256 of the uncompressed tarball: the layer's entry in the config's `rootfs.diff_ids`. */
  diffId: string;
  size: number;
}

export function sha256Digest(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/**
 * A ustar archive of `files` plus an entry for every parent directory,
 * sorted by path, owned by root with mtime 0, so equal input gives equal
 * bytes.
 */
export function tarFiles(files: readonly ImageFile[]): Uint8Array {
  const entries = new Map<string, { type: 'dir' } | { type: 'file'; content: Uint8Array; mode: number }>();
  for (const f of files) {
    const rel = normalizePath(f.path);
    const parts = rel.split('/');
    for (let i = 1; i < parts.length; i++) entries.set(`${parts.slice(0, i).join('/')}/`, { type: 'dir' });
    if (entries.has(rel)) throw new Error(`duplicate file in layer: ${f.path}`);
    entries.set(rel, { type: 'file', content: f.content, mode: f.mode ?? 0o644 });
  }
  const blocks: Uint8Array[] = [];
  for (const name of [...entries.keys()].toSorted()) {
    const e = entries.get(name)!;
    if (e.type === 'dir') {
      blocks.push(tarHeader({ name, mode: 0o755, size: 0, type: '5' }));
    } else {
      blocks.push(tarHeader({ name, mode: e.mode, size: e.content.length, type: '0' }), e.content);
      const pad = (512 - (e.content.length % 512)) % 512;
      if (pad) blocks.push(new Uint8Array(pad));
    }
  }
  blocks.push(new Uint8Array(1024));
  return concat(blocks);
}

/** A gzipped layer of `files` with its digests. */
export function buildLayer(files: readonly ImageFile[]): Layer {
  const tar = tarFiles(files);
  // mtime 0 keeps the gzip header (and so the digest) stable.
  const blob = gzipSync(tar, { level: 9, mtime: 0 });
  return { blob, digest: sha256Digest(blob), diffId: sha256Digest(tar), size: blob.length };
}

export interface ImageConfigSpec {
  entrypoint: string[];
  /** Replaces the base image's Cmd; none when omitted (the base's would be appended to the entrypoint). */
  cmd?: string[];
  /** Merged over the base image's environment. */
  env?: Record<string, string>;
  workingDir?: string;
  user?: string;
  /** History line for the added layer. */
  createdBy?: string;
}

/** The base image's config with `layer` on top and the process settings of `spec`. */
export function imageConfig(base: ImageConfig, layer: Layer, spec: ImageConfigSpec): ImageConfig {
  const env = new Map<string, string>();
  for (const kv of base.config?.Env ?? []) {
    const i = kv.indexOf('=');
    env.set(i === -1 ? kv : kv.slice(0, i), i === -1 ? '' : kv.slice(i + 1));
  }
  for (const [k, v] of Object.entries(spec.env ?? {})) env.set(k, v);
  const { Cmd: _cmd, ...baseProcess } = base.config ?? {};
  return {
    ...base,
    config: {
      ...baseProcess,
      Env: [...env].map(([k, v]) => `${k}=${v}`),
      Entrypoint: spec.entrypoint,
      ...(spec.cmd ? { Cmd: spec.cmd } : {}),
      ...(spec.workingDir ? { WorkingDir: spec.workingDir } : {}),
      ...(spec.user ? { User: spec.user } : {}),
    },
    rootfs: { type: 'layers', diff_ids: [...base.rootfs.diff_ids, layer.diffId] },
    history: [
      ...(base.history ?? []),
      { ...(base.created ? { created: base.created } : {}), created_by: spec.createdBy ?? 'platform' },
    ],
  };
}

/** An OCI image manifest (serialized: its bytes are what the digest covers). */
export function imageManifest(
  config: { digest: string; size: number },
  layers: readonly Descriptor[],
): string {
  const manifest: ImageManifest = {
    schemaVersion: 2,
    mediaType: MEDIA_TYPES.ociManifest,
    config: { mediaType: MEDIA_TYPES.ociConfig, digest: config.digest, size: config.size },
    layers: layers.map((l) => ({ mediaType: l.mediaType, digest: l.digest, size: l.size })),
  };
  return JSON.stringify(manifest);
}

export function layerDescriptor(layer: Layer): Descriptor {
  return { mediaType: MEDIA_TYPES.ociLayerGzip, digest: layer.digest, size: layer.size };
}

/** Parse a registry manifest, refusing multi-platform indexes (a base must be pinned to one platform). */
export function parseImageManifest(raw: string, fallbackMediaType?: string): ImageManifest {
  const m = JSON.parse(raw) as Partial<ImageManifest> & { manifests?: unknown };
  const mediaType = m.mediaType ?? fallbackMediaType;
  if (m.manifests || mediaType === MEDIA_TYPES.ociIndex || mediaType === MEDIA_TYPES.dockerManifestList) {
    throw new Error('expected a single-platform image manifest, got a multi-platform index');
  }
  if (m.schemaVersion !== 2 || !m.config?.digest || !Array.isArray(m.layers)) {
    throw new Error('not an image manifest (schema version 2 with a config and layers)');
  }
  return m as ImageManifest;
}

function normalizePath(path: string): string {
  const rel = path.replace(/^\/+/, '');
  if (!rel || rel.endsWith('/') || rel.split('/').some((p) => p === '' || p === '.' || p === '..')) {
    throw new Error(`invalid file path in layer: ${path}`);
  }
  return rel;
}

const encoder = new TextEncoder();

function tarHeader(e: { name: string; mode: number; size: number; type: '0' | '5' }): Uint8Array {
  const h = new Uint8Array(512);
  const [prefix, name] = splitName(e.name);
  writeString(h, 0, 100, name);
  writeOctal(h, 100, 8, e.mode);
  writeOctal(h, 108, 8, 0); // uid
  writeOctal(h, 116, 8, 0); // gid
  writeOctal(h, 124, 12, e.size);
  writeOctal(h, 136, 12, 0); // mtime
  h.fill(0x20, 148, 156); // checksum is computed with its own field as spaces
  h[156] = e.type.charCodeAt(0);
  writeString(h, 257, 6, 'ustar');
  writeString(h, 263, 2, '00');
  writeString(h, 265, 32, 'root');
  writeString(h, 297, 32, 'root');
  writeString(h, 345, 155, prefix);
  const sum = h.reduce((a, b) => a + b, 0);
  writeString(h, 148, 8, `${sum.toString(8).padStart(6, '0')}\0 `);
  return h;
}

/** ustar keeps names ≤ 100 bytes, or a ≤ 155-byte prefix plus a ≤ 100-byte name split at a `/`. */
function splitName(path: string): [string, string] {
  const bytes = encoder.encode(path);
  if (bytes.length <= 100) return ['', path];
  // A directory entry's trailing slash stays with the name part.
  for (let i = path.length - 2; i > 0; i--) {
    if (path[i] !== '/') continue;
    const prefix = path.slice(0, i);
    const name = path.slice(i + 1);
    if (encoder.encode(prefix).length <= 155 && encoder.encode(name).length <= 100) return [prefix, name];
  }
  throw new Error(`path too long for a ustar layer: ${path}`);
}

function writeString(h: Uint8Array, offset: number, length: number, value: string): void {
  const bytes = encoder.encode(value);
  if (bytes.length > length) throw new Error(`tar header field too long: ${value}`);
  h.set(bytes, offset);
}

function writeOctal(h: Uint8Array, offset: number, length: number, value: number): void {
  const digits = value.toString(8);
  if (digits.length > length - 1) throw new Error(`tar header value too large: ${value}`);
  writeString(h, offset, length, `${digits.padStart(length - 1, '0')}\0`);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
