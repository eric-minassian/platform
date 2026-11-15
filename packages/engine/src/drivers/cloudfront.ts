import {
  type CachePolicyConfig,
  CreateCachePolicyCommand,
  CreateDistributionWithTagsCommand,
  CreateFunctionCommand,
  CreateKeyValueStoreCommand,
  CreateOriginAccessControlCommand,
  DescribeFunctionCommand,
  DescribeKeyValueStoreCommand,
  type DistributionConfig,
  GetCachePolicyConfigCommand,
  GetDistributionConfigCommand,
  GetFunctionCommand,
  ListCachePoliciesCommand,
  ListDistributionsCommand,
  ListKeyValueStoresCommand,
  ListOriginAccessControlsCommand,
  PublishFunctionCommand,
  UpdateCachePolicyCommand,
  UpdateDistributionCommand,
  UpdateFunctionCommand,
} from '@aws-sdk/client-cloudfront';
import { type EngineContext, ignoreNotFound, tagList, waitFor } from '../util.ts';

/** AWS managed origin request policy `Managed-AllViewerExceptHostHeader` (Web Function origins need it). */
export const ALL_VIEWER_EXCEPT_HOST_HEADER = 'b689b0a8-53d0-40ab-baf2-68738e2966ac';
/** Route 53 hosted zone id for every CloudFront alias target. */
export const CLOUDFRONT_HOSTED_ZONE_ID = 'Z2FDTNDATAQYW2';

export async function ensureKeyValueStore(
  ctx: EngineContext,
  spec: { name: string; comment?: string },
): Promise<{ arn: string; id: string }> {
  const cf = ctx.clients.cloudfront;
  let Marker: string | undefined;
  do {
    const res = await cf.send(new ListKeyValueStoresCommand({ Marker }));
    const found = (res.KeyValueStoreList?.Items ?? []).find((k) => k.Name === spec.name);
    if (found?.ARN && found.Id) return { arn: found.ARN, id: found.Id };
    Marker = res.KeyValueStoreList?.NextMarker;
  } while (Marker);
  const res = await cf.send(new CreateKeyValueStoreCommand({ Name: spec.name, Comment: spec.comment }));
  const kvs = res.KeyValueStore!;
  ctx.log('info', 'created key value store', `kvs ${spec.name}`);
  await waitFor(`key value store ${spec.name}`, async () => {
    const d = await cf.send(new DescribeKeyValueStoreCommand({ Name: spec.name }));
    return d.KeyValueStore?.Status === 'READY' || d.KeyValueStore?.Status === undefined;
  });
  return { arn: kvs.ARN!, id: kvs.Id! };
}

/** Create/update a CloudFront Function (runtime 2.0) and publish it to LIVE. Returns the function ARN. */
export async function ensureRouterFunction(
  ctx: EngineContext,
  spec: { name: string; code: string; kvsArn?: string; comment?: string },
): Promise<string> {
  const cf = ctx.clients.cloudfront;
  const code = new TextEncoder().encode(spec.code);
  const FunctionConfig = {
    Comment: spec.comment ?? 'platform router',
    Runtime: 'cloudfront-js-2.0' as const,
    ...(spec.kvsArn
      ? { KeyValueStoreAssociations: { Quantity: 1, Items: [{ KeyValueStoreARN: spec.kvsArn }] } }
      : {}),
  };
  const existing = await ignoreNotFound(
    cf.send(new DescribeFunctionCommand({ Name: spec.name, Stage: 'DEVELOPMENT' })),
  );
  let etag: string | undefined;
  if (!existing?.ETag) {
    const res = await cf.send(
      new CreateFunctionCommand({ Name: spec.name, FunctionConfig, FunctionCode: code }),
    );
    etag = res.ETag;
    ctx.log('info', 'created router function', `cloudfront-function ${spec.name}`);
  } else {
    const live = await ignoreNotFound(cf.send(new GetFunctionCommand({ Name: spec.name, Stage: 'LIVE' })));
    const liveCode = live?.FunctionCode ? new TextDecoder().decode(live.FunctionCode) : undefined;
    if (liveCode === spec.code) return existing.FunctionSummary!.FunctionMetadata!.FunctionARN!;
    const res = await cf.send(
      new UpdateFunctionCommand({
        Name: spec.name,
        IfMatch: existing.ETag,
        FunctionConfig,
        FunctionCode: code,
      }),
    );
    etag = res.ETag;
    ctx.log('info', 'updated router function', `cloudfront-function ${spec.name}`);
  }
  const published = await cf.send(new PublishFunctionCommand({ Name: spec.name, IfMatch: etag }));
  return published.FunctionSummary!.FunctionMetadata!.FunctionARN!;
}

