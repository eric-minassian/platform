import { parseManifest, validateAppName } from '@ericminassian/platform-core';
import { describe, expect, it } from 'vitest';
import config from '../plat.config.ts';

describe('control plane plat.config.ts', () => {
  it('is the system app `platform`, a name no member can register', () => {
    expect(config.name).toBe('platform');
    // Reserved names are enforced when an app is registered through the API, not by the
    // manifest schema, so the control plane's own config parses as-is.
    expect(validateAppName('platform')).toMatch(/reserved/);
  });

  it('is a valid manifest with the expected shape', () => {
    const m = parseManifest(JSON.parse(JSON.stringify(config)));
    expect(m.web).toMatchObject({
      server: 'src/server.ts',
      static: 'web/dist',
      serverRoutes: ['/v1/', '/auth/'],
    });
    expect(m.worker).toMatchObject({ entry: 'src/worker.ts', timeoutSeconds: 300, memoryMb: 512 });
    // Deploys and destroys get a function of their own with the full Lambda timeout, run once.
    expect(m.queues).toEqual({ stages: { memoryMb: 1024, timeoutSeconds: 900, maxAttempts: 1 } });
    // Its own server stays off the account's Lambda concurrency that apps' servers share.
    expect(m.web?.compute).toBe('instance');
    expect(Object.keys(m.crons).toSorted()).toEqual([
      'compute',
      'cost',
      'pinger',
      'realtime-key',
      'reaper',
      'storage-expiry',
      'watchdog',
    ]);
    expect(m.auth.enabled).toBe(false);
  });
});
