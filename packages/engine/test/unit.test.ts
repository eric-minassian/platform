import { type PlatformRuntimeConfig, parseManifest } from '@ericminassian/platform-core';
import { describe, expect, it } from 'vitest';
import { fixTimestamps } from '../src/compat.ts';
import { deepMerge, routerCachePolicy } from '../src/drivers/cloudfront.ts';
import { snapRetention } from '../src/drivers/logs.ts';
import { cacheControlFor, contentTypeFor, hostFor, policies } from '../src/index.ts';

const platform = (over: Partial<PlatformRuntimeConfig> = {}): PlatformRuntimeConfig => ({
  v: 1,
  target: 'aws',
  accountId: '111122223333',
  region: 'us-east-1',
  domain: 'example.com',
  publicScheme: 'https',
  artifactsBucket: 'a',
  sitesBucket: 's',
  storageBucket: 'store',
  stateTable: 'platform',
  telemetryTable: 'platform-telemetry',
  ...over,
});

describe('stage role policy', () => {
  const manifest = parseManifest({
    name: 'todo',
    db: true,
    queues: { emails: {} },
    storage: ['uploads'],
    crons: { nightly: '0 3 * * *' },
  });
  const doc = policies.stageRolePolicy({
    app: 'todo',
    stage: 'prod',
    region: 'us-east-1',
    accountId: '111122223333',
    manifest,
    platform: platform(),
  });
  const bySid = Object.fromEntries(doc.Statement.map((s) => [s.Sid, s]));

  it('scopes every grant to this stage', () => {
    expect(bySid.Db?.Resource).toEqual([
      'arn:aws:dynamodb:us-east-1:111122223333:table/todo--prod',
      'arn:aws:dynamodb:us-east-1:111122223333:table/todo--prod/index/*',
    ]);
    expect(bySid.Queues?.Resource).toBe('arn:aws:sqs:us-east-1:111122223333:todo--prod--*');
    expect(bySid.Events?.Resource).toBe('arn:aws:events:us-east-1:111122223333:event-bus/todo--prod');
    expect(bySid.StorageObjects?.Resource).toBe('arn:aws:s3:::store/todo/prod/*');
    expect(bySid.StorageList?.Condition).toEqual({ StringLike: { 's3:prefix': ['todo/prod/*'] } });
    expect(bySid.InvokeWorker?.Resource).toBe(
      'arn:aws:lambda:us-east-1:111122223333:function:todo--prod--worker',
    );
    expect(bySid.Secrets?.Resource).toContain(
      'arn:aws:ssm:us-east-1:111122223333:parameter/platform/apps/todo/_shared/secrets/*',
    );
  });

  it('omits grants for features the app does not use', () => {
    const minimal = policies.stageRolePolicy({
      app: 'site',
      stage: 'pr-1',
      region: 'us-east-1',
      accountId: '1',
      manifest: parseManifest({ name: 'site', web: { static: 'dist' } }),
      platform: platform(),
    });
    const sids = minimal.Statement.map((s) => s.Sid);
    expect(sids).not.toContain('Db');
    expect(sids).not.toContain('Queues');
    expect(sids).not.toContain('StorageObjects');
    expect(sids).not.toContain('InvokeWorker');
  });

  it('trusts Lambda and Scheduler', () => {
    expect(policies.stageTrustPolicy().Statement[0]?.Principal).toEqual({
      Service: ['lambda.amazonaws.com', 'scheduler.amazonaws.com'],
    });
  });

  it('only lets the control plane create roles that carry the boundary', () => {
    const cp = policies.controlPlanePolicy({
      region: 'us-east-1',
      accountId: '1',
      runtime: { artifactsBucket: 'a', sitesBucket: 's', storageBucket: 'st', boundaryPolicyArn: 'arn:b' },
    });
    const create = cp.Statement.find((s) => s.Sid === 'StageRoles');
    expect(create?.Condition).toEqual({ StringEquals: { 'iam:PermissionsBoundary': 'arn:b' } });
    expect(create?.Resource).toBe('arn:aws:iam::1:role/platform/apps/*');
  });

  it('pins CI trust to the main branch of the platform repo, in both OIDC subject formats', () => {
    const t = policies.githubCiTrustPolicy({ accountId: '1', owner: 'o', repo: 'r', ownerId: 7, repoId: 42 });
    expect(t.Statement[0]?.Condition?.StringEquals?.['token.actions.githubusercontent.com:sub']).toEqual([
      'repo:o/r:ref:refs/heads/main',
      'repo:o@7/r@42:ref:refs/heads/main',
    ]);
  });
});