export async function ensureOriginAccessControl(
  ctx: EngineContext,
  spec: { name: string; originType: 's3' | 'lambda'; signingBehavior?: 'always' | 'always-amz-auth' },
): Promise<string> {
  const cf = ctx.clients.cloudfront;
  let Marker: string | undefined;
  do {
    const res = await cf.send(new ListOriginAccessControlsCommand({ Marker }));
    const found = (res.OriginAccessControlList?.Items ?? []).find((o) => o.Name === spec.name);
    if (found?.Id) return found.Id;
    Marker = res.OriginAccessControlList?.NextMarker;
  } while (Marker);
  const res = await cf.send(
    new CreateOriginAccessControlCommand({
      OriginAccessControlConfig: {
        Name: spec.name,
        SigningProtocol: 'sigv4',
        SigningBehavior: (spec.signingBehavior ?? 'always') as never,
        OriginAccessControlOriginType: spec.originType,
      },
    }),
  );
  ctx.log('info', 'created origin access control', `oac ${spec.name}`);
  return res.OriginAccessControl!.Id!;
}

export async function ensureCachePolicy(ctx: EngineContext, config: CachePolicyConfig): Promise<string> {
  const cf = ctx.clients.cloudfront;
  const list = await cf.send(new ListCachePoliciesCommand({ Type: 'custom' }));
  const found = (list.CachePolicyList?.Items ?? []).find(
    (p) => p.CachePolicy?.CachePolicyConfig?.Name === config.Name,
  );
  if (found?.CachePolicy?.Id) {
    const id = found.CachePolicy.Id;
    const current = await cf.send(new GetCachePolicyConfigCommand({ Id: id }));
    if (diffPaths(normalize(current.CachePolicyConfig), normalize(config)).length) {
      await cf.send(
        new UpdateCachePolicyCommand({ Id: id, IfMatch: current.ETag, CachePolicyConfig: config }),
      );
      ctx.log('info', 'updated cache policy', `cache-policy ${config.Name}`);
    }
    return id;
  }
  const res = await cf.send(new CreateCachePolicyCommand({ CachePolicyConfig: config }));
  ctx.log('info', 'created cache policy', `cache-policy ${config.Name}`);
  return res.CachePolicy!.Id!;
}

/** The platform router's cache policy: origins decide caching; the host is part of the key. */
export function routerCachePolicy(name: string): CachePolicyConfig {
  return {
    Name: name,
    Comment: 'platform router: origin-controlled caching, per-host keys',
    MinTTL: 0,
    DefaultTTL: 0,
    MaxTTL: 31_536_000,
    ParametersInCacheKeyAndForwardedToOrigin: {
      EnableAcceptEncodingGzip: true,
      EnableAcceptEncodingBrotli: true,
      HeadersConfig: {
        HeaderBehavior: 'whitelist',
        Headers: { Quantity: 2, Items: ['x-platform-host', 'authorization'] },
      },
      CookiesConfig: { CookieBehavior: 'none' },
      QueryStringsConfig: { QueryStringBehavior: 'all' },
    },
  };
}

export interface DistributionState {
  id: string;
  arn: string;
  domainName: string;
  status: string;
}

/**
 * A distribution identified by its `Comment` (CloudFront has no names).
 * `config` is the full desired DistributionConfig minus CallerReference.
 */
