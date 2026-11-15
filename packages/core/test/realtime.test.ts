import { describe, expect, it } from 'vitest';
import {
  authorizeRealtime,
  CHANNEL_DECLARATION_PATTERN,
  canSubscribe,
  channelMatches,
  declaredChannel,
  isChannel,
  isSubscription,
  type ManifestError,
  names,
  parseManifest,
  peekRealtimeToken,
  type RealtimeClaims,
  realtimeEndpoints,
  signRealtimeToken,
  verifyRealtimeToken,
} from '../src/index.ts';

const stageKey = Buffer.alloc(32, 7).toString('base64url');
const otherKey = Buffer.alloc(32, 8).toString('base64url');
const now = 1_800_000_000;
const claims: RealtimeClaims = { a: 'draw', s: 'prod', u: 'user-1', e: now + 600 };

describe('channels', () => {
  it('accepts 1-4 lowercase segments and declared wildcards', () => {
    expect(isChannel('board')).toBe(true);
    expect(isChannel('boards/b-1/strokes/x2')).toBe(true);
    expect(isChannel('a/b/c/d/e')).toBe(false); // the namespace is AppSync's fifth segment
    expect(isChannel('Board')).toBe(false);
    expect(isChannel('tile_3')).toBe(false); // AppSync has no underscores
    expect(isChannel('-x')).toBe(false);
    expect(isChannel('boards/*')).toBe(false);
    expect(isChannel(`${'a'.repeat(50)}`)).toBe(true);
    expect(isChannel(`${'a'.repeat(51)}`)).toBe(false);

    expect(CHANNEL_DECLARATION_PATTERN.test('boards/*')).toBe(true);
    expect(CHANNEL_DECLARATION_PATTERN.test('a/b/c/*')).toBe(true);
    expect(CHANNEL_DECLARATION_PATTERN.test('a/b/c/d/*')).toBe(false);
    expect(CHANNEL_DECLARATION_PATTERN.test('*')).toBe(false);
    expect(CHANNEL_DECLARATION_PATTERN.test('a/*/b')).toBe(false);
    expect(isSubscription('boards/*')).toBe(true);
  });

  it('matches channels and wildcard subscriptions to declarations', () => {
    expect(channelMatches('board', 'board')).toBe(true);
    expect(channelMatches('board', 'board/x')).toBe(false);
    expect(channelMatches('boards/*', 'boards/b1')).toBe(true);
    expect(channelMatches('boards/*', 'boards/b1/cursors')).toBe(true);
    expect(channelMatches('boards/*', 'boards/*')).toBe(true);
    expect(channelMatches('boards/*', 'boards')).toBe(false);
    expect(channelMatches('boards/*', 'boardsx/1')).toBe(false);
    expect(declaredChannel(['board', 'boards/*'], 'boards/7')).toBe('boards/*');
    expect(declaredChannel(['board'], 'other')).toBeUndefined();
  });

  it('keeps user channels private to their user', () => {
    expect(canSubscribe('u1', 'board')).toBe(true);
    expect(canSubscribe('u1', 'boards/*')).toBe(true);
    expect(canSubscribe('u1', 'user/u1')).toBe(true);
    expect(canSubscribe('u1', 'user/u1/notices')).toBe(true);
    expect(canSubscribe('u1', 'user/u1/*')).toBe(true);
    expect(canSubscribe('u1', 'user/u2')).toBe(false);
    expect(canSubscribe('u1', 'user/*')).toBe(false);
    expect(canSubscribe('u1', 'user')).toBe(false);
    expect(canSubscribe('u1', '*')).toBe(false);
    expect(canSubscribe('u1', 'Board')).toBe(false);
  });

  it('hashes namespaces that would exceed AppSync’s 50 characters', () => {
    expect(names.realtimeNamespace('draw', 'prod')).toBe('draw--prod');
    const long = names.realtimeNamespace('a'.repeat(30), 'b'.repeat(20));
    expect(long.length).toBe(50);
    expect(long).toMatch(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,48}[A-Za-z0-9])?$/);
    expect(names.realtimeNamespace('a'.repeat(30), 'c'.repeat(20))).not.toBe(long);
  });

  it('builds publish and WebSocket URLs for AWS and the emulator', () => {
    const rt = { apiId: 'x', httpDomain: 'h.example', realtimeDomain: 'r.example' };
    expect(realtimeEndpoints({ target: 'aws' }, rt)).toEqual({
      publishUrl: 'https://h.example/event',
      websocketUrl: 'wss://r.example/event/realtime',
    });
    expect(realtimeEndpoints({ target: 'emulator' }, rt).websocketUrl).toBe('ws://r.example/event/realtime');
  });
});

