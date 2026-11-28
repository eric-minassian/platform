/**
 * The router's not-found origin: the second origin of each static request's
 * origin group (`createRequestOriginGroup` in the router). When the sites
 * bucket has no file at a deployment's key, CloudFront asks this function
 * with the same request, whose path the router already rewrote to
 * `/<app>/<stage>/<deployment>/<file>`. It answers with that deployment's
 * `404.html` and status 404, or a plain 404 when the build has none.
 *
 * A deployment's files never change, so the edge keeps the answer: a later
 * deployment has keys of its own.
 */
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
// Subpaths, not the package root: the root pulls in Effect, which would triple this bundle.
import { NOT_FOUND_FILE } from '@ericminassian/platform-core/constants';
import { APP_NAME_PATTERN, STAGE_NAME_PATTERN } from '@ericminassian/platform-core/naming';

/** What a function URL sends (payload 2.0), as far as this function reads it. */
export interface NotFoundEvent {
  rawPath?: string;
}

export interface NotFoundResult {
  statusCode: 404;
  headers: Record<string, string>;
  body: string;
}

const DEPLOYMENT_ID = /^d[0-9a-z]{26}$/;

/** Browsers ask again; the edge keeps it a day. */
const CACHE_CONTROL = 'public, max-age=0, s-maxage=86400';

/** The key of the 404 page of the deployment `path` names, or undefined for a path the router can't have made. */
export function notFoundPageKey(path: string): string | undefined {
  const [empty, app, stage, deployment, ...rest] = path.split('/');
  if (empty !== '' || !rest.length || !app || !stage || !deployment) return undefined;
  if (!APP_NAME_PATTERN.test(app) || !STAGE_NAME_PATTERN.test(stage) || !DEPLOYMENT_ID.test(deployment))
    return undefined;
  return `${app}/${stage}/${deployment}/${NOT_FOUND_FILE}`;
}

export type ReadPage = (key: string) => Promise<{ body: string; contentType?: string } | undefined>;

export async function answer(event: NotFoundEvent, read: ReadPage): Promise<NotFoundResult> {
  const key = notFoundPageKey(event.rawPath ?? '');
  const page = key ? await read(key) : undefined;
  return page
    ? {
        statusCode: 404,
        headers: {
          'content-type': page.contentType ?? 'text/html; charset=utf-8',
          'cache-control': CACHE_CONTROL,
        },
        body: page.body,
      }
    : {
        statusCode: 404,
        headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': CACHE_CONTROL },
        body: 'Not found.',
      };
}

const s3 = new S3Client({});

/** S3 answers AccessDenied, not NoSuchKey, for a missing key: the role can't list the bucket. */
const isMissing = (e: unknown) => e instanceof Error && (e.name === 'NoSuchKey' || e.name === 'AccessDenied');

const readPage: ReadPage = async (key) => {
  try {
    const out = await s3.send(new GetObjectCommand({ Bucket: process.env.SITES_BUCKET, Key: key }));
    return {
      body: (await out.Body?.transformToString('utf-8')) ?? '',
      ...(out.ContentType ? { contentType: out.ContentType } : {}),
    };
  } catch (e) {
    if (isMissing(e)) return undefined;
    throw e;
  }
};

export const handler = (event: NotFoundEvent): Promise<NotFoundResult> => answer(event, readPage);