describe('static assets', () => {
  it('caches hashed files forever and revalidates the rest', () => {
    expect(cacheControlFor('assets/index-BRmjjcSz.js')).toMatch(/immutable/);
    expect(cacheControlFor('/assets/logo.svg')).toMatch(/immutable/);
    expect(cacheControlFor('chunk.a1b2c3d4.css')).toMatch(/immutable/);
    expect(cacheControlFor('index.html')).toMatch(/must-revalidate/);
    expect(cacheControlFor('robots.txt')).toMatch(/must-revalidate/);
    expect(cacheControlFor('my-component.js')).toMatch(/must-revalidate/);
  });
  it('knows common content types', () => {
    expect(contentTypeFor('a/b/index.html')).toBe('text/html; charset=utf-8');
    expect(contentTypeFor('x.woff2')).toBe('font/woff2');
    expect(contentTypeFor('unknown.bin')).toBe('application/octet-stream');
  });
});

describe('misc', () => {
  it('fixes emulator epoch timestamps', () => {
    const fixed = JSON.parse(
      fixTimestamps('{"createdAt":1794686149,"nested":[{"updatedAt":1794686149000}],"n":5}'),
    );
    expect(fixed.createdAt).toBe('2026-11-14T19:55:49.000Z');
    expect(fixed.nested[0].updatedAt).toBe('2026-11-14T19:55:49.000Z');
    expect(fixed.n).toBe(5);
    expect(fixTimestamps('not json')).toBe('not json');
  });
  it('uses <app>.localhost for the local stage', () => {
    expect(hostFor(platform({ target: 'emulator', domain: 'localhost' }), 'todo', 'local')).toBe(
      'todo.localhost',
    );
    expect(hostFor(platform(), 'todo', 'prod')).toBe('todo.example.com');
    expect(hostFor(platform(), 'todo', 'pr-3')).toBe('todo--pr-3.example.com');
  });
  it('snaps log retention to allowed values', () => {
    expect(snapRetention(7)).toBe(7);
    expect(snapRetention(10)).toBe(14);
    expect(snapRetention(99999)).toBe(3653);
  });
  it('keys the router cache on the platform host header', () => {
    const p = routerCachePolicy('platform-default');
    expect(p.ParametersInCacheKeyAndForwardedToOrigin?.HeadersConfig?.Headers?.Items).toContain(
      'x-platform-host',
    );
    expect(p.MinTTL).toBe(0);
  });
});

describe('distribution config merge', () => {
  it('keeps fields CloudFront requires that the desired config omits', () => {
    const current = {
      Enabled: true,
      DefaultCacheBehavior: { TargetOriginId: 'sites', SmoothStreaming: false, Compress: true },
      Origins: { Quantity: 1, Items: [{ Id: 'sites', ConnectionAttempts: 3, DomainName: 'old' }] },
    };
    const desired = {
      DefaultCacheBehavior: { TargetOriginId: 'sites', Compress: true },
      Origins: { Quantity: 1, Items: [{ Id: 'sites', DomainName: 'new' }] },
    };
    expect(deepMerge(current, desired)).toEqual({
      Enabled: true,
      DefaultCacheBehavior: { TargetOriginId: 'sites', SmoothStreaming: false, Compress: true },
      Origins: { Quantity: 1, Items: [{ Id: 'sites', ConnectionAttempts: 3, DomainName: 'new' }] },
    });
  });

  it('replaces arrays whose length changed and ignores undefined', () => {
    expect(deepMerge({ a: [1, 2], b: 1 }, { a: [3], b: undefined })).toEqual({ a: [3], b: 1 });
  });
});
