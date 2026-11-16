import {
  BatchCheckLayerAvailabilityCommand,
  BatchDeleteImageCommand,
  BatchGetImageCommand,
  CompleteLayerUploadCommand,
  CreateRepositoryCommand,
  DescribeImagesCommand,
  DescribeRepositoriesCommand,
  GetDownloadUrlForLayerCommand,
  InitiateLayerUploadCommand,
  PutImageCommand,
  UploadLayerPartCommand,
} from '@aws-sdk/client-ecr';
import {
  buildLayer,
  type Descriptor,
  IMAGE_MANIFEST_TYPES,
  type ImageConfig,
  type ImageFile,
  type ImageManifest,
  imageConfig,
  imageManifest,
  layerDescriptor,
  MEDIA_TYPES,
  parseImageManifest,
  sha256Digest,
} from '../images.ts';
import { type EngineContext, errorName, ignoreNotFound, mapLimit, sendRaw, tagList } from '../util.ts';

/**
 * Container images through the ECR API alone (no Docker daemon, no registry
 * login): blobs go up with the layer-upload calls and images are manifests
 * written with PutImage. Every call is IAM-authorized on the repository.
 */

export interface RepositoryState {
  name: string;
  arn: string;
  registryId: string;
}

export async function ensureRepository(
  ctx: EngineContext,
  spec: { name: string; tags?: Record<string, string> },
): Promise<RepositoryState> {
  const ecr = ctx.clients.ecr;
  const existing = await ignoreNotFound(
    ecr.send(new DescribeRepositoriesCommand({ repositoryNames: [spec.name] })),
  );
  const repo =
    existing?.repositories?.[0] ??
    (
      await ecr.send(
        new CreateRepositoryCommand({
          repositoryName: spec.name,
          imageTagMutability: 'MUTABLE',
          ...(spec.tags ? { tags: tagList(spec.tags) } : {}),
        }),
      )
    ).repository;
  if (!existing?.repositories?.[0]) ctx.log('info', 'created repository', `repository ${spec.name}`);
  return { name: spec.name, arn: repo!.repositoryArn!, registryId: repo!.registryId! };
}

/** An image in a registry other than the platform's, pinned by manifest digest. */
export interface ImageRef {
  /** `public.ecr.aws`. */
  registry: string;
  /** `docker/library/node`. */
  repository: string;
  digest: string;
  tag?: string;
}

/** Where a base image comes from the first time a repository needs it. */
export interface ImageSource {
  /** The manifest's raw bytes (its digest is checked against the ref). */
  manifest(ref: ImageRef): Promise<{ bytes: Uint8Array; mediaType?: string }>;
  blob(ref: ImageRef, digest: string): Promise<Uint8Array>;
}

