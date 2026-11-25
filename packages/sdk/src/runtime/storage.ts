import type { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import {
  APP_CONFIG_FILE,
  contentTypeFor,
  DEV_UPLOAD_PATH,
  DEV_UPLOAD_RELAY_ENV,
  storagePath,
} from '@ericminassian/platform-core';
import type { StoreName } from '../register.ts';
import { getBindings } from './bindings.ts';
import { client } from './clients.ts';
import { span } from './telemetry.ts';

export interface StoredObject {
  key: string;
  size: number;
  lastModified?: Date;
}

export interface PutOptions {
  /** Default: from the key's extension (`application/octet-stream` when unknown). */
  contentType?: string;
  /** Sent with the file wherever it's served; the edge caches a public store's files by it. */
  cacheControl?: string;
}

export interface Store {
  put(key: string, body: Uint8Array | string, opts?: PutOptions): Promise<void>;
  get(key: string): Promise<Uint8Array | undefined>;
  getText(key: string): Promise<string | undefined>;
  delete(key: string): Promise<void>;
  list(
    prefix?: string,
    opts?: { cursor?: string; limit?: number },
  ): Promise<{ objects: StoredObject[]; cursor?: string }>;
  /** Browser-direct upload URL (HTTP PUT). The browser sends the same `Content-Type` and `Cache-Control`. */
  uploadUrl(
    key: string,
    opts?: { contentType?: string; cacheControl?: string; expiresInSeconds?: number },
  ): Promise<string>;
  downloadUrl(key: string, opts?: { expiresInSeconds?: number; filename?: string }): Promise<string>;
  /** Where the edge serves a public store's file, on the app's host. */
  publicUrl(key: string): string;
}

function location(name: string): { bucket: string; prefix: string; public: boolean } {
  const s = getBindings().storage;
  if (!s?.stores.includes(name)) {
    const declared = s?.stores ?? [];
    throw new Error(
      `Unknown store "${name}". Declared storage: ${declared.length ? declared.join(', ') : '(none)'} — add it under \`storage\` in ${APP_CONFIG_FILE}.`,
    );
  }
  const isPublic = Boolean(s.publicPrefix && s.public?.includes(name));
  return {
    bucket: s.bucket,
    prefix: `${isPublic ? s.publicPrefix : s.prefix}${name}/`,
    public: isPublic,
  };
}

/** The S3 client and command module, loaded on first use. */
async function s3() {
  const [c, m] = await Promise.all([client('s3'), import('@aws-sdk/client-s3')]);
  return { c, m };
}

async function sign(command: GetObjectCommand | PutObjectCommand, expiresIn: number): Promise<string> {
  const [{ getSignedUrl }, c] = await Promise.all([import('@aws-sdk/s3-request-presigner'), client('s3')]);
  return getSignedUrl(c, command, { expiresIn });
}

/** Under `plat dev`, the router's upload relay for a presigned PUT (see `DEV_UPLOAD_PATH`); elsewhere the URL itself. */
function forBrowser(signed: string): string {
  if (!process.env[DEV_UPLOAD_RELAY_ENV]) return signed;
  return `${getBindings().url}${DEV_UPLOAD_PATH}?to=${encodeURIComponent(signed)}`;
}

export function objectKey(prefix: string, key: string): string {
  const k = key.replace(/^\/+/, '');
  if (!k || k.split('/').some((p) => p === '..')) throw new Error(`Invalid storage key "${key}"`);
  return prefix + k;
}

function isNotFound(e: unknown): boolean {
  const name = (e as { name?: string })?.name;
  const status = (e as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
  return name === 'NoSuchKey' || name === 'NotFound' || status === 404;
}

/** A file store declared under `storage` in `plat.config.ts`. */
export function storage(name: StoreName): Store {
  const get = (key: string) =>
    span('storage.get', name, async () => {
      const { bucket, prefix } = location(name);
      const { c, m } = await s3();
      try {
        const out = await c.send(new m.GetObjectCommand({ Bucket: bucket, Key: objectKey(prefix, key) }));
        return out.Body ? await out.Body.transformToByteArray() : new Uint8Array();
      } catch (e) {
        if (isNotFound(e)) return undefined;
        throw e;
      }
    });

  return {
    put: (key, body, opts) =>
      span('storage.put', name, async () => {
        const { bucket, prefix } = location(name);
        const { c, m } = await s3();
        await c.send(
          new m.PutObjectCommand({
            Bucket: bucket,
            Key: objectKey(prefix, key),
            Body: typeof body === 'string' ? Buffer.from(body) : body,
            ContentType: opts?.contentType ?? contentTypeFor(key),
            ...(opts?.cacheControl ? { CacheControl: opts.cacheControl } : {}),
          }),
        );
      }),
    get,
    getText: async (key) => {
      const bytes = await get(key);
      return bytes ? new TextDecoder().decode(bytes) : undefined;
    },
    delete: (key) =>
      span('storage.delete', name, async () => {
        const { bucket, prefix } = location(name);
        const { c, m } = await s3();
        await c.send(new m.DeleteObjectCommand({ Bucket: bucket, Key: objectKey(prefix, key) }));
      }),
    list: (sub, opts) =>
      span('storage.list', name, async () => {
        const { bucket, prefix } = location(name);
        const { c, m } = await s3();
        const out = await c.send(
          new m.ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix + (sub ?? '').replace(/^\/+/, ''),
            ...(opts?.cursor ? { ContinuationToken: opts.cursor } : {}),
            ...(opts?.limit ? { MaxKeys: opts.limit } : {}),
          }),
        );
        const objects: StoredObject[] = (out.Contents ?? []).map((o) => ({
          key: (o.Key ?? '').slice(prefix.length),
          size: o.Size ?? 0,
          ...(o.LastModified ? { lastModified: o.LastModified } : {}),
        }));
        return out.NextContinuationToken ? { objects, cursor: out.NextContinuationToken } : { objects };
      }),
    uploadUrl: (key, opts) =>
      span('storage.sign', name, async () => {
        const { bucket, prefix } = location(name);
        const { m } = await s3();
        const cmd = new m.PutObjectCommand({
          Bucket: bucket,
          Key: objectKey(prefix, key),
          ...(opts?.contentType ? { ContentType: opts.contentType } : {}),
          ...(opts?.cacheControl ? { CacheControl: opts.cacheControl } : {}),
        });
        return forBrowser(await sign(cmd, opts?.expiresInSeconds ?? 900));
      }),
    downloadUrl: (key, opts) =>
      span('storage.sign', name, async () => {
        const { bucket, prefix } = location(name);
        const { m } = await s3();
        const cmd = new m.GetObjectCommand({
          Bucket: bucket,
          Key: objectKey(prefix, key),
          ...(opts?.filename
            ? { ResponseContentDisposition: `attachment; filename="${opts.filename.replace(/"/g, '')}"` }
            : {}),
        });
        return sign(cmd, opts?.expiresInSeconds ?? 900);
      }),
    publicUrl: (key) => {
      if (!location(name).public)
        throw new Error(
          `Store "${name}" isn't public, so the edge doesn't serve it: set \`storage: { ${name}: { public: true } }\` in ${APP_CONFIG_FILE}, or use downloadUrl.`,
        );
      return `${getBindings().url}${storagePath(name, key)}`;
    },
  };
}
