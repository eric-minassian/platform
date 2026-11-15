import { chmodSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearCredentials,
  credentialsPath,
  isExpired,
  loadCredentials,
  saveCredentials,
} from '../src/credentials.ts';
import { tempDir } from './helpers.ts';

const creds = {
  apiUrl: 'https://api.test',
  token: 'secret',
  github: 'octo',
  expiresAt: '2999-01-01T00:00:00Z',
};

describe('credentials', () => {
  const old = process.env.PLAT_CONFIG_DIR;
  afterEach(() => {
    if (old === undefined) delete process.env.PLAT_CONFIG_DIR;
    else process.env.PLAT_CONFIG_DIR = old;
  });

  it('stores the token readable only by the user', () => {
    process.env.PLAT_CONFIG_DIR = join(tempDir(), 'plat');
    saveCredentials(creds);
    const path = credentialsPath();
    expect(path).toBe(join(process.env.PLAT_CONFIG_DIR, 'credentials.json'));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(process.env.PLAT_CONFIG_DIR).mode & 0o777).toBe(0o700);
    expect(loadCredentials()).toEqual(creds);
  });

  it('re-tightens permissions when overwriting an existing file', () => {
    const path = join(tempDir(), 'credentials.json');
    writeFileSync(path, '{}');
    chmodSync(path, 0o644);
    saveCredentials(creds, path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('handles missing, corrupt and expired credentials', () => {
    const dir = tempDir();
    expect(loadCredentials(join(dir, 'nope.json'))).toBeNull();
    writeFileSync(join(dir, 'bad.json'), 'not json');
    expect(loadCredentials(join(dir, 'bad.json'))).toBeNull();
    expect(isExpired({ ...creds, expiresAt: '2000-01-01T00:00:00Z' })).toBe(true);
    expect(isExpired(creds)).toBe(false);
    saveCredentials(creds, join(dir, 'c.json'));
    expect(clearCredentials(join(dir, 'c.json'))).toBe(true);
    expect(clearCredentials(join(dir, 'c.json'))).toBe(false);
  });
});