/** Anonymous pulls from a public registry that speaks the distribution API with token auth (ECR Public). */
export function publicRegistrySource(fetchImpl: typeof fetch = fetch): ImageSource {
  const tokens = new Map<string, Promise<string>>();
  const token = (ref: ImageRef) => {
    const key = `${ref.registry}/${ref.repository}`;
    let t = tokens.get(key);
    if (!t) {
      t = (async () => {
        const url = `https://${ref.registry}/token/?scope=repository:${ref.repository}:pull&service=${ref.registry}`;
        const res = await fetchImpl(url);
        if (!res.ok) throw new Error(`${ref.registry} refused an anonymous pull token (${res.status})`);
        return ((await res.json()) as { token: string }).token;
      })();
      tokens.set(key, t);
    }
    return t;
  };
  const get = async (ref: ImageRef, path: string, accept?: string) => {
    const res = await fetchImpl(`https://${ref.registry}/v2/${ref.repository}/${path}`, {
      headers: { Authorization: `Bearer ${await token(ref)}`, ...(accept ? { Accept: accept } : {}) },
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`GET ${ref.registry}/${ref.repository}/${path} failed (${res.status})`);
    return res;
  };
  return {
    async manifest(ref) {
      const res = await get(ref, `manifests/${ref.digest}`, IMAGE_MANIFEST_TYPES.join(', '));
      const mediaType = res.headers.get('content-type') ?? undefined;
      return { bytes: new Uint8Array(await res.arrayBuffer()), ...(mediaType ? { mediaType } : {}) };
    },
    async blob(ref, digest) {
      return new Uint8Array(await (await get(ref, `blobs/${digest}`)).arrayBuffer());
    },
  };
}

/** A base image as held in the platform's repository. */
export interface BaseImage {
  /** Manifest digest (the ref's). */
  digest: string;
  tag: string;
  manifest: ImageManifest;
  config: ImageConfig;
}

/** Tag a base image is kept under: `base--<first 12 hex of its digest>`. */
export function baseImageTag(digest: string): string {
  return `base--${digest.replace(/^sha256:/, '').slice(0, 12)}`;
}

/**
 * Make `repository` hold `base` (copying it from its registry the first
 * time) and return its manifest and config. The copy is tagged: ECR
 * reclaims layers no image references, so the base's layers stay only
 * while an image of their own points at them.
 */
export async function ensureBaseImage(
  ctx: EngineContext,
  spec: { repository: string; base: ImageRef; source?: ImageSource },
): Promise<BaseImage> {
  const tag = baseImageTag(spec.base.digest);
  const held = await getImage(ctx, spec.repository, { tag });
  if (held) {
    const manifest = parseImageManifest(held.manifest, held.mediaType);
    const config = await readBlob(ctx, spec.repository, manifest.config.digest);
    return {
      digest: held.digest,
      tag,
      manifest,
      config: JSON.parse(new TextDecoder().decode(config)) as ImageConfig,
    };
  }

  const source = spec.source ?? publicRegistrySource();
  const name = `${spec.base.registry}/${spec.base.repository}@${spec.base.digest}`;
  const fetched = await source.manifest(spec.base);
  if (sha256Digest(fetched.bytes) !== spec.base.digest)
    throw new Error(`${name}: the registry returned a manifest with a different digest`);
  const raw = new TextDecoder().decode(fetched.bytes);
  const manifest = parseImageManifest(raw, fetched.mediaType);
  const blobs = [manifest.config, ...manifest.layers];
  const total = blobs.reduce((n, b) => n + b.size, 0);
  ctx.log(
    'info',
    `copying base image ${name} (${(total / 1e6).toFixed(0)} MB)`,
    `image ${spec.repository}:${tag}`,
  );
  let config: Uint8Array | undefined;
  const missing = new Set(await missingBlobs(ctx, spec.repository, blobs));
  await mapLimit(blobs, 3, async (b) => {
    if (!missing.has(b.digest) && b !== manifest.config) return;
    const bytes = await source.blob(spec.base, b.digest);
    if (sha256Digest(bytes) !== b.digest || bytes.length !== b.size)
      throw new Error(`${name}: blob ${b.digest} doesn't match its digest`);
    if (b === manifest.config) config = bytes;
    if (missing.has(b.digest)) await uploadBlob(ctx, spec.repository, bytes, b.digest);
  });
  await putImage(ctx, {
    repository: spec.repository,
    manifest: raw,
    mediaType: manifest.mediaType ?? fetched.mediaType ?? MEDIA_TYPES.ociManifest,
    tag,
  });
  if (!config) throw new Error(`${name}: its config blob wasn't fetched`);
  return {
    digest: spec.base.digest,
    tag,
    manifest,
    config: JSON.parse(new TextDecoder().decode(config)) as ImageConfig,
  };
}

export interface PushImageSpec {
  repository: string;
  /** `<registry>/<repository>`: the pushed image is referenced as `<repositoryUri>@<digest>`. */
  repositoryUri: string;
  /** From {@link ensureBaseImage}, in the same repository. */
  base: BaseImage;
  /** Files of the one layer added on top of the base. */
  files: readonly ImageFile[];
  entrypoint: string[];
  cmd?: string[];
  env?: Record<string, string>;
  workingDir?: string;
  user?: string;
  tag: string;
}

/**
 * Build an image (the base plus one layer of `files`) and push it under
 * `tag`. Idempotent: blobs the repository has are skipped and pushing the
 * same image under the same tag again is a no-op.
 */
export async function pushImage(
  ctx: EngineContext,
  spec: PushImageSpec,
): Promise<{ digest: string; image: string }> {
  const layer = buildLayer(spec.files);
  const config = imageConfig(spec.base.config, layer, {
    entrypoint: spec.entrypoint,
    ...(spec.cmd ? { cmd: spec.cmd } : {}),
    ...(spec.env ? { env: spec.env } : {}),
    ...(spec.workingDir ? { workingDir: spec.workingDir } : {}),
    ...(spec.user ? { user: spec.user } : {}),
    createdBy: `platform: ${spec.files.map((f) => f.path).join(' ')}`,
  });
  const configBytes = new TextEncoder().encode(JSON.stringify(config));
  const configDigest = sha256Digest(configBytes);
  const manifest = imageManifest({ digest: configDigest, size: configBytes.length }, [
    ...spec.base.manifest.layers,
    layerDescriptor(layer),
  ]);
  const uploads = new Map([
    [layer.digest, layer.blob],
    [configDigest, configBytes],
  ]);
  const missing = await missingBlobs(
    ctx,
    spec.repository,
    [...uploads].map(([digest, b]) => ({ digest, size: b.length, mediaType: '' })),
  );
  for (const digest of missing) await uploadBlob(ctx, spec.repository, uploads.get(digest)!, digest);
  const digest = await putImage(ctx, {
    repository: spec.repository,
    manifest,
    mediaType: MEDIA_TYPES.ociManifest,
    tag: spec.tag,
  });
  ctx.log('info', `pushed image ${digest.slice(7, 19)}`, `image ${spec.repository}:${spec.tag}`);
  return { digest, image: `${spec.repositoryUri}@${digest}` };
}

export interface ImageListing {
  tag: string;
  digest: string;
  pushedAt?: Date;
}

/** Tagged images whose tag starts with `tagPrefix`, one entry per tag. */
export async function listImages(
  ctx: EngineContext,
  repository: string,
  tagPrefix = '',
): Promise<ImageListing[]> {
  const out: ImageListing[] = [];
  let nextToken: string | undefined;
  do {
    const res = await ignoreNotFound(
      ctx.clients.ecr.send(
        new DescribeImagesCommand({
          repositoryName: repository,
          filter: { tagStatus: 'TAGGED' },
          maxResults: 1000,
          nextToken,
        }),
      ),
    );
    if (!res) return out;
    for (const d of res.imageDetails ?? []) {
      for (const tag of d.imageTags ?? []) {
        if (tag.startsWith(tagPrefix))
          out.push({
            tag,
            digest: d.imageDigest!,
            ...(d.imagePushedAt ? { pushedAt: d.imagePushedAt } : {}),
          });
      }
    }
    nextToken = res.nextToken;
  } while (nextToken);
  return out;
}

/**
 * Delete images by tag or digest. A tag removes only that tag (the image
 * goes with its last tag); a digest removes the image under every tag.
 */
export async function deleteImages(
  ctx: EngineContext,
  repository: string,
  ids: ReadonlyArray<{ tag: string } | { digest: string }>,
): Promise<void> {
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    const res = await ignoreNotFound(
      ctx.clients.ecr.send(
        new BatchDeleteImageCommand({
          repositoryName: repository,
          imageIds: batch.map((id) => ('tag' in id ? { imageTag: id.tag } : { imageDigest: id.digest })),
        }),
      ),
    );
    const failed = (res?.failures ?? []).filter((f) => f.failureCode !== 'ImageNotFound');
    if (failed.length) {
      const f = failed[0]!;
      throw new Error(
        `couldn't delete ${f.imageId?.imageTag ?? f.imageId?.imageDigest} from ${repository}: ${f.failureReason}`,
      );
    }
    for (const id of batch)
      ctx.log('info', 'deleted image', `image ${repository}:${'tag' in id ? id.tag : id.digest}`);
  }
}

