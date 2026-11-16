import { describe, expect, it } from 'vitest';
import { contentTypeFor, isServableKey, names, PUBLIC_STORAGE_ROOT, storagePath } from '../src/index.ts';

describe('storage', () => {
  it('keeps public stores under a prefix no app can have', () => {
    expect(names.storagePrefix('atlas', 'prod', 'snapshots')).toBe('atlas/prod/snapshots/');
    expect(names.publicStoragePrefix('atlas', 'prod', 'snapshots')).toBe('_public/atlas/prod/snapshots/');
    expect(names.publicStoragePrefix('atlas', 'prod')).toBe('_public/atlas/prod/');
    expect(PUBLIC_STORAGE_ROOT.startsWith('_')).toBe(true);
  });

  it('builds edge paths with each key segment encoded', () => {
    expect(storagePath('snapshots', 'fires/today 1.json')).toBe(
      '/__platform/storage/snapshots/fires/today%201.json',
    );
    expect(storagePath('snapshots', '/a?b#c.json')).toBe('/__platform/storage/snapshots/a%3Fb%23c.json');
    expect(() => storagePath('snapshots', 'a/../b')).toThrow(/can't be served/);
    expect(() => storagePath('snapshots', '')).toThrow(/can't be served/);
  });

  it('refuses keys with dot segments, raw or encoded', () => {
    expect(isServableKey('a/b.json')).toBe(true);
    expect(isServableKey('a..b/c')).toBe(true);
    expect(isServableKey('')).toBe(false);
    expect(isServableKey('..')).toBe(false);
    expect(isServableKey('a/./b')).toBe(false);
    expect(isServableKey('%2E%2E/b')).toBe(false);
    expect(isServableKey('a%2F..%2Fb')).toBe(false);
    expect(isServableKey('.%2E/b')).toBe(false);
    // Decoded once, this is the literal text `%2e`, not a dot.
    expect(isServableKey('%252e%252e/b')).toBe(true);
  });

  it('guesses content types from the file name', () => {
    expect(contentTypeFor('fires/today.json')).toBe('application/json; charset=utf-8');
    expect(contentTypeFor('a/B.PNG')).toBe('image/png');
    expect(contentTypeFor('v1.2/readme')).toBe('application/octet-stream');
    expect(contentTypeFor('noext')).toBe('application/octet-stream');
  });
});