describe('subscribe tokens', () => {
  it('round-trips claims signed with the stage key', async () => {
    const token = await signRealtimeToken(stageKey, claims);
    expect(token).toMatch(/^pt1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(peekRealtimeToken(token)).toEqual(claims);
    expect(await verifyRealtimeToken(stageKey, token, now)).toEqual(claims);
  });

  it('rejects other keys, edits, expiry and junk', async () => {
    const token = await signRealtimeToken(stageKey, claims);
    expect(await verifyRealtimeToken(otherKey, token, now)).toBeUndefined();
    expect(await verifyRealtimeToken(stageKey, token, claims.e)).toBeUndefined();
    const [p, body, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...claims, u: 'user-2' })).toString('base64url');
    expect(await verifyRealtimeToken(stageKey, `${p}.${forged}.${sig}`, now)).toBeUndefined();
    expect(await verifyRealtimeToken(stageKey, `${p}.${body}.AAAA`, now)).toBeUndefined();
    expect(await verifyRealtimeToken(stageKey, 'pt1.e30.x', now)).toBeUndefined();
    expect(peekRealtimeToken('nope')).toBeUndefined();
    expect(peekRealtimeToken('pt1.!!.x')).toBeUndefined();
  });
});

describe('authorizeRealtime', () => {
  const base = { claims, namespace: 'draw--prod' };
  it('lets a valid token connect and subscribe in its own namespace', () => {
    expect(
      authorizeRealtime({ ...base, operation: 'EVENT_CONNECT', channelNamespace: null, channel: null }),
    ).toBe(true);
    const sub = (channelNamespace: string, channel: string) =>
      authorizeRealtime({ ...base, operation: 'EVENT_SUBSCRIBE', channelNamespace, channel });
    expect(sub('draw--prod', '/draw--prod/board')).toBe(true);
    expect(sub('draw--prod', '/draw--prod/boards/*')).toBe(true);
    expect(sub('draw--prod', '/draw--prod/user/user-1/notices')).toBe(true);
    expect(sub('draw--prod', '/draw--prod/user/user-2')).toBe(false);
    expect(sub('draw--prod', '/draw--prod/*')).toBe(false);
    expect(sub('draw--pr-1', '/draw--pr-1/board')).toBe(false);
    expect(sub('draw--prod', '/other/board')).toBe(false);
  });
  it('never lets a browser publish', () => {
    expect(
      authorizeRealtime({
        ...base,
        operation: 'EVENT_PUBLISH',
        channelNamespace: 'draw--prod',
        channel: '/draw--prod/board',
      }),
    ).toBe(false);
  });
});

describe('realtime in plat.config.ts', () => {
  const web = { server: 'src/server.ts' };
  it('defaults to public and resolves the declared patterns', () => {
    const m = parseManifest({ name: 'draw', web, realtime: { channels: { board: {}, 'cursors/*': {} } } });
    expect(m.realtime).toEqual({ subscribe: 'public', channels: ['board', 'cursors/*'] });
    expect(parseManifest({ name: 'draw', web }).realtime).toBeUndefined();
  });

  it('accepts signed-in with auth and a server', () => {
    const m = parseManifest({
      name: 'notes',
      web,
      auth: true,
      realtime: { subscribe: 'signed-in', channels: { 'user/*': {} } },
    });
    expect(m.realtime?.subscribe).toBe('signed-in');
  });

  it('explains what a declaration is missing', () => {
    const issues = (input: unknown) => {
      try {
        parseManifest(input);
        return [];
      } catch (e) {
        return (e as ManifestError).issues;
      }
    };
    expect(issues({ name: 'draw', web, realtime: { channels: {} } })).toEqual([
      expect.stringMatching(/^realtime\.channels: declare at least one channel/),
    ]);
    expect(issues({ name: 'draw', web, realtime: { channels: { Board: {} } } })).toEqual([
      expect.stringMatching(/^realtime\.channels\.Board: must be 1-4 segments/),
    ]);
    expect(issues({ name: 'draw', web, realtime: { subscribe: 'signed-in', channels: { b: {} } } })).toEqual([
      expect.stringMatching(/^realtime\.subscribe: 'signed-in' needs `auth: true`/),
    ]);
    expect(
      issues({
        name: 'draw',
        web: { static: 'dist' },
        auth: true,
        realtime: { subscribe: 'signed-in', channels: { b: {} } },
      }),
    ).toEqual([expect.stringMatching(/needs `web.server`/)]);
    expect(issues({ name: 'draw', web, realtime: { channels: { 'user/*': {} } } })).toEqual([
      expect.stringMatching(/^realtime\.channels\.user\/\*: .*need subscribe: 'signed-in'/),
    ]);
    expect(
      issues({
        name: 'draw',
        web,
        auth: true,
        realtime: { subscribe: 'signed-in', channels: { 'user/me': {} } },
      }),
    ).toEqual([expect.stringMatching(/declare them as "user\/\*"/)]);
  });
});