/** An image's manifest by tag or digest, or undefined when the repository doesn't hold it. */
export async function getImage(
  ctx: EngineContext,
  repository: string,
  id: { tag: string } | { digest: string },
): Promise<{ digest: string; manifest: string; mediaType?: string } | undefined> {
  const res = await ignoreNotFound(
    ctx.clients.ecr.send(
      new BatchGetImageCommand({
        repositoryName: repository,
        imageIds: ['tag' in id ? { imageTag: id.tag } : { imageDigest: id.digest }],
        acceptedMediaTypes: [...IMAGE_MANIFEST_TYPES],
      }),
    ),
  );
  const image = res?.images?.[0];
  if (!image?.imageManifest || !image.imageId?.imageDigest) return undefined;
  return {
    digest: image.imageId.imageDigest,
    manifest: image.imageManifest,
    ...(image.imageManifestMediaType ? { mediaType: image.imageManifestMediaType } : {}),
  };
}

/** Digests of `blobs` the repository doesn't have yet. */
async function missingBlobs(
  ctx: EngineContext,
  repository: string,
  blobs: readonly Descriptor[],
): Promise<string[]> {
  const digests = [...new Set(blobs.map((b) => b.digest))];
  const missing: string[] = [];
  for (let i = 0; i < digests.length; i += 100) {
    const res = await ctx.clients.ecr.send(
      new BatchCheckLayerAvailabilityCommand({
        repositoryName: repository,
        layerDigests: digests.slice(i, i + 100),
      }),
    );
    const available = new Set(
      (res.layers ?? []).filter((l) => l.layerAvailability === 'AVAILABLE').map((l) => l.layerDigest),
    );
    for (const d of digests.slice(i, i + 100)) if (!available.has(d)) missing.push(d);
  }
  return missing;
}

