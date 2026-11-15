import { names, type RealtimeClaims, signRealtimeToken } from '@ericminassian/platform-core';
import { describe, expect, it } from 'vitest';
import { type AuthorizerEvent, createAuthorizer, ssmStageKeys } from '../src/realtime-authorizer.ts';

const now = 1_800_000_000;
const keys: Record<string, string> = {
  'notes/prod': Buffer.alloc(32, 1).toString('base64url'),
  'notes/pr-4': Buffer.alloc(32, 2).toString('base64url'),
};
const lookups: string[] = [];
const authorize = createAuthorizer({
  stageKey: async (app, stage) => {
    lookups.push(`${app}/${stage}`);
    return keys[`${app}/${stage}`];
  },
  nowSeconds: () => now,
});

const token = (c: Partial<RealtimeClaims> = {}, key = keys['notes/prod']!) =>
  signRealtimeToken(key, { a: 'notes', s: 'prod', u: 'user-1', e: now + 900, ...c });

const event = (
  authorizationToken: string,
  operation: 'EVENT_CONNECT' | 'EVENT_SUBSCRIBE' | 'EVENT_PUBLISH',
  channel?: string,
): AuthorizerEvent => {
  const ns = channel?.split('/')[1] ?? null;
  return {
    authorizationToken,
    requestContext: { apiId: 'api1', operation, channelNamespaceName: ns, channel: channel ?? null },
  };
};

describe('realtime authorizer', () => {
  it("lets a signed-in user connect and subscribe in their stage's namespace", async () => {
    const t = await token();
    expect(await authorize(event(t, 'EVENT_CONNECT'))).toEqual({ isAuthorized: true, ttlOverride: 900 });
    expect(await authorize(event(t, 'EVENT_SUBSCRIBE', '/notes--prod/board'))).toEqual({
      isAuthorized: true,
      ttlOverride: 900,
    });
    expect(
      (await authorize(event(t, 'EVENT_SUBSCRIBE', '/notes--prod/user/user-1/inbox'))).isAuthorized,
    ).toBe(true);
  });

  it("keeps other users' channels, other stages and publishing out", async () => {
    const t = await token();
    for (const e of [
      event(t, 'EVENT_SUBSCRIBE', '/notes--prod/user/user-2'),
      event(t, 'EVENT_SUBSCRIBE', '/notes--prod/*'),
      event(t, 'EVENT_SUBSCRIBE', '/notes--pr-4/board'),
      event(t, 'EVENT_PUBLISH', '/notes--prod/board'),
    ])
      expect(await authorize(e)).toEqual({ isAuthorized: false, ttlOverride: 900 });
  });

  it('caps the cached answer at an hour', async () => {
    const t = await token({ e: now + 86_400 });
    expect((await authorize(event(t, 'EVENT_CONNECT'))).ttlOverride).toBe(3600);
  });

  it('refuses expired, forged, unknown-stage and malformed tokens briefly', async () => {
    const refused = { isAuthorized: false, ttlOverride: 60 };
    expect(await authorize(event(await token({ e: now - 1 }), 'EVENT_CONNECT'))).toEqual(refused);
    // Signed with another stage's key but claiming prod.
    expect(await authorize(event(await token({}, keys['notes/pr-4']), 'EVENT_CONNECT'))).toEqual(refused);
    expect(await authorize(event(await token({ s: 'pr-9' }), 'EVENT_CONNECT'))).toEqual(refused);
    expect(await authorize(event('pt1.e30.x', 'EVENT_CONNECT'))).toEqual(refused);
    expect(await authorize({})).toEqual(refused);
  });

  it('never looks up a key for names that are not app and stage names', async () => {
    lookups.length = 0;
    const t = await token({ a: '../../config', s: 'prod' });
    expect((await authorize(event(t, 'EVENT_CONNECT'))).isAuthorized).toBe(false);
    expect(lookups).toEqual([]);
  });
});

describe('stage keys from SSM', () => {
  function fakeSsm(values: Record<string, string>) {
    const calls: Array<{ Name: string; WithDecryption: boolean }> = [];
    const ssm = {
      send: async (cmd: { input: { Name: string; WithDecryption: boolean } }) => {
        calls.push(cmd.input);
        const value = values[cmd.input.Name];
        if (value === undefined) throw Object.assign(new Error('nope'), { name: 'ParameterNotFound' });
        return { Parameter: { Value: value } };
      },
    };
    return { ssm: ssm as never, calls };
  }

  it('decrypts each stage key once per few minutes, and remembers missing ones too', async () => {
    let clock = 0;
    const { ssm, calls } = fakeSsm({ [names.stageKeyParameter('notes', 'prod')]: 'k1' });
    const read = ssmStageKeys(ssm, () => clock);
    expect(await read('notes', 'prod')).toBe('k1');
    expect(await read('notes', 'prod')).toBe('k1');
    expect(await read('gone', 'prod')).toBeUndefined();
    expect(await read('gone', 'prod')).toBeUndefined();
    expect(calls).toEqual([
      { Name: '/platform/apps/notes/prod/stage-key', WithDecryption: true },
      { Name: '/platform/apps/gone/prod/stage-key', WithDecryption: true },
    ]);
    clock = 5 * 60_000;
    await read('notes', 'prod');
    expect(calls).toHaveLength(3);
  });

  it('lets other SSM failures through, so AppSync refuses without caching', async () => {
    const read = ssmStageKeys({
      send: async () => {
        throw Object.assign(new Error('throttled'), { name: 'ThrottlingException' });
      },
    } as never);
    await expect(read('notes', 'prod')).rejects.toThrow('throttled');
  });
});
