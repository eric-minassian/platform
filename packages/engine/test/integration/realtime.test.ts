import { createHash, createHmac } from 'node:crypto';
import { GetChannelNamespaceCommand } from '@aws-sdk/client-appsync';
import { GetRolePolicyCommand } from '@aws-sdk/client-iam';
import {
  APPSYNC_SUBPROTOCOL,
  channelPath,
  names,
  newDeploymentId,
  type PlatformRuntimeConfig,
  parseManifest,
  realtimeEndpoints,
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

const app = 'rtest';
const stage = 'rt1';
const web = { server: 'src/server.ts' };
const publicManifest = parseManifest({
  name: app,
  web,
  realtime: { channels: { board: {}, 'boards/*': {} } },
});
const signedInManifest = parseManifest({
  name: app,
  web,
  auth: true,
  realtime: { subscribe: 'signed-in', channels: { 'user/*': {} } },
});

/** SigV4 for AppSync's HTTP publish (what the SDK does with the stage role). */
function signedPublish(
  url: string,
  body: string,
  creds: { accessKeyId: string; secretAccessKey: string },
  region: string,
): RequestInit {
  const u = new URL(url);
  const now = new Date().toISOString().replace(/[-:]|\.\d{3}/g, '');
  const date = now.slice(0, 8);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    host: u.host,
    'x-amz-date': now,
  };
  const signed = Object.keys(headers).sort();
  const hash = (s: string) => createHash('sha256').update(s).digest('hex');
  const canonical = [
    'POST',
    u.pathname,
    '',
    signed.map((h) => `${h}:${headers[h]}\n`).join(''),
    signed.join(';'),
    hash(body),
  ].join('\n');
  const scope = `${date}/${region}/appsync/aws4_request`;
  let key = createHmac('sha256', `AWS4${creds.secretAccessKey}`).update(date).digest();
  for (const part of [region, 'appsync', 'aws4_request'])
    key = createHmac('sha256', key).update(part).digest();
  const signature = createHmac('sha256', key)
    .update(['AWS4-HMAC-SHA256', now, scope, hash(canonical)].join('\n'))
    .digest('hex');
  const { host: _host, ...rest } = headers;
  return {
    method: 'POST',
    body,
    headers: {
      ...rest,
      authorization: `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signed.join(';')}, Signature=${signature}`,
    },
  };
}

/** Subscribe to `channel` with the API key and resolve with the first event's payload. */
function firstEvent(websocketUrl: string, host: string, apiKey: string, channel: string) {
  const auth = { host, 'x-api-key': apiKey };
  const header = Buffer.from(JSON.stringify(auth)).toString('base64url');
  const ws = new WebSocket(websocketUrl, [APPSYNC_SUBPROTOCOL, `header-${header}`]);
  let onSubscribed!: () => void;
  const subscribed = new Promise<void>((resolve) => {
    onSubscribed = resolve;
  });
  const event = new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no event within 20 s')), 20_000);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'connection_init' }));
    ws.onerror = () => reject(new Error('WebSocket error'));
    ws.onmessage = (m) => {
      const msg = JSON.parse(String(m.data)) as { type: string; event?: string };
      if (msg.type === 'connection_ack')
        ws.send(JSON.stringify({ type: 'subscribe', id: 's1', channel, authorization: auth }));
      else if (msg.type === 'subscribe_success') onSubscribed();
      else if (msg.type === 'data') {
        clearTimeout(timer);
        ws.close();
        // AppSync sends each event as one JSON string.
        resolve(JSON.parse(msg.event!));
      } else if (msg.type !== 'ka') reject(new Error(`unexpected ${m.data}`));
    };
  });
  return { subscribed, event };
}

describe.skipIf(!findEmulatorBinary() && !process.env.PLAT_EMULATOR_ENDPOINT)(
  'realtime stages on the AWS Emulator',
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

    const deploy = (manifest = publicManifest) =>
      engine.deployStage({
        manifest,
        stage,
        deploymentId: newDeploymentId(),
        platform,
        artifacts: {},
        webMode: 'external',
      });

    const namespace = () =>
      engineContext(engine)
        .clients.appsync.send(
          new GetChannelNamespaceCommand({
            apiId: platform.realtime!.apiId,
            name: names.realtimeNamespace(app, stage),
          }),
        )
        .then((r) => r.channelNamespace);

    it('creates the platform Event API once', async () => {
      expect(platform.realtime?.httpDomain).toMatch(/^127\.0\.0\.1:\d+$/);
      const again = await ensureLocalPlatform(engine, { port: 3000, jwksBaseUrl: conn.endpoint });
      expect(again.realtime).toEqual(platform.realtime);
    });

    it('keeps one public key and reports the router entry', async () => {
      const entry = await engine.ensureRealtimePlatform(platform);
      expect(entry).toEqual({
        v: 1,
        o: platform.realtime!.realtimeDomain,
        h: platform.realtime!.httpDomain,
        k: expect.stringMatching(/^da2-/),
      });
      expect((await engine.ensureRealtimePlatform(platform))?.k).toBe(entry?.k);
    });

    it('gives a stage a namespace its role can publish to, and delivers to API-key subscribers', async () => {
      const result = await deploy();
      const { publishUrl, websocketUrl } = realtimeEndpoints(platform, platform.realtime!);
      expect(result.bindings.realtime).toEqual({
        namespace: 'rtest--rt1',
        publishUrl,
        subscribe: 'public',
        channels: ['board', 'boards/*'],
      });
      const ns = await namespace();
      expect(ns?.subscribeAuthModes).toEqual([{ authType: 'API_KEY' }]);
      expect(ns?.publishAuthModes).toEqual([{ authType: 'AWS_IAM' }]);

      const policy = await engineContext(engine).clients.iam.send(
        new GetRolePolicyCommand({ RoleName: names.role(app, stage), PolicyName: 'runtime' }),
      );
      expect(decodeURIComponent(policy.PolicyDocument!)).toContain(
        `apis/${platform.realtime!.apiId}/channelNamespace/rtest--rt1`,
      );

      const entry = await engine.ensureRealtimePlatform(platform);
      const sub = firstEvent(websocketUrl, entry!.h, entry!.k, channelPath('rtest--rt1', 'boards/*'));
      await sub.subscribed;
      const body = JSON.stringify({
        channel: channelPath('rtest--rt1', 'boards/b1'),
        events: [JSON.stringify({ stroke: 1 })],
      });
      const res = await fetch(publishUrl, signedPublish(publishUrl, body, conn.credentials, conn.region));
      expect(res.status).toBe(200);
      expect(await sub.event).toEqual({ stroke: 1 });

      expect((await engine.listStageResources(app, stage)).map((r) => `${r.type}:${r.name}`)).toContain(
        'channel-namespace:rtest--rt1',
      );
    });

    it('switches subscribers to tokens when the stage turns signed-in', async () => {
      const result = await deploy(signedInManifest);
      expect(result.bindings.realtime?.subscribe).toBe('signed-in');
      expect((await namespace())?.subscribeAuthModes).toEqual([{ authType: 'AWS_LAMBDA' }]);
    });

    it('deletes the namespace when realtime leaves the config', async () => {
      const result = await deploy(parseManifest({ name: app, web }));
      expect(result.bindings.realtime).toBeUndefined();
      expect(await namespace().catch((e: Error) => e.name)).toBe('NotFoundException');
    });

    it('deletes it with the stage', async () => {
      await deploy();
      await engine.destroyStage({ app, stage, platform });
      expect(await engine.listStageResources(app, stage)).toEqual([]);
    });
  },
);
