import { assert, describe, it } from '@effect/vitest';
import {
  type AppRecord,
  type Dashboard,
  type LogLine,
  MIN_SDK_VERSION,
  parseManifest,
  type ResolvedManifest,
  type SavedQuery,
} from '@ericminassian/platform-core';
import { Conflict } from '@ericminassian/platform-core/platform-api';
import type { ControlServiceInput } from '@ericminassian/platform-engine';
import { captureTelemetry, resetPlatform, useTestBindings } from '@ericminassian/platform/testing';
import { Effect, Layer, Ref, Stream } from 'effect';
import { SignJWT } from 'jose';
import { afterEach, beforeEach } from 'vitest';
import { AwsError } from '../src/aws.ts';
import { DeployFailed } from '../src/deploy.ts';
import { WorkerJobFailed } from '../src/jobs/call.ts';
import { Library } from '../src/library.ts';
import type { DeploymentItem, StageItem } from '../src/store.ts';
import { api, ciToken, githubApp, memoryStore, type TestServices, testServices } from './support.ts';

// The API as Lambda runs it: the platform's server wrapper over `toFetchHandler`,
// routing, schemas, `Authenticated` and the handlers, on in-memory services.

let telemetry: ReturnType<typeof captureTelemetry>;
beforeEach(() => {
  useTestBindings({ app: 'platform', stage: 'prod' });
  telemetry = captureTelemetry();
});
afterEach(() => {
  telemetry.stop();
  resetPlatform();
});
const errorEvents = () => telemetry.events.filter((e) => e.t === 'err');

const shop: AppRecord = {
  name: 'shop',
  repo: 'bob/shop',
  owners: ['bob'],
  createdBy: 'bob',
  createdAt: '2026-11-01T00:00:00.000Z',
};

const prodStage = (over: Partial<StageItem> = {}): StageItem => ({
  app: 'shop',
  stage: 'prod',
  host: 'shop.example.com',
  url: 'https://shop.example.com',
  status: 'active',
  preview: false,
  currentDeployment: 'd1',
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
  route: { v: 1, app: 'shop', stage: 'prod', d: 'd1', o: 'internal.lambda-url.example' },
  up: true,
  ...over,
});

/** The deployment live on shop's prod, with `manifest` fields over an app that declares nothing. */
const liveDeployment = (manifest: Partial<ResolvedManifest> = {}): DeploymentItem => ({
  id: 'd1',
  app: 'shop',
  stage: 'prod',
  status: 'succeeded',
  actor: 'bob',
  events: [],
  createdAt: '2026-11-01T00:00:00.000Z',
  manifest: {
    name: 'shop',
    auth: { enabled: false, required: false },
    db: false,
    queues: {},
    events: [],
    eventOptions: {},
    crons: {},
    storage: [],
    storageOptions: {},
    secrets: [],
    env: {},
    services: {},
    ...manifest,
  },
});

/** A succeeded deployment of shop whose plat.config.ts is `config`. */
const configuredDeployment = (
  id: string,
  config: Record<string, unknown>,
  stage = 'prod',
): DeploymentItem => ({
  id,
  app: 'shop',
  stage,
  status: 'succeeded',
  actor: 'bob',
  events: [],
  createdAt: '2026-11-01T00:00:00.000Z',
  manifest: parseManifest({ name: 'shop', ...config }),
});

const json = (res: Response) => Effect.promise(() => res.json());
const text = (res: Response) => Effect.promise(() => res.text());
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** The API on test services, and a platform token for `github` (from `plat login`, through the API). */
const setup = (options: TestServices = {}) =>
  Effect.gen(function* () {
    const request = yield* api(testServices(options));
    const signIn = Effect.fnUntraced(function* (github: string) {
      const res = yield* request('/v1/auth/cli', { method: 'POST', json: { githubToken: github } });
      assert.strictEqual(res.status, 200);
      return bearer(((yield* json(res)) as { token: string }).token);
    });
    return { request, signIn };
  });

/** A CLI that sends the SDK version every deployment needs. */
const SDK = MIN_SDK_VERSION;

