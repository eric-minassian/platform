import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));

export const SDK_STUBS = {
  '@ericminassian/platform/server': join(FIXTURES, 'sdk-stub', 'server.mjs'),
  '@ericminassian/platform/worker': join(FIXTURES, 'sdk-stub', 'worker.mjs'),
};

export function tempDir(prefix = 'plat-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Copy a fixture app to a temp dir so builds don't write into the repo. */
export function copyFixture(name: string): string {
  const dir = join(tempDir(), name);
  cpSync(join(FIXTURES, name), dir, { recursive: true });
  return dir;
}