/** Upload one blob in the part size ECR asks for. ECR checks the digest on completion. */
export async function uploadBlob(
  ctx: EngineContext,
  repository: string,
  bytes: Uint8Array,
  digest: string,
): Promise<void> {
  const ecr = ctx.clients.ecr;
  const init = await ecr.send(new InitiateLayerUploadCommand({ repositoryName: repository }));
  const partSize = init.partSize || 10 * 1024 * 1024;
  for (let first = 0; first < bytes.length; first += partSize) {
    const end = Math.min(first + partSize, bytes.length);
    await ecr.send(
      new UploadLayerPartCommand({
        repositoryName: repository,
        uploadId: init.uploadId,
        partFirstByte: first,
        partLastByte: end - 1,
        layerPartBlob: bytes.subarray(first, end),
      }),
    );
  }
  try {
    await ecr.send(
      new CompleteLayerUploadCommand({
        repositoryName: repository,
        uploadId: init.uploadId,
        layerDigests: [digest],
      }),
    );
  } catch (e) {
    // Uploaded concurrently by another deploy: the blob is there either way.
    if (errorName(e) !== 'LayerAlreadyExistsException') throw e;
  }
}

/** Write a manifest under a tag; returns its digest. Writing the same manifest and tag again is fine. */
async function putImage(
  ctx: EngineContext,
  spec: { repository: string; manifest: string; mediaType: string; tag: string },
): Promise<string> {
  try {
    const res = await ctx.clients.ecr.send(
      new PutImageCommand({
        repositoryName: spec.repository,
        imageManifest: spec.manifest,
        imageManifestMediaType: spec.mediaType,
        imageTag: spec.tag,
      }),
    );
    return res.image?.imageId?.imageDigest ?? sha256Digest(new TextEncoder().encode(spec.manifest));
  } catch (e) {
    if (errorName(e) !== 'ImageAlreadyExistsException') throw e;
    return sha256Digest(new TextEncoder().encode(spec.manifest));
  }
}

/**
 * A blob's bytes. ECR hands out a short-lived download URL; it is fetched
 * with the ECR client's own HTTP handler so the emulator's TLS settings apply.
 */
async function readBlob(ctx: EngineContext, repository: string, digest: string): Promise<Uint8Array> {
  const ecr = ctx.clients.ecr;
  const { downloadUrl } = await ecr.send(
    new GetDownloadUrlForLayerCommand({ repositoryName: repository, layerDigest: digest }),
  );
  if (!downloadUrl) throw new Error(`ECR returned no download URL for ${digest}`);
  const url = new URL(downloadUrl);
  const res = await sendRaw(ecr, {
    method: 'GET',
    protocol: url.protocol,
    hostname: url.hostname,
    ...(url.port ? { port: Number(url.port) } : {}),
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    headers: { host: url.host },
  });
  const bytes = res.body;
  if (res.statusCode !== 200)
    throw new Error(`downloading ${digest} from ${repository} failed (${res.statusCode})`);
  if (sha256Digest(bytes) !== digest)
    throw new Error(`blob ${digest} in ${repository} doesn't match its digest`);
  return bytes;
}
