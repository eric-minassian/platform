import { assert, describe, it } from '@effect/vitest';
import { type AppRecord, parseManifest, type PublicAppsResponse } from '@ericminassian/platform-core';
import { PUBLIC_CACHE_CONTROL } from '@ericminassian/platform-core/platform-api';
import { resetPlatform, useTestBindings } from '@ericminassian/platform/testing';
import { Effect } from 'effect';
import { afterEach, beforeEach, expect } from 'vitest';
import { directoryDays } from '../src/api/public.ts';
import type { DeploymentItem, StageItem } from '../src/store.ts';
import { api, memoryStore, testServices, wallClockAt } from './support.ts';

beforeEach(() => useTestBindings({ app: 'platform', stage: 'prod' }));
afterEach(() => resetPlatform());

const NOW = Date.parse('2026-11-26T18:00:00.000Z');

const app = (name: string, over: Partial<AppRecord> = {}): AppRecord => ({
  name,
  repo: `bob/${name}`,
  owners: ['bob'],
  createdBy: 'bob',
  createdAt: '2026-11-01T00:00:00.000Z',
  ...over,
});

const stage = (name: string, stageName: string, over: Partial<StageItem> = {}): StageItem => ({
  app: name,
  stage: stageName,
  host: `${name}.example.com`,
  url: `https://${name}.example.com`,
  status: 'active',
  preview: stageName !== 'prod',
  currentDeployment: `${name}-${stageName}`,
  createdAt: '2026-11-02T00:00:00.000Z',
  updatedAt: '2026-11-20T00:00:00.000Z',
  up: true,
  ...over,
});

const deployment = (
  name: string,
  id: string,
  config: Record<string, unknown> = {},
  over: Partial<DeploymentItem> = {},
): DeploymentItem => ({
  id,
  app: name,
  stage: 'prod',
  status: 'succeeded',
  actor: 'bob',
  events: [],
  createdAt: '2026-11-20T00:00:00.000Z',
  finishedAt: '2026-11-20T00:01:00.000Z',
  manifest: parseManifest({ name, ...config }),
  ...over,
});

describe('directoryDays', () => {
  it('is the 30 UTC days ending today', () => {
    const days = directoryDays(NOW);
    expect(days).toHaveLength(30);
    expect(new Date(days[0]!).toISOString()).toBe('2026-10-28T00:00:00.000Z');
    expect(new Date(days.at(-1)!).toISOString()).toBe('2026-11-26T00:00:00.000Z');
  });
});

describe('public directory', () => {
  it.effect('lists every listed prod to anyone, from any site, for the router to cache', () =>
    Effect.gen(function* () {
      yield* wallClockAt(NOW);
      const read: string[] = [];
      // notes' prod hasn't had an uptime result yet, and runs a compute switch the platform made.
      const { up: _noUptime, ...notesProd } = stage('notes', 'prod', { currentDeployment: 'notes-switch' });
      const request = yield* api(
        testServices({
          store: memoryStore({
            apps: [
              app('shop', { description: 'From the console', repoVisibility: 'public' }),
              app('notes', { description: 'Notes, as the console says', repoVisibility: 'private' }),
              app('quiet'),
              app('draft'),
              app('gone'),
              app('fresh'),
            ],
            stages: [
              stage('shop', 'prod'),
              stage('shop', 'pr-2'),
              notesProd,
              stage('quiet', 'prod'),
              stage('draft', 'pr-1'),
              stage('gone', 'prod', { status: 'destroyed' }),
              // Its first deploy is still running: nothing serves yet.
              stage('fresh', 'prod', { status: 'deploying', currentDeployment: undefined }),
            ],
            deployments: [
              deployment('shop', 'shop-prod', { description: 'A shop' }),
              deployment(
                'notes',
                'notes-build',
                {},
                { createdAt: '2026-11-10T00:00:00.000Z', finishedAt: '2026-11-10T00:02:00.000Z' },
              ),
              deployment('notes', 'notes-switch', {}, { actor: 'platform', computeSwitchOf: 'notes-build' }),
              deployment('quiet', 'quiet-prod', { listed: false }),
            ],
          }),
          telemetry: {
            edgeCountingSince: Effect.succeedSome('2026-11-26'),
            edgeDays: (name, stageName, days) =>
              Effect.sync(() => {
                read.push(`${name}/${stageName}`);
                const last = (n: number) => days.map((_, i) => (i === days.length - 1 ? n : 0));
                return { pageViews: last(7), requests: last(40) };
              }),
          },
        }),
      );

      const res = yield* request('/v1/public/apps');
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.headers.get('cache-control'), PUBLIC_CACHE_CONTROL);
      // A page fetches it from visitors' browsers: no credentials, so any origin.
      assert.strictEqual(res.headers.get('access-control-allow-origin'), '*');
      const body = (yield* Effect.promise(() => res.json())) as PublicAppsResponse;
      assert.strictEqual(body.generatedAt, '2026-11-26T18:00:00.000Z');
      assert.deepStrictEqual(
        [body.days.length, body.days[0], body.days.at(-1)],
        [30, '2026-10-28', '2026-11-26'],
      );
      // Days before it have no counts, which isn't the same as no traffic.
      assert.strictEqual(body.countingSince, '2026-11-26');
      const lastDay = (n: number) => [...Array.from({ length: 29 }, () => 0), n];
      assert.deepStrictEqual(body.apps, [
        {
          name: 'notes',
          // Its plat.config.ts has none, so the app's own.
          description: 'Notes, as the console says',
          url: 'https://notes.example.com',
          liveSince: '2026-11-02T00:00:00.000Z',
          // When its build went live, not when the platform switched how it runs.
          lastDeployedAt: '2026-11-10T00:02:00.000Z',
          up: null,
          pageViews: lastDay(7),
          requests: lastDay(40),
        },
        {
          name: 'shop',
          description: 'A shop',
          url: 'https://shop.example.com',
          source: 'https://github.com/bob/shop',
          liveSince: '2026-11-02T00:00:00.000Z',
          lastDeployedAt: '2026-11-20T00:01:00.000Z',
          up: true,
          pageViews: lastDay(7),
          requests: lastDay(40),
        },
      ]);
      // Only what's listed is read: prod's, never a preview's.
      assert.sameMembers(read, ['notes/prod', 'shop/prod']);
    }),
  );

  it.effect('leaves out when counting began where there is no access log', () =>
    Effect.gen(function* () {
      yield* wallClockAt(NOW);
      const request = yield* api(
        testServices({
          store: memoryStore({ apps: [], stages: [] }),
          telemetry: { edgeCountingSince: Effect.succeedNone },
        }),
      );
      const res = yield* request('/v1/public/apps');
      const body = (yield* Effect.promise(() => res.json())) as object;
      assert.deepStrictEqual(Object.keys(body).toSorted(), ['apps', 'days', 'generatedAt']);
    }),
  );
});
