import { Layer, Schema } from 'effect';
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from 'effect/http-api';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clientInfoFromHeaders } from '../src/client-info.ts';
import { clientInfo, Platform, toFetchHandler } from '../src/index.ts';
import {
  captureTelemetry,
  clientHeaders,
  createPlatformFetch,
  resetPlatform,
  useTestBindings,
} from '../src/testing.ts';

const from = (address: string, country?: string) =>
  clientInfoFromHeaders({
    'cloudfront-viewer-address': address,
    ...(country ? { 'cloudfront-viewer-country': country } : {}),
  });

describe('clientInfoFromHeaders', () => {
  it('reads an IPv4 client: the address is its own network', () => {
    expect(from('198.51.100.10:46532', 'US')).toEqual({
      ip: '198.51.100.10',
      network: '198.51.100.10',
      country: 'US',
    });
  });

  it('reduces IPv6 to its /64, from the unbracketed form the edge sends', () => {
    expect(from('2001:db8:1:2::7:51234', 'DE')).toEqual({
      ip: '2001:db8:1:2::7',
      network: '2001:db8:1:2::/64',
      country: 'DE',
    });
    expect(from('2001:db8::1:443')).toEqual({ ip: '2001:db8::1', network: '2001:db8::/64' });
    expect(from('::1:51234')).toEqual({ ip: '::1', network: '::/64' });
  });

  it('gives every spelling of an address the same ip, and one /64 the same network', () => {
    const full = from('2001:0DB8:0001:0002:0000:0000:0000:0007:443');
    expect(full).toEqual(from('2001:db8:1:2::7:443'));
    expect(full).toEqual(from('[2001:db8:1:2::7]:443'));
    expect(from('2001:db8:1:2:aaaa:bbbb:cccc:dddd:443')?.network).toBe(full?.network);
    expect(from('2001:db8:1:3::7:443')?.network).toBe('2001:db8:1:3::/64');
  });

  it('reports an IPv4 client on a dual-stack socket as IPv4', () => {
    expect(from('::ffff:203.0.113.7:443')).toEqual({ ip: '203.0.113.7', network: '203.0.113.7' });
  });

  it('has nothing without a valid ip:port', () => {
    expect(clientInfoFromHeaders({})).toBeUndefined();
    expect(clientInfoFromHeaders({ 'cloudfront-viewer-country': 'US' })).toBeUndefined();
    for (const bad of [
      '',
      '198.51.100.10',
      '198.51.100.10:',
      '198.51.100.10:x',
      'example.com:443',
      '1.2.3:443',
    ])
      expect(from(bad), bad).toBeUndefined();
  });
});

describe('clientHeaders', () => {
  it('writes what the edge writes', () => {
    expect(clientHeaders('2001:db8::7', { country: 'FR' })).toEqual({
      'cloudfront-viewer-address': '2001:db8::7:50000',
      'cloudfront-viewer-country': 'FR',
    });
  });

  it('refuses something that is not an IP address', () => {
    expect(() => clientHeaders('localhost')).toThrow('localhost is not an IP address');
  });
});

describe('clientInfo', () => {
  const ClientSchema = Schema.Struct({
    ip: Schema.String,
    network: Schema.String,
    country: Schema.optionalKey(Schema.String),
  });
  const Api = HttpApi.make('test').add(
    HttpApiGroup.make('client', { topLevel: true }).add(
      HttpApiEndpoint.get('whoami', '/api/whoami', { success: ClientSchema }),
    ),
  );
  const app = () =>
    createPlatformFetch(
      toFetchHandler(
        HttpApiBuilder.layer(Api).pipe(
          Layer.provide(
            HttpApiBuilder.group(Api, 'client', (handlers) => handlers.handle('whoami', () => clientInfo)),
          ),
          Layer.provide(Platform.layerMemory()),
        ),
      ),
    );
  const whoami = (headers?: Record<string, string>) =>
    app()(new Request('http://localhost/api/whoami', headers ? { headers } : {}));

  let telemetry: ReturnType<typeof captureTelemetry>;
  beforeEach(() => {
    useTestBindings();
    telemetry = captureTelemetry();
  });
  afterEach(() => {
    telemetry.stop();
    resetPlatform();
  });

  it('is the client the edge saw', async () => {
    const res = await whoami(clientHeaders('2001:db8:1:2::7', { country: 'DE' }));
    expect(await res.json()).toEqual({ ip: '2001:db8:1:2::7', network: '2001:db8:1:2::/64', country: 'DE' });
  });

  it('is a defect, naming the fix, on a request without a client address', async () => {
    expect((await whoami()).status).toBe(500);
    const error = telemetry.events.find((e) => e.t === 'err');
    expect(error?.t === 'err' && error.message).toContain("clientHeaders('203.0.113.7')");
  });
});
