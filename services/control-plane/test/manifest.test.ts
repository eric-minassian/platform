import { readFileSync } from 'node:fs';
import { parseManifest, validateAppName } from '@eric-minassian/platform-core';
import { describe, expect, it } from 'vitest';

const raw = JSON.parse(readFileSync(new URL('../platform.json', import.meta.url), 'utf8')) as {
  name: string;
};

describe('control plane platform.json', () => {
  it('is the system app `platform`, a name no member can register', () => {
    expect(raw.name).toBe('platform');
    // Reserved names are enforced when an app is registered through the API, not by the
    // manifest schema, so the control plane's own manifest parses as-is.
    expect(validateAppName('platform')).toMatch(/reserved/);
  });

  it('is a valid manifest with the expected shape', () => {
    const m = parseManifest(raw);
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
