import {
  type CORSRule,
  CreateBucketCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  type LifecycleRule,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
  PutBucketCorsCommand,
  PutBucketLifecycleConfigurationCommand,
  PutBucketPolicyCommand,
  PutBucketTaggingCommand,
  PutBucketVersioningCommand,
  PutObjectCommand,
  PutPublicAccessBlockCommand,
} from '@aws-sdk/client-s3';
import { unzipSync } from 'fflate';
import type { S3Location } from '../index.ts';
import { cacheControlFor, contentTypeFor } from '../static.ts';
import {
  type EngineContext,
  errorName,
  isNotFound,
  mapLimit,
  type PolicyDocument,
  tagList,
} from '../util.ts';

export interface BucketSpec {
  name: string;
  versioned?: boolean;
  cors?: CORSRule[];
  lifecycle?: LifecycleRule[];
  policy?: PolicyDocument;
  tags?: Record<string, string>;
}

export async function ensureBucket(ctx: EngineContext, spec: BucketSpec): Promise<string> {
  const s3 = ctx.clients.s3;
  let exists = true;
  try {
    await s3.send(new HeadBucketCommand({ Bucket: spec.name }));
  } catch (e) {
    if (!isNotFound(e) && errorName(e) !== 'NotFound') throw e;
    exists = false;
  }
  if (!exists) {
    await s3.send(
      new CreateBucketCommand({
        Bucket: spec.name,
        ...(ctx.region === 'us-east-1'
          ? {}
          : { CreateBucketConfiguration: { LocationConstraint: ctx.region as never } }),
      }),
    );
    ctx.log('info', 'created bucket', `bucket ${spec.name}`);
  }
  await s3.send(
    new PutPublicAccessBlockCommand({
      Bucket: spec.name,
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        IgnorePublicAcls: true,
        BlockPublicPolicy: true,
        RestrictPublicBuckets: true,
      },
    }),
  );
  if (spec.versioned) {
    await s3.send(
      new PutBucketVersioningCommand({ Bucket: spec.name, VersioningConfiguration: { Status: 'Enabled' } }),
    );
  }
  if (spec.cors)
    await s3.send(
      new PutBucketCorsCommand({ Bucket: spec.name, CORSConfiguration: { CORSRules: spec.cors } }),
    );
  if (spec.lifecycle) {
    await s3.send(
      new PutBucketLifecycleConfigurationCommand({
        Bucket: spec.name,
        LifecycleConfiguration: { Rules: spec.lifecycle },
      }),
    );
  }
  if (spec.policy)
    await s3.send(new PutBucketPolicyCommand({ Bucket: spec.name, Policy: JSON.stringify(spec.policy) }));
  if (spec.tags)
    await s3.send(
      new PutBucketTaggingCommand({ Bucket: spec.name, Tagging: { TagSet: tagList(spec.tags) } }),
    );
  return `arn:aws:s3:::${spec.name}`;
}

export async function putObject(
  ctx: EngineContext,
  spec: {
    bucket: string;
    key: string;
    body: Uint8Array | string;
    contentType?: string;
    cacheControl?: string;
  },
): Promise<S3Location> {
  const res = await ctx.clients.s3.send(
    new PutObjectCommand({
      Bucket: spec.bucket,
      Key: spec.key,
      Body: spec.body,
      ContentType: spec.contentType,
      CacheControl: spec.cacheControl,
    }),
  );
  return { bucket: spec.bucket, key: spec.key, ...(res.VersionId ? { versionId: res.VersionId } : {}) };
}

export async function getObjectBytes(ctx: EngineContext, loc: S3Location): Promise<Uint8Array> {
  const res = await ctx.clients.s3.send(
    new GetObjectCommand({ Bucket: loc.bucket, Key: loc.key, VersionId: loc.versionId }),
  );
  return res.Body!.transformToByteArray();
}

/** Unzip a static bundle into `bucket/prefix/` with content types and cache headers. Returns file count. */
export async function publishStaticZip(
  ctx: EngineContext,
  spec: { source: S3Location; bucket: string; prefix: string },
): Promise<number> {
  const zip = await getObjectBytes(ctx, spec.source);
  const files = Object.entries(unzipSync(zip)).filter(([path]) => !path.endsWith('/'));
  await mapLimit(files, 16, async ([path, body]) => {
    const rel = path.replace(/^\/+/, '');
    await putObject(ctx, {
      bucket: spec.bucket,
      key: `${spec.prefix}/${rel}`,
      body,
      contentType: contentTypeFor(rel),
      cacheControl: cacheControlFor(rel),
    });
  });
  ctx.log('info', `published ${files.length} static files`, `static ${spec.prefix}`);
  return files.length;
}

/** Whether any object exists under `prefix`. */
export async function hasObjects(ctx: EngineContext, bucket: string, prefix: string): Promise<boolean> {
  const res = await ctx.clients.s3.send(
    new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, MaxKeys: 1 }),
  );
  return (res.KeyCount ?? res.Contents?.length ?? 0) > 0;
}

/** Immediate child "directories" under `prefix` (ends with `/`). */
export async function listChildPrefixes(
  ctx: EngineContext,
  bucket: string,
  prefix: string,
): Promise<string[]> {
  const out: string[] = [];
  let ContinuationToken: string | undefined;
  do {
    const res = await ctx.clients.s3.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, Delimiter: '/', ContinuationToken }),
    );
    for (const p of res.CommonPrefixes ?? []) if (p.Prefix) out.push(p.Prefix);
    ContinuationToken = res.NextContinuationToken;
  } while (ContinuationToken);
  return out;
}

/** Delete every object (and, in versioned buckets, every version) under `prefix`. */
export async function deletePrefix(ctx: EngineContext, bucket: string, prefix: string): Promise<number> {
  const s3 = ctx.clients.s3;
  let deleted = 0;
  try {
    let KeyMarker: string | undefined;
    let VersionIdMarker: string | undefined;
    do {
      const res = await s3.send(
        new ListObjectVersionsCommand({ Bucket: bucket, Prefix: prefix, KeyMarker, VersionIdMarker }),
      );
      const objects = [...(res.Versions ?? []), ...(res.DeleteMarkers ?? [])].map((v) => ({
        Key: v.Key!,
        VersionId: v.VersionId ?? undefined,
      }));
      for (let i = 0; i < objects.length; i += 1000) {
        const batch = objects.slice(i, i + 1000);
        if (batch.length) {
          await s3.send(
            new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: batch, Quiet: true } }),
          );
          deleted += batch.length;
        }
      }
      KeyMarker = res.IsTruncated ? res.NextKeyMarker : undefined;
      VersionIdMarker = res.IsTruncated ? res.NextVersionIdMarker : undefined;
    } while (KeyMarker);
  } catch (e) {
    if (isNotFound(e)) return deleted;
    throw e;
  }
  return deleted;
}