export async function ensureDistribution(
  ctx: EngineContext,
  spec: {
    comment: string;
    config: Omit<DistributionConfig, 'CallerReference' | 'Comment'>;
    tags?: Record<string, string>;
  },
): Promise<DistributionState> {
  const cf = ctx.clients.cloudfront;
  const existing = await findDistribution(ctx, spec.comment);
  if (!existing) {
    const res = await cf.send(
      new CreateDistributionWithTagsCommand({
        DistributionConfigWithTags: {
          DistributionConfig: {
            ...spec.config,
            Comment: spec.comment,
            CallerReference: `${spec.comment}-${Date.now()}`,
          },
          Tags: { Items: tagList(spec.tags ?? {}) },
        },
      }),
    );
    const d = res.Distribution!;
    ctx.log('info', 'created distribution (propagation takes a few minutes)', `distribution ${spec.comment}`);
    return { id: d.Id!, arn: d.ARN!, domainName: d.DomainName!, status: d.Status! };
  }
  const current = await cf.send(new GetDistributionConfigCommand({ Id: existing.id }));
  // UpdateDistribution replaces the whole config and rejects one that omits
  // required fields (SmoothStreaming, FieldLevelEncryptionId, ...), so the
  // desired settings are deep-merged over what CloudFront returned.
  const merged = deepMerge(current.DistributionConfig!, {
    ...spec.config,
    Comment: spec.comment,
    CallerReference: current.DistributionConfig!.CallerReference,
  }) as DistributionConfig;
  const changed = diffPaths(normalize(current.DistributionConfig!), normalize(merged));
  if (changed.length) {
    await cf.send(
      new UpdateDistributionCommand({ Id: existing.id, IfMatch: current.ETag, DistributionConfig: merged }),
    );
    ctx.log(
      'info',
      `updated distribution (${changed.slice(0, 5).join(', ')})`,
      `distribution ${spec.comment}`,
    );
  }
  return existing;
}

export async function findDistribution(
  ctx: EngineContext,
  comment: string,
): Promise<DistributionState | undefined> {
  const cf = ctx.clients.cloudfront;
  let Marker: string | undefined;
  do {
    const res = await cf.send(new ListDistributionsCommand({ Marker }));
    const found = (res.DistributionList?.Items ?? []).find((d) => d.Comment === comment);
    if (found)
      return { id: found.Id!, arn: found.ARN!, domainName: found.DomainName!, status: found.Status! };
    Marker = res.DistributionList?.IsTruncated ? res.DistributionList.NextMarker : undefined;
  } while (Marker);
  return undefined;
}

/**
 * Overlay `patch` on `base`: objects merge key by key, equal-length arrays
 * merge element by element (CloudFront lists like Origins keep their order),
 * anything else is replaced. Undefined patch values keep the base value.
 */
export function deepMerge(base: unknown, patch: unknown): unknown {
  if (patch === undefined) return base;
  if (Array.isArray(base) && Array.isArray(patch)) {
    return base.length === patch.length ? patch.map((p, i) => deepMerge(base[i], p)) : patch;
  }
  if (isPlainObject(base) && isPlainObject(patch)) {
    const out: Record<string, unknown> = { ...base };
    for (const [k, v] of Object.entries(patch)) out[k] = deepMerge(base[k], v);
    return out;
  }
  return patch;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date);
}

/** Paths where two normalized values differ, e.g. `DefaultCacheBehavior.Compress`. */
export function diffPaths(a: unknown, b: unknown, path = ''): string[] {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].flatMap((k) => diffPaths(a[k], b[k], path ? `${path}.${k}` : k));
  }
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
    return a.flatMap((v, i) => diffPaths(v, b[i], `${path}[${i}]`));
  }
  return [path || '(root)'];
}

/** Drop undefined fields so a fetched config and a desired config compare equal. */
function normalize(v: unknown): unknown {
  // String lists in a distribution config (methods, aliases, header names) are
  // sets; CloudFront returns them in its own order.
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return [...v].sort();
  if (Array.isArray(v)) return v.map(normalize);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) {
      const val = (v as Record<string, unknown>)[k];
      if (val !== undefined) out[k] = normalize(val);
    }
    return out;
  }
  return v;
}