describe('authentication', () => {
  it.effect('answers 401 with the error body when there are no credentials', () =>
    Effect.gen(function* () {
      const { request } = yield* setup();
      const res = yield* request('/v1/apps');
      assert.strictEqual(res.status, 401);
      assert.deepStrictEqual(yield* json(res), {
        error: { code: 'unauthenticated', message: 'sign in at the console or run `plat login`' },
      });
    }),
  );

  it.effect('rejects malformed, forged and non-member tokens', () =>
    Effect.gen(function* () {
      const { request } = yield* setup();
      const malformed = yield* request('/v1/me', { headers: bearer('nope') });
      assert.deepStrictEqual(yield* json(malformed), {
        error: { code: 'unauthenticated', message: 'malformed bearer token' },
      });

      const forged = yield* Effect.promise(() =>
        new SignJWT({ use: 'cli' })
          .setProtectedHeader({ alg: 'HS256' })
          .setIssuer('platform')
          .setAudience('platform-cli')
          .setSubject('ada')
          .sign(new TextEncoder().encode('some-other-key-that-is-32-chars-long')),
      );
      const res = yield* request('/v1/me', { headers: bearer(forged) });
      assert.strictEqual(res.status, 401);
      assert.deepStrictEqual(yield* json(res), {
        error: { code: 'unauthenticated', message: 'invalid or expired platform token; run `plat login`' },
      });

      const stranger = yield* request('/v1/auth/cli', { method: 'POST', json: { githubToken: 'mallory' } });
      assert.strictEqual(stranger.status, 403);
      assert.deepStrictEqual(yield* json(stranger), {
        error: {
          code: 'not_a_member',
          message: 'mallory is not invited. Ask an admin to add you to platform.config.ts.',
        },
      });
    }),
  );

  it.effect('answers a member with their role', () =>
    Effect.gen(function* () {
      const { request, signIn } = yield* setup();
      const res = yield* request('/v1/me', { headers: yield* signIn('bob') });
      assert.deepStrictEqual(yield* json(res), { github: 'bob', role: 'member' });
    }),
  );

  it.effect('signs the console in with GitHub, and needs the CSRF header for cookie writes', () =>
    Effect.gen(function* () {
      const { request } = yield* setup({ settings: { githubApp: Effect.succeedSome(githubApp) } });

      const login = yield* request('/auth/github/login?redirect=%2Fapps%2Fshop');
      assert.strictEqual(login.status, 302);
      const authorize = new URL(login.headers.get('location') ?? '');
      assert.strictEqual(authorize.origin + authorize.pathname, 'https://github.com/login/oauth/authorize');
      assert.strictEqual(
        authorize.searchParams.get('redirect_uri'),
        'https://platform.example.com/auth/github/callback',
      );
      const state = authorize.searchParams.get('state') ?? '';
      const oauthCookie = login.headers.get('set-cookie') ?? '';
      assert.match(
        oauthCookie,
        /^__plat_oauth=[^;]+; Max-Age=600; Path=\/auth\/github; HttpOnly; Secure; SameSite=Lax/,
      );

      const cookie = oauthCookie.split(';')[0] ?? '';
      const tampered = yield* request('/auth/github/callback?state=wrong&code=ada', { headers: { cookie } });
      assert.strictEqual(tampered.status, 400);
      assert.strictEqual(yield* text(tampered), 'Sign-in expired or was tampered with. Try again.');
      assert.match(tampered.headers.get('set-cookie') ?? '', /^__plat_oauth=; Max-Age=0;/);

      // The mock GitHub hands back the code as the user's token, and the token as their login.
      const callback = yield* request(`/auth/github/callback?state=${state}&code=ada`, {
        headers: { cookie },
      });
      assert.strictEqual(callback.status, 302);
      assert.strictEqual(callback.headers.get('location'), '/apps/shop');
      const session = callback.headers
        .getSetCookie()
        .find((c) => c.startsWith('__plat_console='))
        ?.split(';')[0];
      assert.isDefined(session);
      const consoleCookie = { cookie: session ?? '' };

      assert.deepStrictEqual(yield* json(yield* request('/v1/me', { headers: consoleCookie })), {
        github: 'ada',
        role: 'admin',
      });
      const create = { method: 'POST', json: { name: 'shop', repo: 'ada/shop' } } as const;
      const forged = yield* request('/v1/apps', { ...create, headers: consoleCookie });
      assert.strictEqual(forged.status, 403);
      assert.deepStrictEqual(yield* json(forged), {
        error: { code: 'csrf', message: 'cookie-authenticated writes need the x-platform-csrf header' },
      });
      const fromConsole = yield* request('/v1/apps', {
        ...create,
        headers: { ...consoleCookie, 'x-platform-csrf': '1' },
      });
      assert.strictEqual(fromConsole.status, 201);

      const logout = yield* request('/auth/logout', { method: 'POST' });
      assert.strictEqual(logout.status, 204);
      assert.match(logout.headers.get('set-cookie') ?? '', /^__plat_console=; Max-Age=0;.*Path=\//);
    }),
  );

  it.effect('only returns to same-origin paths after sign-in', () =>
    Effect.gen(function* () {
      const { request } = yield* setup({ settings: { githubApp: Effect.succeedSome(githubApp) } });
      for (const redirect of ['//evil.com', 'https://evil.com', '/\\evil.com']) {
        const login = yield* request(`/auth/github/login?redirect=${encodeURIComponent(redirect)}`);
        const state = new URL(login.headers.get('location') ?? '').searchParams.get('state');
        const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
        const callback = yield* request(`/auth/github/callback?state=${state}&code=bob`, {
          headers: { cookie },
        });
        assert.strictEqual(callback.headers.get('location'), '/', redirect);
      }
      const login = yield* request('/auth/github/login');
      const state = new URL(login.headers.get('location') ?? '').searchParams.get('state');
      const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
      const denied = yield* request(`/auth/github/callback?state=${state}&code=mallory`, {
        headers: { cookie },
      });
      assert.strictEqual(denied.headers.get('location'), '/login?denied=mallory');
    }),
  );

  it.effect('says when GitHub sign-in is not configured', () =>
    Effect.gen(function* () {
      const { request } = yield* setup();
      const res = yield* request('/auth/github/login');
      assert.strictEqual(res.status, 503);
      assert.strictEqual(yield* text(res), 'GitHub sign-in is not configured yet (see docs/SETUP.md).');
    }),
  );

  it.effect('keeps CI runs to member-less endpoints and to the stages their ref may deploy', () =>
    Effect.gen(function* () {
      const { request } = yield* setup({
        store: memoryStore({ apps: [shop] }),
        artifacts: {
          uploadForms: (_ref, files) =>
            Effect.succeed(Object.fromEntries(files.map((f) => [f, { url: 'https://s3', fields: {} }]))),
        },
      });
      const ci = bearer(
        yield* ciToken({
          repository: 'bob/shop',
          repository_owner: 'bob',
          ref: 'refs/heads/main',
          event_name: 'push',
          sha: 'abc123',
        }),
      );
      const me = yield* request('/v1/me', { headers: ci });
      assert.strictEqual(me.status, 403);
      assert.deepStrictEqual(yield* json(me), {
        error: { code: 'members_only', message: 'this endpoint needs a member token' },
      });

      const deploy = (stage: string) =>
        request('/v1/apps/shop/deployments', {
          method: 'POST',
          headers: ci,
          json: {
            stage,
            manifest: { name: 'shop', web: { static: 'dist' } },
            files: ['static.zip'],
            sdk: SDK,
          },
        });
      const prod = yield* deploy('prod');
      assert.strictEqual(prod.status, 201);
      const created = (yield* json(prod)) as {
        deployment: { actor: string; commit: string };
        uploads: object;
      };
      assert.strictEqual(created.deployment.actor, 'ci:bob/shop');
      assert.strictEqual(created.deployment.commit, 'abc123');
      assert.deepStrictEqual(Object.keys(created.uploads).toSorted(), ['manifest.json', 'static.zip']);

      const staging = yield* deploy('staging');
      assert.strictEqual(staging.status, 403);
      assert.deepStrictEqual(yield* json(staging), {
        error: { code: 'forbidden', message: 'stage staging can only be deployed with a member token' },
      });
    }),
  );

  it.effect('keeps the admin overview to admins', () =>
    Effect.gen(function* () {
      const { request, signIn } = yield* setup({
        store: memoryStore({ apps: [shop], stages: [prodStage({ up: false })] }),
        telemetry: { cost: () => Effect.die(new Error('no cost yet')) },
      });
      const member = yield* request('/v1/admin/overview', { headers: yield* signIn('bob') });
      assert.strictEqual(member.status, 403);
      assert.deepStrictEqual(yield* json(member), {
        error: { code: 'admins_only', message: 'this endpoint is for platform admins' },
      });
      const admin = yield* request('/v1/admin/overview', { headers: yield* signIn('ada') });
      assert.deepStrictEqual(yield* json(admin), {
        members: [
          { github: 'ada', role: 'admin' },
          { github: 'bob', role: 'member' },
        ],
        limits: { appsPerMember: 2, stagesPerApp: 3, emailsPerDay: 2000, servicesPerApp: 2 },
        apps: 1,
        stages: 1,
        previews: 0,
        down: ['shop'],
        cost: { total: null, shared: null },
      });
    }),
  );
});

describe('errors', () => {
  it.effect('answers requests that fail their schema with 400 and a readable message', () =>
    Effect.gen(function* () {
      const { request, signIn } = yield* setup({ store: memoryStore({ apps: [shop] }) });
      const bob = yield* signIn('bob');
      const cases: Array<[string, RequestInit & { json?: unknown }, string]> = [
        ['/v1/auth/cli', { method: 'POST', json: {} }, 'githubToken is required'],
        ['/v1/auth/cli', { method: 'POST', json: { githubToken: '' } }, 'githubToken is required'],
        [
          '/v1/apps',
          { method: 'POST', headers: bob, json: { name: 'x', repo: 'nope' } },
          'repo must be "owner/name"',
        ],
        [
          '/v1/apps/shop',
          { method: 'PATCH', headers: bob, json: { owners: [] } },
          'owners must be a non-empty list',
        ],
        ['/v1/apps/shop/data/items', { headers: bob }, 'collection is required'],
        [
          '/v1/apps/shop/secrets/KEY',
          { method: 'PUT', headers: bob, json: { value: 'x'.repeat(5000) } },
          'secret values are limited to 4 KB',
        ],
        [
          '/v1/apps/shop/deployments?limit=many',
          { headers: bob },
          'limit: Expected a string representing a finite number',
        ],
        [
          '/v1/apps/shop/errors/fp',
          { method: 'PATCH', headers: bob, json: { status: 'gone' } },
          'status: Expected "open" | "resolved" | "ignored"',
        ],
        [
          '/v1/apps',
          { method: 'POST', headers: { ...bob, 'content-type': 'application/json' }, body: '{oops' },
          'Expected a valid JSON body',
        ],
      ];
      for (const [path, init, message] of cases) {
        const res = yield* request(path, init);
        assert.strictEqual(res.status, 400, path);
        assert.deepStrictEqual(yield* json(res), { error: { code: 'bad_request', message } }, path);
      }
      assert.deepStrictEqual(errorEvents(), []);
    }),
  );

  it.effect('answers a body that is not JSON with a 415 error body', () =>
    Effect.gen(function* () {
      const { request, signIn } = yield* setup();
      const res = yield* request('/v1/apps', {
        method: 'POST',
        headers: { ...(yield* signIn('bob')), 'content-type': 'application/x-www-form-urlencoded' },
        body: 'name=shop',
      });
      assert.strictEqual(res.status, 415);
      assert.deepStrictEqual(yield* json(res), {
        error: {
          code: 'unsupported_media_type',
          message: 'send the body as JSON (content-type: application/json)',
        },
      });
    }),
  );

  it.effect('checks credentials before the body', () =>
    Effect.gen(function* () {
      const { request } = yield* setup();
      const res = yield* request('/v1/apps', { method: 'POST', json: { nope: true } });
      assert.strictEqual(res.status, 401);
    }),
  );

  it.effect('answers unknown routes with a JSON 404 naming them', () =>
    Effect.gen(function* () {
      const { request } = yield* setup();
      for (const [method, path] of [
        ['GET', '/v1/nope'],
        ['DELETE', '/v1/apps'],
        ['GET', '/v2/whatever'],
      ] as const) {
        const res = yield* request(`${path}?x=1`, { method });
        assert.strictEqual(res.status, 404);
        assert.deepStrictEqual(yield* json(res), {
          error: { code: 'not_found', message: `no route for ${method} ${path}` },
        });
      }
    }),
  );

  it.effect('answers domain errors with their status and code', () =>
    Effect.gen(function* () {
      const { request, signIn } = yield* setup({
        store: memoryStore({ apps: [shop, { ...shop, name: 'blog', repo: 'bob/blog' }] }),
      });
      const bob = yield* signIn('bob');
      const create = (name: string) =>
        request('/v1/apps', { method: 'POST', headers: bob, json: { name, repo: `bob/${name}` } });

      const exists = yield* create('shop');
      assert.strictEqual(exists.status, 409);
      assert.deepStrictEqual(yield* json(exists), {
        error: { code: 'exists', message: 'app shop already exists' },
      });

      const reserved = yield* create('www');
      assert.strictEqual(reserved.status, 400);
      assert.strictEqual(((yield* json(reserved)) as { error: { code: string } }).error.code, 'bad_request');

      const third = yield* create('notes');
      assert.strictEqual(third.status, 429);
      assert.deepStrictEqual(yield* json(third), {
        error: { code: 'limit', message: 'limit of 2 apps per member reached' },
      });

      const someoneElses = yield* request('/v1/apps/shop', { headers: yield* signIn('ada') });
      assert.strictEqual(someoneElses.status, 200, 'admins see every app');
      const hidden = yield* request('/v1/apps/missing', { headers: bob });
      assert.deepStrictEqual(yield* json(hidden), {
        error: { code: 'not_found', message: 'app missing not found' },
      });
      assert.deepStrictEqual(errorEvents(), []);
    }),
  );

  it.effect('answers a defect with a 500 error body and records it', () =>
    Effect.gen(function* () {
      const { request, signIn } = yield* setup({
        store: memoryStore({ apps: [shop] }),
        telemetry: { errors: () => Effect.die(new Error('the telemetry table is gone')) },
      });
      const res = yield* request('/v1/apps/shop/errors', { headers: yield* signIn('bob') });
      assert.strictEqual(res.status, 500);
      assert.deepStrictEqual(yield* json(res), { error: { code: 'internal', message: 'internal error' } });
      const [recorded] = errorEvents();
      assert.strictEqual(recorded?.t === 'err' ? recorded.message : undefined, 'the telemetry table is gone');
    }),
  );
});

describe('apps', () => {
  it.effect('registers, lists, updates and removes apps', () =>
    Effect.gen(function* () {
      const store = memoryStore();
      const { request, signIn } = yield* setup({
        store,
        telemetry: {
          cost: (app) => Effect.succeed({ app, currency: 'USD', days: [], monthToDateUsd: 1.25 }),
        },
      });
      const bob = yield* signIn('bob');

      const created = yield* request('/v1/apps', {
        method: 'POST',
        headers: bob,
        json: { name: ' shop ', repo: 'bob/shop', description: 'd'.repeat(300) },
      });
      assert.strictEqual(created.status, 201);
      const record = (yield* json(created)) as AppRecord;
      assert.strictEqual(record.name, 'shop');
      assert.strictEqual(record.description?.length, 200);
      assert.deepStrictEqual(record.owners, ['bob']);

      const list = (yield* json(yield* request('/v1/apps', { headers: bob }))) as Array<{
        app: AppRecord;
        costMonthToDateUsd: number;
        health: null;
      }>;
      assert.deepStrictEqual(
        list.map((s) => [s.app.name, s.costMonthToDateUsd, s.health]),
        [['shop', 1.25, null]],
      );

      const updated = yield* request('/v1/apps/shop', {
        method: 'PATCH',
        headers: bob,
        json: { owners: ['bob', 'ada', 'bob'] },
      });
      assert.deepStrictEqual(((yield* json(updated)) as AppRecord).owners, ['bob', 'ada']);

      const removed = yield* request('/v1/apps/shop', { method: 'DELETE', headers: bob });
      assert.strictEqual(removed.status, 204);
      assert.strictEqual(yield* text(removed), '');
      assert.deepStrictEqual(yield* json(yield* request('/v1/apps', { headers: bob })), []);
    }),
  );

  it.effect('refuses to remove an app that still has stages', () =>
    Effect.gen(function* () {
      const { request, signIn } = yield* setup({
        store: memoryStore({ apps: [shop], stages: [prodStage()] }),
      });
      const res = yield* request('/v1/apps/shop', { method: 'DELETE', headers: yield* signIn('bob') });
      assert.strictEqual(res.status, 409);
      assert.deepStrictEqual(yield* json(res), {
        error: { code: 'has_stages', message: 'destroy stages first: prod' },
      });
    }),
  );
});

describe('stages and deployments', () => {
  it.effect('creates, starts and lists a deployment', () =>
    Effect.gen(function* () {
      const jobs = yield* Ref.make<ReadonlyArray<{ name: string; payload: unknown }>>([]);
      const { request, signIn } = yield* setup({
        store: memoryStore({ apps: [shop] }),
        jobs,
        artifacts: {
          uploadForms: (_ref, files) =>
            Effect.succeed(
              Object.fromEntries(files.map((f) => [f, { url: 'https://s3', fields: { key: f } }])),
            ),
          locate: (ref, file) =>
            Effect.succeedSome({ bucket: 'artifacts', key: `${ref.deployment}/${file}` }),
        },
      });
      const bob = yield* signIn('bob');

      const invalid = yield* request('/v1/apps/shop/deployments', {
        method: 'POST',
        headers: bob,
        json: { stage: 'prod', manifest: { name: 'shop', queues: { BAD: {} } } },
      });
      assert.strictEqual(invalid.status, 422);
      assert.strictEqual(
        ((yield* json(invalid)) as { error: { code: string } }).error.code,
        'invalid_manifest',
      );

      // Bundles built by an SDK older than 0.4.0 can't run on today's bindings and jobs.
      for (const sdk of [undefined, '0.3.0']) {
        const old = yield* request('/v1/apps/shop/deployments', {
          method: 'POST',
          headers: bob,
          json: { stage: 'prod', manifest: { name: 'shop' }, ...(sdk ? { sdk } : {}) },
        });
        assert.strictEqual(old.status, 400);
        assert.match(
          ((yield* json(old)) as { error: { message: string } }).error.message,
          /needs 0\.4\.0 or later\. Upgrade @ericminassian\/platform and @ericminassian\/plat/,
        );
      }

      // The test platform allows two services per app.
      const services = { a: { entry: 'a.ts' }, b: { entry: 'b.ts' }, c: { entry: 'c.ts' } };
      const tooMany = yield* request('/v1/apps/shop/deployments', {
        method: 'POST',
        headers: bob,
        json: { stage: 'prod', manifest: { name: 'shop', services }, files: ['services.zip'] },
      });
      assert.strictEqual(tooMany.status, 422);
      assert.deepStrictEqual(yield* json(tooMany), {
        error: {
          code: 'invalid_manifest',
          message: 'plat.config.ts declares 3 services (a, b, c); an app may have 2',
        },
      });
      const withServices = yield* request('/v1/apps/shop/deployments', {
        method: 'POST',
        headers: bob,
        json: {
          stage: 'pr-3',
          manifest: { name: 'shop', services: { a: services.a } },
          files: ['services.zip'],
          sdk: SDK,
        },
      });
      assert.strictEqual(withServices.status, 201);
      const { uploads: serviceUploads } = (yield* json(withServices)) as { uploads: Record<string, unknown> };
      assert.deepStrictEqual(Object.keys(serviceUploads).toSorted(), ['manifest.json', 'services.zip']);

      const created = yield* request('/v1/apps/shop/deployments', {
        method: 'POST',
        headers: bob,
        json: {
          stage: 'prod',
          manifest: { name: 'shop', web: { server: 'src/server.ts' } },
          files: ['server.zip', 'manifest.json'],
          sdk: SDK,
          commit: 'c0ffee',
          message: 'first',
        },
      });
      assert.strictEqual(created.status, 201);
      const { deployment, uploads } = (yield* json(created)) as {
        deployment: { id: string; status: string; actor: string; commit: string; manifest: { web: object } };
        uploads: Record<string, unknown>;
      };
      assert.strictEqual(deployment.status, 'awaiting_upload');
      assert.strictEqual(deployment.actor, 'bob');
      assert.deepStrictEqual(Object.keys(uploads).toSorted(), ['manifest.json', 'server.zip']);
      assert.deepStrictEqual(deployment.manifest.web, {
        server: 'src/server.ts',
        spa: true,
        serverRoutes: ['/api/'],
        timeoutSeconds: 30,
        concurrency: 64,
        compute: 'auto',
        memoryMb: 1024,
      });

      const started = yield* request(`/v1/deployments/${deployment.id}/start`, {
        method: 'POST',
        headers: bob,
        json: {},
      });
      assert.strictEqual(started.status, 202);
      assert.strictEqual(((yield* json(started)) as { status: string }).status, 'queued');
      assert.deepStrictEqual(yield* Ref.get(jobs), [{ name: 'deploy', payload: { id: deployment.id } }]);
      const again = yield* request(`/v1/deployments/${deployment.id}/start`, {
        method: 'POST',
        headers: bob,
      });
      assert.deepStrictEqual(yield* json(again), {
        error: { code: 'already_started', message: 'deployment is queued' },
      });

      const stages = (yield* json(yield* request('/v1/apps/shop/stages', { headers: bob }))) as StageItem[];
      assert.deepStrictEqual(
        stages.map((s) => [s.stage, s.status, s.url]),
        [['prod', 'deploying', 'https://shop.example.com']],
      );

      const listed = (yield* json(
        yield* request('/v1/apps/shop/deployments?stage=prod', { headers: bob }),
      )) as Array<{
        id: string;
        events: unknown[];
        manifest?: unknown;
      }>;
      assert.deepStrictEqual(
        listed.map((d) => [d.id, d.events, d.manifest]),
        [[deployment.id, [], undefined]],
      );
      const one = (yield* json(yield* request(`/v1/deployments/${deployment.id}`, { headers: bob }))) as {
        message: string;
      };
      assert.strictEqual(one.message, 'first');
    }),
  );

  it.effect('refuses an email.dailyLimit above the platform’s limits.emailsPerDay', () =>
    Effect.gen(function* () {
      const { request, signIn } = yield* setup({
        store: memoryStore({ apps: [shop] }),
        artifacts: { uploadForms: () => Effect.succeed({}) },
      });
      const bob = yield* signIn('bob');
      const deploy = (email: unknown) =>
        request('/v1/apps/shop/deployments', {
          method: 'POST',
          headers: bob,
          json: { stage: 'prod', manifest: { name: 'shop', email }, sdk: SDK },
        });

      const over = yield* deploy({ dailyLimit: 2001 });
      assert.strictEqual(over.status, 429);
      assert.deepStrictEqual(yield* json(over), {
        error: {
          code: 'limit',
          message:
            "email.dailyLimit is 2001, above the platform's ceiling of 2000 recipients a day (limits.emailsPerDay in platform.config.ts)",
        },
      });
      assert.strictEqual((yield* deploy({ dailyLimit: 2000 })).status, 201);
      // `email: true` takes the default limit.
      const created = yield* deploy(true);
      assert.strictEqual(created.status, 201);
      assert.deepStrictEqual(
        ((yield* json(created)) as { deployment: { manifest: { email: unknown } } }).deployment.manifest
          .email,
        { dailyLimit: 200 },
      );
    }),
  );

  it.effect('destroys stages: prod only when confirmed, 200 when nothing is left', () =>
    Effect.gen(function* () {
      const jobs = yield* Ref.make<ReadonlyArray<{ name: string; payload: unknown }>>([]);
      const { request, signIn } = yield* setup({
        store: memoryStore({ apps: [shop], stages: [prodStage()] }),
        jobs,
      });
      const bob = yield* signIn('bob');

      const unconfirmed = yield* request('/v1/apps/shop/stages/prod', { method: 'DELETE', headers: bob });
      assert.deepStrictEqual(yield* json(unconfirmed), {
        error: { code: 'bad_request', message: 'destroying prod needs ?confirm=shop' },
      });

      const destroying = yield* request('/v1/apps/shop/stages/prod?confirm=shop', {
        method: 'DELETE',
        headers: bob,
      });
      assert.strictEqual(destroying.status, 202);
      assert.deepStrictEqual(yield* json(destroying), { status: 'destroying' });
      assert.deepStrictEqual(yield* Ref.get(jobs), [
        { name: 'destroy', payload: { app: 'shop', stage: 'prod' } },
      ]);

      const nothing = yield* request('/v1/apps/shop/stages/pr-4', { method: 'DELETE', headers: bob });
      assert.strictEqual(nothing.status, 200);
      assert.deepStrictEqual(yield* json(nothing), { status: 'destroyed' });
    }),
  );

  it.effect('lists stages without their routes', () =>
    Effect.gen(function* () {
      const { request, signIn } = yield* setup({
        store: memoryStore({
          apps: [shop],
          stages: [prodStage({ emailPaused: true, emailChangedAt: '2026-11-02T00:00:00.000Z' })],
        }),
      });
      const [stage] = (yield* json(
        yield* request('/v1/apps/shop/stages', { headers: yield* signIn('bob') }),
      )) as Array<Record<string, unknown>>;
      assert.deepStrictEqual(Object.keys(stage ?? {}).toSorted(), [
        'app',
        'createdAt',
        'currentDeployment',
        'host',
        'preview',
        'stage',
        'status',
        'updatedAt',
        'url',
      ]);
    }),
  );

  it.effect('rolls back on the worker, answering 409 when it refuses', () =>
    Effect.gen(function* () {
      const calls: Array<[string, unknown]> = [];
      const { request, signIn } = yield* setup({
        store: memoryStore({ apps: [shop], stages: [prodStage()] }),
        call: (name, payload) => {
          calls.push([name, payload]);
          const to = (payload as { deploymentId?: string }).deploymentId;
          return to === 'd0' || to === undefined
            ? Effect.succeed({ currentDeployment: 'd0', url: 'https://shop.example.com' })
            : Effect.fail(new WorkerJobFailed({ message: `${to} is already live` }));
        },
      });
      const bob = yield* signIn('bob');
      const ok = yield* request('/v1/apps/shop/stages/prod/rollback', {
        method: 'POST',
        headers: bob,
        json: { deploymentId: 'd0' },
      });
      assert.deepStrictEqual(yield* json(ok), { currentDeployment: 'd0', url: 'https://shop.example.com' });
      const refused = yield* request('/v1/apps/shop/stages/prod/rollback', {
        method: 'POST',
        headers: bob,
        json: { deploymentId: 'd1' },
      });
      assert.strictEqual(refused.status, 409);
      assert.deepStrictEqual(yield* json(refused), {
        error: { code: 'rollback_failed', message: 'd1 is already live' },
      });
      assert.deepStrictEqual(calls[0], ['rollback', { app: 'shop', stage: 'prod', deploymentId: 'd0' }]);
      // No body rolls back to the previous deployment.
      const previous = yield* request('/v1/apps/shop/stages/prod/rollback', { method: 'POST', headers: bob });
      assert.deepStrictEqual(yield* json(previous), {
        currentDeployment: 'd0',
        url: 'https://shop.example.com',
      });
      assert.deepStrictEqual(calls.at(-1), ['rollback', { app: 'shop', stage: 'prod' }]);
    }),
  );
});

describe('observability', () => {
  const line: LogLine = { ts: '2026-11-15T10:00:00.000Z', stream: 'web', message: 'hello' };

  it.effect('streams the log tail as server-sent events, ending with the error that stopped it', () =>
    Effect.gen(function* () {
      const { request, signIn } = yield* setup({
        store: memoryStore({ apps: [shop] }),
        logs: {
          tail: () =>
            Stream.make(line).pipe(
              Stream.concat(
                Stream.fail(
                  new AwsError({
                    code: 'ResourceNotFoundException',
                    message: 'The specified log group does not exist.',
                    cause: undefined,
                  }),
                ),
              ),
            ),
        },
      });
      const res = yield* request('/v1/apps/shop/logs/tail?stage=prod', { headers: yield* signIn('bob') });
      assert.strictEqual(res.status, 200);
      assert.match(res.headers.get('content-type') ?? '', /^text\/event-stream/);
      assert.strictEqual(
        yield* text(res),
        `event: line\ndata: ${JSON.stringify(line)}\n\n` +
          'event: error\ndata: ResourceNotFoundException: The specified log group does not exist.\n\n',
      );
    }),
  );

  it.effect('reads realtime activity for the live manifest’s namespace', () =>
    Effect.gen(function* () {
      const seen: Array<{ stage: string; realtime: unknown; res: string }> = [];
      const { request, signIn } = yield* setup({
        store: memoryStore({
          apps: [shop],
          stages: [prodStage()],
          deployments: [
            {
              id: 'd1',
              app: 'shop',
              stage: 'prod',
              status: 'succeeded',
              actor: 'bob',
              events: [],
              createdAt: '2026-11-01T00:00:00.000Z',
              manifest: {
                name: 'shop',
                auth: { enabled: false, required: false },
                db: false,
                queues: {},
                events: [],
                eventOptions: {},
                crons: {},
                storage: [],
                storageOptions: {},
                secrets: [],
                env: {},
                realtime: { subscribe: 'public', channels: ['board'] },
                services: {},
              },
            },
          ],
        }),
        realtime: {
          stats: (app, stage, realtime, range) =>
            Effect.sync(() => {
              seen.push({ stage, realtime, res: range.res });
              return {
                app,
                stage,
                enabled: true,
                subscribe: 'public' as const,
                channels: ['board'],
                res: range.res,
                totals: { events: 3, publishes: 2, subscribes: 1, errors: 0 },
                points: [],
              };
            }),
        },
      });
      const res = yield* request('/v1/apps/shop/realtime?range=1h', { headers: yield* signIn('bob') });
      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(((yield* json(res)) as { totals: unknown }).totals, {
        events: 3,
        publishes: 2,
        subscribes: 1,
        errors: 0,
      });
      assert.deepStrictEqual(seen, [
        { stage: 'prod', realtime: { subscribe: 'public', channels: ['board'] }, res: '1m' },
      ]);
    }),
  );

  it.effect('reads custom metrics for a member’s stage', () =>
    Effect.gen(function* () {
      const { request, signIn } = yield* setup({
        store: memoryStore({ apps: [shop], stages: [prodStage()] }),
        telemetry: {
          customMetrics: (app, stage, range) =>
            Effect.succeed({
              app,
              stage,
              res: range.res === '1m' ? ('1h' as const) : range.res,
              metrics: [{ name: 'signups', unit: 'count', count: 2, sum: 5, points: [] }],
            }),
        },
      });
      const res = yield* request('/v1/apps/shop/custom-metrics?range=24h', { headers: yield* signIn('bob') });
      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(yield* json(res), {
        app: 'shop',
        stage: 'prod',
        res: '1h',
        metrics: [{ name: 'signups', unit: 'count', count: 2, sum: 5, points: [] }],
      });
    }),
  );

  it.effect('shows the edge floor to admins only', () =>
    Effect.gen(function* () {
      const ranges: string[] = [];
      const { request, signIn } = yield* setup({
        edge: {
          stats: (range) =>
            Effect.sync(() => {
              ranges.push(range.res);
              return {
                enabled: true,
                state: { on: true, since: '2026-11-16T10:02:00.000Z', why: 'a flood' },
                limit: 1000,
                threshold: 1000,
                res: range.res,
                totals: { blocked: 4, allowed: 100 },
                points: [],
                samples: [],
              };
            }),
        },
      });
      const admin = yield* request('/v1/admin/edge', { headers: yield* signIn('ada') });
      assert.strictEqual(admin.status, 200);
      const body = (yield* json(admin)) as { totals: unknown; state: unknown };
      assert.deepStrictEqual(body.totals, { blocked: 4, allowed: 100 });
      assert.deepStrictEqual(body.state, { on: true, since: '2026-11-16T10:02:00.000Z', why: 'a flood' });
      // 24 hours by default.
      assert.deepStrictEqual(ranges, ['1h']);
      const member = yield* request('/v1/admin/edge', { headers: yield* signIn('bob') });
      assert.strictEqual(member.status, 403);
    }),
  );

  it.effect('reads rate limit checks for a member’s stage', () =>
    Effect.gen(function* () {
      const seen: Array<{ app: string; stage: string; res: string }> = [];
      const { request, signIn } = yield* setup({
        store: memoryStore({ apps: [shop], stages: [prodStage()] }),
        telemetry: {
          limits: (app, stage, range) =>
            Effect.sync(() => {
              seen.push({ app, stage, res: range.res });
              return {
                app,
                stage,
                res: '1h' as const,
                limits: [{ name: 'signups', allowed: 3, denied: 9, points: [] }],
              };
            }),
        },
      });
      const res = yield* request('/v1/apps/shop/limits?stage=pr-4&range=7d', {
        headers: yield* signIn('bob'),
      });
      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(yield* json(res), {
        app: 'shop',
        stage: 'pr-4',
        res: '1h',
        limits: [{ name: 'signups', allowed: 3, denied: 9, points: [] }],
      });
      assert.deepStrictEqual(seen, [{ app: 'shop', stage: 'pr-4', res: '1h' }]);
      assert.strictEqual((yield* request('/v1/apps/shop/limits')).status, 401);
    }),
  );

  it.effect('reads email for the live manifest’s tenant', () =>
    Effect.gen(function* () {
      const seen: Array<{ stage: string; email: unknown; res: string }> = [];
      const { request, signIn } = yield* setup({
        store: memoryStore({
          apps: [shop],
          stages: [prodStage()],
          deployments: [liveDeployment({ email: { name: 'Shop', dailyLimit: 300 } })],
        }),
        email: {
          stats: (app, stage, email, range) =>
            Effect.sync(() => {
              seen.push({ stage, email, res: range.res });
              return {
                app,
                stage,
                enabled: email !== undefined,
                res: range.res,
                totals: { sends: 4, deliveries: 3, bounces: 1, complaints: 0 },
                points: [],
              };
            }),
        },
      });
      const bob = yield* signIn('bob');
      const res = yield* request('/v1/apps/shop/email?range=7d', { headers: bob });
      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(((yield* json(res)) as { totals: unknown }).totals, {
        sends: 4,
        deliveries: 3,
        bounces: 1,
        complaints: 0,
      });
      // A stage that was never deployed has no manifest to declare email.
      const preview = yield* request('/v1/apps/shop/email?stage=pr-2', { headers: bob });
      assert.strictEqual(((yield* json(preview)) as { enabled: boolean }).enabled, false);
      assert.deepStrictEqual(seen, [
        { stage: 'prod', email: { name: 'Shop', dailyLimit: 300 }, res: '1h' },
        { stage: 'pr-2', email: undefined, res: '1h' },
      ]);
    }),
  );

  it.effect('shows the live deployment’s services as ECS runs them', () =>
    Effect.gen(function* () {
      const described: string[] = [];
      const { request, signIn } = yield* setup({
        store: memoryStore({
          apps: [shop],
          stages: [prodStage()],
          deployments: [
            configuredDeployment('d1', {
              services: { ais: { entry: 'src/ais.ts' }, idle: { entry: 'src/idle.ts' } },
            }),
          ],
        }),
        engine: {
          describeServices: (input) =>
            Effect.sync(() => {
              described.push(`${input.app}/${input.stage}`);
              return [
                {
                  name: 'ais',
                  desired: 1,
                  running: 1,
                  pending: 0,
                  rollout: 'completed' as const,
                  deploymentId: 'd1',
                  startedAt: '2026-11-15T09:00:00.000Z',
                  lastStop: {
                    at: '2026-11-15T08:59:00.000Z',
                    reason: 'Scaling activity initiated by (deployment ecs-svc/1)',
                    exitCode: 0,
                  },
                  events: [
                    {
                      at: '2026-11-15T09:01:00.000Z',
                      message: '(service shop--prod--ais) has reached a steady state.',
                    },
                  ],
                },
              ];
            }),
        },
        telemetry: {
          serviceRuns: () => Effect.succeed(new Map([['ais', { starts: 2, failedRuns: 1 }]])),
        },
      });
      const res = yield* request('/v1/apps/shop/services?range=1h', { headers: yield* signIn('bob') });
      assert.strictEqual(res.status, 200);
      const body = (yield* json(res)) as {
        res: string;
        services: Array<Record<string, unknown> & { points: unknown[] }>;
      };
      assert.deepStrictEqual(described, ['shop/prod']);
      assert.strictEqual(body.res, '1m');
      const [ais, idle] = body.services;
      assert.deepInclude(ais, {
        name: 'ais',
        state: 'running',
        desired: 1,
        running: 1,
        deployment: 'd1',
        starts: 2,
        failedRuns: 1,
        cpu: 0.25,
        memoryMb: 512,
        spot: true,
        monthly: { computeUsd: 2.21, publicIpv4Usd: 3.65, totalUsd: 5.86 },
      });
      // The test platform has no container compute to read metrics for.
      assert.strictEqual(ais?.points.length, 61);
      assert.deepInclude(idle, { name: 'idle', state: 'stopped', desired: 0, running: 0, starts: 0 });

      // A stage with nothing live has no services to show, and ECS isn't asked.
      const none = yield* request('/v1/apps/shop/services?stage=pr-9', { headers: yield* signIn('bob') });
      assert.deepStrictEqual(((yield* json(none)) as { services: unknown[] }).services, []);
      assert.strictEqual(described.length, 1);
    }),
  );

  it.effect('prices the services that run all the time next to the cost history', () =>
    Effect.gen(function* () {
      const estimate = {
        at: '2026-11-16T07:30:00.000Z',
        request: { monthlyUsd: 0.02, coldStartsPerMonth: 100 },
        instance: { monthlyUsd: 2.4, environmentHoursPerMonth: 40 },
        requestsPerMonth: 1000,
        days: 3,
      };
      const { request, signIn } = yield* setup({
        store: memoryStore({
          apps: [shop],
          stages: [
            prodStage({ computeEstimate: estimate }),
            prodStage({ stage: 'pr-4', preview: true, currentDeployment: 'd2' }),
            prodStage({ stage: 'staging', status: 'destroyed', currentDeployment: 'd3' }),
          ],
          deployments: [
            configuredDeployment('d1', {
              web: { server: 'src/server.ts' },
              services: { ais: { entry: 'src/ais.ts', spot: false } },
            }),
            configuredDeployment('d2', { services: { ais: { entry: 'src/ais.ts' } } }, 'pr-4'),
            configuredDeployment('d3', { services: { ais: { entry: 'src/ais.ts' } } }, 'staging'),
          ],
        }),
        telemetry: {
          cost: (app) => Effect.succeed({ app, currency: 'USD' as const, days: [], monthToDateUsd: 1.5 }),
        },
      });
      const res = yield* request('/v1/apps/shop/cost', { headers: yield* signIn('bob') });
      assert.deepStrictEqual(yield* json(res), {
        app: 'shop',
        currency: 'USD',
        days: [],
        monthToDateUsd: 1.5,
        alwaysOn: [
          {
            stage: 'prod',
            kind: 'service',
            name: 'ais',
            detail: '0.25 vCPU · 512 MB · on-demand',
            monthly: { computeUsd: 7.21, publicIpv4Usd: 3.65, totalUsd: 10.86 },
          },
        ],
        // Its server, as the route says it runs, with the chooser's estimate.
        compute: [{ stage: 'prod', setting: 'auto', compute: 'instance', estimate }],
      });
    }),
  );

  it.effect('lists and triages error groups', () =>
    Effect.gen(function* () {
      const group = {
        fingerprint: 'fp1',
        stage: 'prod',
        name: 'TypeError',
        message: 'x is undefined',
        source: 'http',
        count: 3,
        firstSeen: '2026-11-15T09:00:00.000Z',
        lastSeen: '2026-11-15T10:00:00.000Z',
        status: 'open' as const,
        sample: {},
      };
      const { request, signIn } = yield* setup({
        store: memoryStore({ apps: [shop] }),
        telemetry: {
          errors: () => Effect.succeed([group, { ...group, fingerprint: 'fp2', status: 'ignored' as const }]),
          setErrorStatus: (_app, _stage, fingerprint) => Effect.succeed(fingerprint === 'fp1'),
        },
      });
      const bob = yield* signIn('bob');
      const open = (yield* json(
        yield* request('/v1/apps/shop/errors?status=open', { headers: bob }),
      )) as Array<{
        fingerprint: string;
      }>;
      assert.deepStrictEqual(
        open.map((g) => g.fingerprint),
        ['fp1'],
      );
      const resolved = yield* request('/v1/apps/shop/errors/fp1', {
        method: 'PATCH',
        headers: bob,
        json: { status: 'resolved' },
      });
      assert.deepStrictEqual(yield* json(resolved), { status: 'resolved' });
      const missing = yield* request('/v1/apps/shop/errors/nope', {
        method: 'PATCH',
        headers: bob,
        json: { status: 'resolved' },
      });
      assert.strictEqual(missing.status, 404);
    }),
  );
});

describe('logs, traces and Logs Insights', () => {
  it.effect('passes structured filters and checks them before a tail opens', () =>
    Effect.gen(function* () {
      const seen: unknown[] = [];
      const { request, signIn } = yield* setup({
        store: memoryStore({ apps: [shop] }),
        logs: {
          search: (options) => Effect.sync(() => (seen.push(options.filters), { lines: [] })),
          tail: () => Stream.empty,
        },
      });
      const bob = yield* signIn('bob');
      const f = encodeURIComponent(JSON.stringify({ levels: ['error'], status: ['5xx'] }));
      const res = yield* request(`/v1/apps/shop/logs?f=${f}`, { headers: bob });
      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(seen, [{ levels: ['error'], status: ['5xx'] }]);

      const badRoute = encodeURIComponent(JSON.stringify({ routes: ['no-slash'] }));
      const tail = yield* request(`/v1/apps/shop/logs/tail?f=${badRoute}`, { headers: bob });
      assert.strictEqual(tail.status, 400);
      const badStream = encodeURIComponent(JSON.stringify({ streams: ['nope'] }));
      const tail2 = yield* request(`/v1/apps/shop/logs/tail?f=${badStream}`, { headers: bob });
      assert.deepStrictEqual(yield* json(tail2), {
        error: { code: 'bad_request', message: 'stream must be web, worker or service:<name>' },
      });
    }),
  );

  it.effect('reads context lines around a line, 50 each side unless asked', () =>
    Effect.gen(function* () {
      const seen: unknown[] = [];
      const { request, signIn } = yield* setup({
        store: memoryStore({ apps: [shop] }),
        logs: {
          context: ({ app: _a, ...options }) =>
            Effect.sync(() => (seen.push(options), { lines: [], anchor: 0 })),
        },
      });
      const bob = yield* signIn('bob');
      const ok = yield* request('/v1/apps/shop/logs/context?stream=web&ts=1794823200000', { headers: bob });
      assert.strictEqual(ok.status, 200);
      yield* request(
        '/v1/apps/shop/logs/context?stage=pr-1&stream=worker&ts=2026-11-16T10:00:00Z&before=0&after=200',
        {
          headers: bob,
        },
      );
      assert.deepStrictEqual(seen, [
        { stage: 'prod', stream: 'web', ts: 1794823200000, before: 50, after: 50 },
        { stage: 'pr-1', stream: 'worker', ts: Date.parse('2026-11-16T10:00:00Z'), before: 0, after: 200 },
      ]);
      const badTs = yield* request('/v1/apps/shop/logs/context?stream=web&ts=yesterday', { headers: bob });
      assert.strictEqual(badTs.status, 400);
      const tooMany = yield* request('/v1/apps/shop/logs/context?stream=web&ts=1&after=201', {
        headers: bob,
      });
      assert.deepStrictEqual(yield* json(tooMany), {
        error: { code: 'bad_request', message: 'before and after count lines, up to 200' },
      });
    }),
  );

  it.effect('runs Logs Insights on the stage the request names, over the last hour by default', () =>
    Effect.gen(function* () {
      const seen: Array<{ stage: string; query: string; span: number }> = [];
      const ops: AppRecord = { ...shop, name: 'ops', repo: 'ada/ops', owners: ['ada'], createdBy: 'ada' };
      const { request, signIn } = yield* setup({
        store: memoryStore({ apps: [shop, ops] }),
        logs: {
          insights: ({ stage, query, from, to }) =>
            Effect.sync(() => {
              seen.push({ stage, query, span: to - from });
              return {
                columns: ['n'],
                rows: [['1']],
                recordsMatched: 1,
                recordsScanned: 1,
                bytesScanned: 10,
              };
            }),
        },
      });
      const bob = yield* signIn('bob');
      const res = yield* request('/v1/apps/shop/insights', {
        method: 'POST',
        headers: bob,
        json: { stage: 'pr-1', query: 'stats count(*) as n' },
      });
      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(yield* json(res), {
        columns: ['n'],
        rows: [['1']],
        recordsMatched: 1,
        recordsScanned: 1,
        bytesScanned: 10,
      });
      assert.deepStrictEqual(seen, [{ stage: 'pr-1', query: 'stats count(*) as n', span: 3_600_000 }]);
      // Members only read their apps' logs.
      const other = yield* request('/v1/apps/ops/insights', {
        method: 'POST',
        headers: bob,
        json: { query: 'fields @message' },
      });
      assert.strictEqual(other.status, 404);
    }),
  );

  it.effect('lists traces and an error’s occurrences for the range', () =>
    Effect.gen(function* () {
      const seen: unknown[] = [];
      const { request, signIn } = yield* setup({
        store: memoryStore({ apps: [shop] }),
        logs: {
          traces: ({ filters, limit, from, to }) =>
            Effect.sync(
              () => (seen.push({ filters, limit, span: to - from }), { traces: [], truncated: false }),
            ),
          errorOccurrences: ({ fingerprint, from, to }) =>
            Effect.sync(
              () => (
                seen.push({ fingerprint, span: to - from }),
                { res: '1h' as const, timestamps: [], counts: [], revs: [] }
              ),
            ),
        },
      });
      const bob = yield* signIn('bob');
      const f = encodeURIComponent(JSON.stringify({ outcome: 'error', minMs: 500 }));
      assert.strictEqual(
        (yield* request(`/v1/apps/shop/traces?range=1h&f=${f}&limit=50`, { headers: bob })).status,
        200,
      );
      assert.strictEqual(
        (yield* request('/v1/apps/shop/errors/0a1b2c3d/occurrences', { headers: bob })).status,
        200,
      );
      assert.deepStrictEqual(seen, [
        { filters: { outcome: 'error', minMs: 500 }, limit: 50, span: 3_600_000 },
        { fingerprint: '0a1b2c3d', span: 7 * 86_400_000 },
      ]);
    }),
  );
});

describe('saved queries and dashboards', () => {
  const ops: AppRecord = { ...shop, name: 'ops', repo: 'ada/ops', owners: ['ada'], createdBy: 'ada' };
  const errorsChart = {
    kind: 'metrics',
    chart: 'line',
    queries: [{ id: 'a', metric: 'requests', stat: 'percent', filter: { status: ['5xx'] } }],
  };

  it.effect('keeps an app’s saved queries for whoever can see the app', () =>
    Effect.gen(function* () {
      const { request, signIn } = yield* setup({ store: memoryStore({ apps: [shop, ops] }) });
      const bob = yield* signIn('bob');
      const created = yield* request('/v1/apps/shop/queries', {
        method: 'POST',
        headers: bob,
        json: { name: ' 5xx rate ', view: errorsChart, range: '24h' },
      });
      assert.strictEqual(created.status, 201);
      const query = (yield* json(created)) as SavedQuery;
      assert.strictEqual(query.name, '5xx rate');
      assert.strictEqual(query.app, 'shop');
      assert.strictEqual(query.createdBy, 'bob');
      assert.match(query.id, /^q[0-9a-z]{26}$/);

      const updated = yield* request(`/v1/apps/shop/queries/${query.id}`, {
        method: 'PUT',
        headers: yield* signIn('ada'),
        json: { name: 'errors', view: { kind: 'logs', filters: { levels: ['error'] } } },
      });
      const after = (yield* json(updated)) as SavedQuery;
      assert.deepStrictEqual(
        [after.id, after.name, after.range, after.createdBy, after.view.kind],
        [query.id, 'errors', undefined, 'bob', 'logs'],
      );
      const listed = (yield* json(yield* request('/v1/apps/shop/queries', { headers: bob }))) as SavedQuery[];
      assert.deepStrictEqual(listed, [after]);

      // An app bob can't see is "not found", queries and all.
      assert.strictEqual((yield* request('/v1/apps/ops/queries', { headers: bob })).status, 404);
      const missing = yield* request('/v1/apps/shop/queries/qnope', { method: 'DELETE', headers: bob });
      assert.strictEqual(missing.status, 404);
      const removed = yield* request(`/v1/apps/shop/queries/${query.id}`, { method: 'DELETE', headers: bob });
      assert.strictEqual(removed.status, 204);
      assert.deepStrictEqual(yield* json(yield* request('/v1/apps/shop/queries', { headers: bob })), []);
    }),
  );

  it.effect('refuses views that couldn’t run, and more than 100 saved queries', () =>
    Effect.gen(function* () {
      const full = Layer.effect(
        Library,
        Effect.gen(function* () {
          const library = yield* Library;
          for (let i = 0; i < 100; i++)
            yield* library.putQuery({
              id: `q${i}`,
              app: 'shop',
              name: `q${i}`,
              view: { kind: 'logs' },
              createdBy: 'bob',
              createdAt: '2026-11-16T00:00:00.000Z',
              updatedAt: '2026-11-16T00:00:00.000Z',
            });
          return library;
        }),
      ).pipe(Layer.provide(Library.memory()));
      const { request, signIn } = yield* setup({ store: memoryStore({ apps: [shop] }), library: full });
      const bob = yield* signIn('bob');
      const save = (view: unknown) =>
        Effect.flatMap(
          request('/v1/apps/shop/queries', { method: 'POST', headers: bob, json: { name: 'x', view } }),
          json,
        );
      assert.deepStrictEqual(
        yield* save({ ...errorsChart, queries: [{ id: 'a', metric: 'jobs', stat: 'p95' }] }),
        { error: { code: 'bad_request', message: 'a: jobs answers count, rate, percent, not p95' } },
      );
      assert.deepStrictEqual(
        yield* save({ kind: 'logs', insights: 'SOURCE logGroups() | fields @message' }),
        {
          error: {
            code: 'bad_request',
            message:
              'queries run on the stage’s own log groups: SOURCE isn’t allowed (quote a field named source as `source`)',
          },
        },
      );
      assert.deepStrictEqual(yield* save({ kind: 'traces', filters: { routes: ['/x'] } }), {
        error: {
          code: 'bad_request',
          message: 'route "/x" must be METHOD /pattern, e.g. GET /api/items/:id',
        },
      });
      assert.deepStrictEqual(yield* save({ kind: 'logs' }), {
        error: { code: 'limit', message: 'an app keeps up to 100 saved queries' },
      });
    }),
  );

  it.effect('shows each member the dashboards of apps they can see, and every cross-app one', () =>
    Effect.gen(function* () {
      const { request, signIn } = yield* setup({ store: memoryStore({ apps: [shop, ops] }) });
      const bob = yield* signIn('bob');
      const ada = yield* signIn('ada');
      const widget = (id: string, x = 0) => ({ id, title: 'Errors', x, y: 0, w: 6, h: 4, view: errorsChart });
      const create = (headers: Record<string, string>, body: Record<string, unknown>) =>
        Effect.flatMap(request('/v1/dashboards', { method: 'POST', headers, json: body }), (res) =>
          Effect.map(json(res), (b) => ({ status: res.status, body: b as Dashboard })),
        );
      const across = yield* create(bob, {
        name: 'Everything',
        widgets: [widget('w1'), { ...widget('w2', 6), app: 'ops' }],
      });
      assert.strictEqual(across.status, 201);
      assert.strictEqual(across.body.app, undefined);
      const shopBoard = yield* create(bob, { name: 'Shop', app: 'shop', widgets: [] });
      const opsBoard = yield* create(ada, { name: 'Ops', app: 'ops', widgets: [] });
      assert.strictEqual((yield* create(bob, { name: 'Sneaky', app: 'ops', widgets: [] })).status, 404);

      const names = (res: unknown) => (res as Dashboard[]).map((d) => d.name);
      assert.deepStrictEqual(names(yield* json(yield* request('/v1/dashboards', { headers: bob }))), [
        'Shop',
        'Everything',
      ]);
      assert.deepStrictEqual(names(yield* json(yield* request('/v1/dashboards', { headers: ada }))), [
        'Ops',
        'Shop',
        'Everything',
      ]);
      assert.deepStrictEqual(
        names(yield* json(yield* request('/v1/dashboards?app=shop', { headers: bob }))),
        ['Shop', 'Everything'],
      );
      const hidden = yield* request(`/v1/dashboards/${opsBoard.body.id}`, { headers: bob });
      assert.deepStrictEqual(yield* json(hidden), {
        error: { code: 'not_found', message: `dashboard ${opsBoard.body.id} not found` },
      });

      // Any member edits a cross-app dashboard; the last write wins.
      const edited = yield* request(`/v1/dashboards/${across.body.id}`, {
        method: 'PUT',
        headers: ada,
        json: { name: 'Everything, edited', widgets: [] },
      });
      const after = (yield* json(edited)) as Dashboard;
      assert.deepStrictEqual(
        [after.name, after.createdBy, after.updatedBy, after.createdAt],
        ['Everything, edited', 'bob', 'ada', across.body.createdAt],
      );
      // Moving a dashboard to an app needs access to that app.
      const moved = yield* request(`/v1/dashboards/${shopBoard.body.id}`, {
        method: 'PUT',
        headers: bob,
        json: { name: 'Shop', app: 'ops', widgets: [] },
      });
      assert.strictEqual(moved.status, 404);
      assert.strictEqual(
        (yield* request(`/v1/dashboards/${opsBoard.body.id}`, { method: 'DELETE', headers: bob })).status,
        404,
      );
      assert.strictEqual(
        (yield* request(`/v1/dashboards/${shopBoard.body.id}`, { method: 'DELETE', headers: bob })).status,
        204,
      );
    }),
  );

  it.effect('refuses dashboards whose widgets overlap ids, overflow the grid or couldn’t run', () =>
    Effect.gen(function* () {
      const { request, signIn } = yield* setup({ store: memoryStore({ apps: [shop] }) });
      const bob = yield* signIn('bob');
      const widget = { id: 'w', title: '', x: 0, y: 0, w: 4, h: 4, view: { kind: 'logs' } };
      const save = (widgets: unknown[]) =>
        Effect.flatMap(
          request('/v1/dashboards', {
            method: 'POST',
            headers: bob,
            json: { name: 'd', app: 'shop', widgets },
          }),
          json,
        );
      const message = (body: unknown) => (body as { error: { message: string } }).error.message;
      assert.strictEqual(message(yield* save([widget, widget])), 'two widgets are named w');
      assert.strictEqual(
        message(yield* save([{ ...widget, x: 10 }])),
        "widget w runs past the grid's 12 columns",
      );
      assert.strictEqual(
        message(yield* save([{ ...widget, view: { kind: 'logs', filters: { revs: ['d1 or'] } } }])),
        'widget w: rev "d1 or" isn\'t a deployment id',
      );
      assert.strictEqual(
        message(
          yield* save([
            {
              ...widget,
              view: { kind: 'metrics', chart: 'line', queries: [{ id: 'a', metric: 'custom', stat: 'sum' }] },
            },
          ]),
        ),
        'widget w: a: a custom metric query names its metric, or groups by name',
      );
    }),
  );

  it.effect('deletes an app’s saved queries and dashboards with the app', () =>
    Effect.gen(function* () {
      const { request, signIn } = yield* setup({ store: memoryStore({ apps: [shop] }) });
      const bob = yield* signIn('bob');
      yield* request('/v1/apps/shop/queries', {
        method: 'POST',
        headers: bob,
        json: { name: 'q', view: { kind: 'logs' } },
      });
      yield* request('/v1/dashboards', {
        method: 'POST',
        headers: bob,
        json: { name: 'Shop', app: 'shop', widgets: [] },
      });
      yield* request('/v1/dashboards', {
        method: 'POST',
        headers: bob,
        json: { name: 'Across', widgets: [] },
      });
      assert.strictEqual((yield* request('/v1/apps/shop', { method: 'DELETE', headers: bob })).status, 204);
      yield* request('/v1/apps', { method: 'POST', headers: bob, json: { name: 'shop', repo: 'bob/shop' } });
      assert.deepStrictEqual(yield* json(yield* request('/v1/apps/shop/queries', { headers: bob })), []);
      const boards = (yield* json(yield* request('/v1/dashboards', { headers: bob }))) as Dashboard[];
      assert.deepStrictEqual(
        boards.map((d) => d.name),
        ['Across'],
      );
    }),
  );
});

describe('manage', () => {
  it.effect('lists secrets against the live manifest and sets them', () =>
    Effect.gen(function* () {
      const set: Array<[string, string, string | undefined]> = [];
      const { request, signIn } = yield* setup({
        store: memoryStore({
          apps: [shop],
          stages: [prodStage()],
          deployments: [
            {
              id: 'd1',
              app: 'shop',
              stage: 'prod',
              status: 'succeeded',
              actor: 'bob',
              events: [],
              createdAt: '2026-11-01T00:00:00.000Z',
              manifest: {
                name: 'shop',
                auth: { enabled: false, required: false },
                db: false,
                queues: {},
                events: [],
                eventOptions: {},
                crons: {},
                storage: [],
                storageOptions: {},
                secrets: ['STRIPE_KEY', 'MAIL_KEY'],
                env: {},
                services: {},
              },
            },
          ],
        }),
        secrets: {
          list: () => Effect.succeed([{ name: 'STRIPE_KEY', scope: 'shared' as const }]),
          put: (_app, name, _value, stage) =>
            Effect.sync(() => {
              set.push([name, _value, stage]);
            }),
        },
      });
      const bob = yield* signIn('bob');
      assert.deepStrictEqual(yield* json(yield* request('/v1/apps/shop/secrets', { headers: bob })), {
        secrets: [{ name: 'STRIPE_KEY', scope: 'shared' }],
        declared: ['STRIPE_KEY', 'MAIL_KEY'],
        missing: ['MAIL_KEY'],
      });

      const put = yield* request('/v1/apps/shop/secrets/MAIL_KEY?scope=shared', {
        method: 'PUT',
        headers: bob,
        json: { value: 's3cret' },
      });
      assert.strictEqual(put.status, 204);
      const staged = yield* request('/v1/apps/shop/secrets/MAIL_KEY?stage=pr-2', {
        method: 'PUT',
        headers: bob,
        json: { value: 'x' },
      });
      assert.strictEqual(staged.status, 204);
      assert.deepStrictEqual(set, [
        ['MAIL_KEY', 's3cret', undefined],
        ['MAIL_KEY', 'x', 'pr-2'],
      ]);

      const badName = yield* request('/v1/apps/shop/secrets/mail-key', {
        method: 'PUT',
        headers: bob,
        json: { value: 'x' },
      });
      assert.strictEqual(badName.status, 400);

      const cron = yield* request('/v1/apps/shop/crons/nightly/run', { method: 'POST', headers: bob });
      assert.deepStrictEqual(yield* json(cron), {
        error: { code: 'not_found', message: 'cron nightly on prod not found' },
      });
    }),
  );

  it.effect('manages the suppression list and resumes sending on stages that send email', () =>
    Effect.gen(function* () {
      const calls: Array<[string, ...unknown[]]> = [];
      const options = (manifest: Partial<ResolvedManifest>): TestServices => ({
        store: memoryStore({ apps: [shop], stages: [prodStage()], deployments: [liveDeployment(manifest)] }),
        email: {
          suppressed: (_app, stage, next) =>
            Effect.sync(() => {
              calls.push(['suppressed', stage, next]);
              return {
                items: [{ address: 'a@x.com', reason: 'bounce' as const, since: '2026-11-14T00:00:00.000Z' }],
                next: 'tok-2',
              };
            }),
          unsuppress: (_app, stage, address) =>
            Effect.sync(() => {
              calls.push(['unsuppress', stage, address]);
            }),
          resume: (_app, stage) =>
            stage === 'prod'
              ? Effect.succeed({ status: 'enabled' as const })
              : Effect.fail(new Conflict({ code: 'paused_by_aws', message: 'AWS paused sending' })),
        },
      });

      const without = yield* setup(options({}));
      const off = yield* without.request('/v1/apps/shop/email/suppressed', {
        headers: yield* without.signIn('bob'),
      });
      assert.strictEqual(off.status, 404);
      assert.deepStrictEqual(yield* json(off), {
        error: {
          code: 'not_found',
          message: "shop/prod doesn't send email: its live deployment declares no `email` in plat.config.ts",
        },
      });

      const { request, signIn } = yield* setup(options({ email: { dailyLimit: 200 } }));
      const bob = yield* signIn('bob');
      const page = yield* request('/v1/apps/shop/email/suppressed?next=tok-1', { headers: bob });
      assert.deepStrictEqual(yield* json(page), {
        items: [{ address: 'a@x.com', reason: 'bounce', since: '2026-11-14T00:00:00.000Z' }],
        next: 'tok-2',
      });
      const removed = yield* request('/v1/apps/shop/email/suppressed/a%40x.com', {
        method: 'DELETE',
        headers: bob,
      });
      assert.strictEqual(removed.status, 204);
      const invalid = yield* request('/v1/apps/shop/email/suppressed/not-an-address', {
        method: 'DELETE',
        headers: bob,
      });
      assert.deepStrictEqual(yield* json(invalid), {
        error: { code: 'bad_request', message: '"not-an-address" is not an email address' },
      });
      const resumed = yield* request('/v1/apps/shop/email/resume', { method: 'POST', headers: bob });
      assert.deepStrictEqual(yield* json(resumed), { status: 'enabled' });
      assert.deepStrictEqual(calls, [
        ['suppressed', 'prod', 'tok-1'],
        ['unsuppress', 'prod', 'a@x.com'],
      ]);

      // Previews have no live deployment here, so they don't send email.
      const preview = yield* request('/v1/apps/shop/email/resume?stage=pr-2', {
        method: 'POST',
        headers: bob,
      });
      assert.strictEqual(preview.status, 404);
    }),
  );

  it.effect('answers 409 when only AWS can resume a stage’s email', () =>
    Effect.gen(function* () {
      const { request, signIn } = yield* setup({
        store: memoryStore({
          apps: [shop],
          stages: [prodStage()],
          deployments: [liveDeployment({ email: { dailyLimit: 200 } })],
        }),
        email: {
          resume: () => Effect.fail(new Conflict({ code: 'paused_by_aws', message: 'AWS paused sending' })),
        },
      });
      const res = yield* request('/v1/apps/shop/email/resume', {
        method: 'POST',
        headers: yield* signIn('bob'),
      });
      assert.strictEqual(res.status, 409);
      assert.deepStrictEqual(yield* json(res), {
        error: { code: 'paused_by_aws', message: 'AWS paused sending' },
      });
    }),
  );

  it.effect('lists stores with the public ones, and browses each where its files are', () =>
    Effect.gen(function* () {
      const asked: Array<{ store: string; public: boolean }> = [];
      const { request, signIn } = yield* setup({
        store: memoryStore({
          apps: [shop],
          stages: [prodStage()],
          deployments: [
            {
              id: 'd1',
              app: 'shop',
              stage: 'prod',
              status: 'succeeded',
              actor: 'bob',
              events: [],
              createdAt: '2026-11-01T00:00:00.000Z',
              manifest: parseManifest({
                name: 'shop',
                storage: { uploads: {}, snapshots: { public: true } },
              }),
            },
          ],
        }),
        data: {
          storage: (o) =>
            Effect.sync(() => {
              asked.push({ store: o.store, public: o.public });
              return { objects: [] };
            }),
          downloadUrl: (o) =>
            Effect.succeed(`https://s3.example/${o.public ? 'public' : 'private'}/${o.key}`),
        },
      });
      const bob = yield* signIn('bob');
      assert.deepStrictEqual(yield* json(yield* request('/v1/apps/shop/storage', { headers: bob })), {
        stores: ['uploads', 'snapshots'],
        public: ['snapshots'],
      });
      yield* request('/v1/apps/shop/storage?store=snapshots', { headers: bob });
      yield* request('/v1/apps/shop/storage?store=uploads', { headers: bob });
      assert.deepStrictEqual(asked, [
        { store: 'snapshots', public: true },
        { store: 'uploads', public: false },
      ]);
      assert.deepStrictEqual(
        yield* json(yield* request('/v1/apps/shop/storage/url?store=snapshots&key=a.json', { headers: bob })),
        { url: 'https://s3.example/public/a.json' },
      );
    }),
  );
  it.effect('starts, stops and restarts services the live deployment declares', () =>
    Effect.gen(function* () {
      const calls: Array<Pick<ControlServiceInput, 'stage' | 'name' | 'action' | 'minutes'>> = [];
      const ais = { services: { ais: { entry: 'src/ais.ts', previewMinutes: 0 } } };
      const { request, signIn } = yield* setup({
        store: memoryStore({
          apps: [shop],
          stages: [prodStage(), prodStage({ stage: 'pr-4', preview: true, currentDeployment: 'd2' })],
          deployments: [configuredDeployment('d1', ais), configuredDeployment('d2', ais, 'pr-4')],
        }),
        engine: {
          controlService: ({ stage, name, action, minutes }) =>
            Effect.suspend(() => {
              calls.push({ stage, name, action, minutes });
              if (stage === 'prod' && action === 'restart')
                return Effect.fail(new DeployFailed({ message: 'service shop--prod--ais is draining' }));
              return Effect.succeed(
                action === 'stop'
                  ? { desired: 0 }
                  : { desired: 1, ...(minutes ? { stopsAt: '2026-11-16T12:30:00.000Z' } : {}) },
              );
            }),
        },
      });
      const bob = yield* signIn('bob');
      const post = (path: string, body?: unknown) =>
        request(path, { method: 'POST', headers: bob, ...(body ? { json: body } : {}) });

      const start = yield* post('/v1/apps/shop/services/ais/start', {});
      assert.strictEqual(start.status, 202);
      assert.deepStrictEqual(yield* json(start), { name: 'ais', desired: 1 });
      const timed = yield* post('/v1/apps/shop/services/ais/start', { minutes: 90 });
      assert.deepStrictEqual(yield* json(timed), {
        name: 'ais',
        desired: 1,
        stopsAt: '2026-11-16T12:30:00.000Z',
      });
      // Previews always stop again: after previewMinutes, or 30 when that is 0.
      yield* post('/v1/apps/shop/services/ais/start?stage=pr-4', {});
      const stop = yield* post('/v1/apps/shop/services/ais/stop?stage=pr-4');
      assert.deepStrictEqual(yield* json(stop), { name: 'ais', desired: 0 });
      assert.deepStrictEqual(calls, [
        { stage: 'prod', name: 'ais', action: 'start', minutes: undefined },
        { stage: 'prod', name: 'ais', action: 'start', minutes: 90 },
        { stage: 'pr-4', name: 'ais', action: 'start', minutes: 30 },
        { stage: 'pr-4', name: 'ais', action: 'stop', minutes: undefined },
      ]);

      const refused = yield* post('/v1/apps/shop/services/ais/restart');
      assert.strictEqual(refused.status, 409);
      assert.deepStrictEqual(yield* json(refused), {
        error: { code: 'service_action_failed', message: 'service shop--prod--ais is draining' },
      });
      const undeclared = yield* post('/v1/apps/shop/services/feeds/restart');
      assert.strictEqual(undeclared.status, 404);
      assert.deepStrictEqual(yield* json(undeclared), {
        error: { code: 'not_found', message: 'service feeds on prod not found' },
      });
      assert.strictEqual(calls.length, 5);
    }),
  );
});
