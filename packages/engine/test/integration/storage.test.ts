import { ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3';
import {
  names,
  newDeploymentId,
  type PlatformRuntimeConfig,
  parseManifest,
} from '@ericminassian/platform-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createEngine,
  type EmulatorConnection,
  type Engine,
  engineContext,
  ensureLocalPlatform,
  findEmulatorBinary,
  startEmulator,
} from '../../src/index.ts';

const app = 'files';
const stage = 'itest2';
const storage = { uploads: {}, snapshots: { public: true, expireAfterDays: 2 } };
const DAY = 86_400_000;

describe.skipIf(!findEmulatorBinary() && !process.env.PLAT_EMULATOR_ENDPOINT)(
  'public stores on the AWS Emulator',
  () => {
    let conn: EmulatorConnection;
    let engine: Engine;
    let platform: PlatformRuntimeConfig;

    beforeAll(async () => {
      conn = await startEmulator({ idleTimeoutSeconds: 600 });
      engine = createEngine({
        region: conn.region,
        emulator: { endpoint: conn.endpoint, caFile: conn.caFile, credentials: conn.credentials },
      });
      platform = await ensureLocalPlatform(engine, { port: 3000, jwksBaseUrl: conn.endpoint });
    });

    afterAll(async () => {
      await conn?.stop();
    });

    const deploy = (stores: Record<string, { public?: boolean; expireAfterDays?: number }>) =>
      engine.deployStage({
        manifest: parseManifest({ name: app, storage: stores }),
        stage,
        deploymentId: newDeploymentId(),
        platform,
        artifacts: {},
        webMode: 'external',
      });

    const put = (key: string) =>
      engineContext(engine).clients.s3.send(
        new PutObjectCommand({ Bucket: platform.storageBucket, Key: key, Body: 'x' }),
      );

    const keys = async (prefix: string) => {
      const res = await engineContext(engine).clients.s3.send(
        new ListObjectsV2Command({ Bucket: platform.storageBucket, Prefix: prefix }),
      );
      return (res.Contents ?? []).map((o) => o.Key!.slice(prefix.length)).toSorted();
    };

    it('binds public stores to their own prefix', async () => {
      const result = await deploy(storage);
      expect(result.bindings.storage).toEqual({
        bucket: platform.storageBucket,
        prefix: 'files/itest2/',
        stores: ['uploads', 'snapshots'],
        public: ['snapshots'],
        publicPrefix: '_public/files/itest2/',
      });
    });

    it('deletes files their store keeps for fewer days than they have gone unwritten', async () => {
      const pub = names.publicStoragePrefix(app, stage, 'snapshots');
      const priv = names.storagePrefix(app, stage, 'uploads');
      await Promise.all([put(`${pub}a.json`), put(`${pub}b/c.json`), put(`${priv}kept.png`)]);
      const manifest = parseManifest({ name: app, storage });

      expect(
        await engine.expireStorage({ app, stage, platform, manifest, now: new Date(Date.now() + DAY) }),
      ).toEqual({ snapshots: 0 });
      expect(await keys(pub)).toEqual(['a.json', 'b/c.json']);

      expect(
        await engine.expireStorage({ app, stage, platform, manifest, now: new Date(Date.now() + 3 * DAY) }),
      ).toEqual({ snapshots: 2 });
      expect(await keys(pub)).toEqual([]);
      expect(await keys(priv)).toEqual(['kept.png']);
    });

    it('refuses to make a store with files public', async () => {
      await expect(deploy({ ...storage, uploads: { public: true } })).rejects.toThrow(
        /store "uploads" has files from when it was private/,
      );
      // An empty store can switch.
      const result = await deploy({ ...storage, avatars: { public: true } });
      expect(result.bindings.storage?.public).toEqual(['snapshots', 'avatars']);
    });

    it('deletes both prefixes when the stage is destroyed', async () => {
      await put(`${names.publicStoragePrefix(app, stage, 'avatars')}me.png`);
      await engine.destroyStage({ app, stage, platform });
      expect(await keys(names.storagePrefix(app, stage))).toEqual([]);
      expect(await keys(names.publicStoragePrefix(app, stage))).toEqual([]);
    });
  },
);
