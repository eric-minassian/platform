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
    expect(m.worker).toMatchObject({ entry: 'src/worker.ts', timeoutSeconds: 900, memoryMb: 1024 });
    expect(Object.keys(m.crons).sort()).toEqual(['cost', 'pinger', 'reaper', 'watchdog']);
    expect(m.auth.enabled).toBe(false);
  });
});
