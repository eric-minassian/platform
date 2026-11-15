import {
  APPSYNC_SUBPROTOCOL,
  newDeploymentId,
  parseManifest,
  type RealtimeEdgeEntry,
} from '@ericminassian/platform-core';
import { createEngine, ensureLocalPlatform } from '@ericminassian/platform-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setBindings } from '../../src/runtime/bindings.ts';
import { realtime } from '../../src/runtime/realtime.ts';
import { resetPlatform } from '../../src/testing.ts';

// A stage deployed by the engine into the emulator (its Event API and the
// stage's channel namespace), then the SDK publishing to a WebSocket
// subscriber, as a browser would through the router.
const region = process.env.AWS_REGION ?? 'us-east-1';
const APP = `rt${Date.now().toString(36)}`;
let entry: RealtimeEdgeEntry;
let namespace = '';

const b64url = (s: string) => Buffer.from(s).toString('base64url');

/** Subscribes like the browser client and collects events until `count` arrive. */
function subscriber(channel: string) {
  const auth = { host: entry.h, 'x-api-key': entry.k };
  const ws = new WebSocket(`ws://${entry.o}/event/realtime`, [
    APPSYNC_SUBPROTOCOL,
    `header-${b64url(JSON.stringify(auth))}`,
  ]);
  const events: unknown[] = [];
  const subscribed = new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'connection_init' })));
    ws.addEventListener('error', () => reject(new Error('WebSocket error')));
    ws.addEventListener('message', (m) => {
      const msg = JSON.parse(String(m.data)) as { type: string; event?: string };
      if (msg.type === 'connection_ack')
        ws.send(
          JSON.stringify({
            type: 'subscribe',
            id: 's1',
            channel: `/${namespace}/${channel}`,
            authorization: auth,
          }),
        );
      else if (msg.type === 'subscribe_success') resolve();
      else if (msg.type === 'subscribe_error') reject(new Error(JSON.stringify(msg)));
      else if (msg.type === 'data') events.push(JSON.parse(msg.event!));
    });
  });
  const received = async (count: number) => {
    for (let i = 0; i < 100 && events.length < count; i++) await new Promise((r) => setTimeout(r, 50));
    return events;
  };
  return { subscribed, received, close: () => ws.close() };
}

beforeAll(async () => {
  const endpoint = process.env.AWS_ENDPOINT_URL;
  const caFile = process.env.NODE_EXTRA_CA_CERTS;
  if (!endpoint || !caFile) throw new Error('integration tests need the AWS Emulator (see setup.ts)');
  const engine = createEngine({
    region,
    emulator: {
      endpoint,
      caFile,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
      },
    },
  });
  const platform = await ensureLocalPlatform(engine, { port: 3999, jwksBaseUrl: endpoint });
  const deployed = await engine.deployStage({
    manifest: parseManifest({
      name: APP,
      realtime: { channels: { board: {}, 'boards/*': {} } },
    }),
    stage: 'test',
    deploymentId: newDeploymentId(),
    platform,
    artifacts: {},
    webMode: 'external',
    logRetentionDays: 1,
  });
  setBindings(deployed.bindings);
  namespace = deployed.bindings.realtime!.namespace;
  entry = (await engine.ensureRealtimePlatform(platform))!;
});

afterAll(() => resetPlatform());

describe('realtime against the AWS Emulator', () => {
  it('delivers what the SDK publishes to a subscriber with the public key', async () => {
    const sub = subscriber('boards/b1');
    await sub.subscribed;
    await realtime.publish('boards/b1', { n: 1, at: new Date(0) });
    await realtime.publishMany('boards/b1', [{ n: 2 }, { n: 3 }, { n: 4 }, { n: 5 }, { n: 6 }, { n: 7 }]);
    // Another channel isn't delivered to this subscription.
    await realtime.publish('board', { other: true });
    expect(await sub.received(7)).toEqual([
      { n: 1, at: '1970-01-01T00:00:00.000Z' },
      { n: 2 },
      { n: 3 },
      { n: 4 },
      { n: 5 },
      { n: 6 },
      { n: 7 },
    ]);
    sub.close();
  });

  it('refuses channels the stage did not declare before calling AppSync', async () => {
    await expect(realtime.publish('elsewhere' as 'board', {})).rejects.toThrow(/isn't declared/);
  });
});
