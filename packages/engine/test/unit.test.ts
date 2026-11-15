import { type PlatformRuntimeConfig, parseManifest } from '@ericminassian/platform-core';
import { describe, expect, it } from 'vitest';
import { fixTimestamps } from '../src/compat.ts';
import { snapRetention } from '../src/drivers/logs.ts';
import { cacheControlFor, contentTypeFor, hostFor, policies } from '../src/index.ts';
import { rollbackStage, staleStaticPrefixes } from '../src/stage.ts';
import type { EngineContext } from '../src/util.ts';

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
});

describe('static garbage collection', () => {
  const p = (d: string) => `shop/prod/${d}/`;

  it('keeps the newest deployments and the new one', () => {
    const all = ['d1', 'd2', 'd3', 'd4', 'd5'].map(p);
    expect(staleStaticPrefixes(all, ['shop/prod/d5'])).toEqual([p('d2'), p('d1')]);
  });

  it('keeps the previously live deployment even when it is older', () => {
    // Rolled back to d1, then deployed d5: edges still on d1's route keep serving it.
    const all = ['d1', 'd2', 'd3', 'd4', 'd5'].map(p);
    expect(staleStaticPrefixes(all, ['shop/prod/d5', 'shop/prod/d1'])).toEqual([p('d2')]);
  });
});

describe('rollbackStage', () => {
  /** Fake clients: answers by command name; records every call. */
  function fakeContext(answers: Record<string, (input: Record<string, unknown>) => unknown>) {
    const calls: string[] = [];
    const client = {
      send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
        const name = cmd.constructor.name;
        calls.push(name);
        const answer = answers[name];
        if (!answer) throw new Error(`unexpected ${name}`);
        return answer(cmd.input);
      },
    };
    const ctx = {
      clients: { s3: client, lambdaWeb: client, kvs: client },
      region: 'us-east-1',
      target: 'aws',
      log: () => {},
      accountId: async () => '111122223333',
    } as unknown as EngineContext;
    return { ctx, calls };
  }
  const notFound = () => {
    throw Object.assign(new Error('gone'), { name: 'ResourceNotFoundException' });
  };
  const input = {
    app: 'shop',
    stage: 'prod',
    platform: platform({ kvsArn: 'arn:aws:cloudfront::111122223333:key-value-store/x' }),
    route: { v: 1 as const, app: 'shop', stage: 'prod', d: 'd1', o: 'fn.example', s: 'shop/prod/d1' },
    revisionId: 'r1',
  };

  it('refuses a deployment whose static files were cleaned up, before changing anything', async () => {
    const { ctx, calls } = fakeContext({ ListObjectsV2Command: () => ({ KeyCount: 0 }) });
    await expect(rollbackStage(ctx, input)).rejects.toThrow(
      "deployment d1 can't be rolled back to: its static files have been cleaned up",
    );
    expect(calls).toEqual(['ListObjectsV2Command']);
  });

  it('refuses a deployment whose server revision was cleaned up', async () => {
    const { ctx, calls } = fakeContext({
      ListObjectsV2Command: () => ({ KeyCount: 1 }),
      GetWebFunctionRevisionCommand: notFound,
    });
    await expect(rollbackStage(ctx, input)).rejects.toThrow('its server revision has been cleaned up');
    expect(calls).toEqual(['ListObjectsV2Command', 'GetWebFunctionRevisionCommand']);
  });
});
