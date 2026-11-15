/**
 * A deployment's build artifacts in the artifacts bucket: the CLI uploads
 * them with presigned POST forms, and the deployer reads them back.
 */
import { GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { type ArtifactFile, names, type PresignedPost } from '@ericminassian/platform-core';
import { Context, Effect, Layer, Option } from 'effect';
import { Aws, AwsError, tryAws } from './aws.ts';
import { Settings } from './config.ts';

const MAX_ARTIFACT_BYTES = 250 * 1024 * 1024;

/** Where an uploaded artifact is (the version the deploy uses, when the bucket keeps versions). */
export interface ArtifactLocation {
  readonly bucket: string;
  readonly key: string;
  readonly versionId?: string;
}

export interface ArtifactRef {
  readonly app: string;
  readonly stage: string;
  readonly deployment: string;
}

export class Artifacts extends Context.Service<
  Artifacts,
  {
    /** Upload forms valid for 15 minutes, one per file. */
    uploadForms(
      ref: ArtifactRef,
      files: ReadonlyArray<ArtifactFile>,
    ): Effect.Effect<Partial<Record<ArtifactFile, PresignedPost>>>;
    /** None when the file wasn't uploaded. */
    locate(ref: ArtifactRef, file: ArtifactFile): Effect.Effect<Option.Option<ArtifactLocation>, AwsError>;
    readText(ref: ArtifactRef, file: ArtifactFile): Effect.Effect<string>;
  }
>()('@ericminassian/platform-control-plane/Artifacts') {
  static readonly layer: Layer.Layer<Artifacts, never, Aws | Settings> = Layer.effect(
    Artifacts,
    Effect.gen(function* () {
      const aws = yield* Aws;
      const settings = yield* Settings;
      const bucket = Effect.map(settings.runtime, (r) => r.artifactsBucket);
      const key = (ref: ArtifactRef, file: ArtifactFile) =>
        names.artifactKey(ref.app, ref.stage, ref.deployment, file);

      const uploadForms = Effect.fn('Artifacts.uploadForms')(function* (
        ref: ArtifactRef,
        files: ReadonlyArray<ArtifactFile>,
      ) {
        const Bucket = yield* bucket;
        const forms: Partial<Record<ArtifactFile, PresignedPost>> = {};
        for (const file of files) {
          const post = yield* tryAws(() =>
            createPresignedPost(aws.s3(), {
              Bucket,
              Key: key(ref, file),
              Conditions: [['content-length-range', 1, MAX_ARTIFACT_BYTES]],
              Expires: 900,
            }),
          );
          forms[file] = { url: post.url, fields: post.fields };
        }
        return forms;
      }, Effect.orDie);

      const locate = Effect.fn('Artifacts.locate')(function* (ref: ArtifactRef, file: ArtifactFile) {
        const Bucket = yield* bucket;
        const Key = key(ref, file);
        return yield* tryAws(() => aws.s3().send(new HeadObjectCommand({ Bucket, Key }))).pipe(
          Effect.map((head) =>
            Option.some<ArtifactLocation>({
              bucket: Bucket,
              key: Key,
              ...(head.VersionId ? { versionId: head.VersionId } : {}),
            }),
          ),
          Effect.catchIf(AwsError.is('NotFound', 'NoSuchKey'), () => Effect.succeedNone),
        );
      });

      const readText = Effect.fn('Artifacts.readText')(function* (ref: ArtifactRef, file: ArtifactFile) {
        const Bucket = yield* bucket;
        const res = yield* tryAws(() => aws.s3().send(new GetObjectCommand({ Bucket, Key: key(ref, file) })));
        return yield* tryAws(async () => (await res.Body?.transformToString()) ?? '');
      }, Effect.orDie);

      return Artifacts.of({ uploadForms, locate, readText });
    }),
  );
}
