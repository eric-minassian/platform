import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** What `plat login` stores. The token is a platform token, never a GitHub token. */
export interface StoredCredentials {
  apiUrl: string;
  token: string;
  github: string;
  expiresAt: string;
}

export function configDir(): string {
  if (process.env.PLAT_CONFIG_DIR) return process.env.PLAT_CONFIG_DIR;
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'plat');
}

export function credentialsPath(): string {
  return join(configDir(), 'credentials.json');
}

export function saveCredentials(creds: StoredCredentials, path = credentialsPath()): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(creds, null, 2)}\n`, { mode: 0o600 });
  // writeFileSync only applies `mode` when creating; enforce it on overwrite too.
  chmodSync(path, 0o600);
}

export function loadCredentials(path = credentialsPath()): StoredCredentials | null {
  if (!existsSync(path)) return null;
  try {
    const c = JSON.parse(readFileSync(path, 'utf8')) as StoredCredentials;
    if (!c.token || !c.apiUrl) return null;
    return c;
  } catch {
    return null;
  }
}

export function clearCredentials(path = credentialsPath()): boolean {
  if (!existsSync(path)) return false;
  rmSync(path);
  return true;
}

export function isExpired(c: StoredCredentials, now = Date.now()): boolean {
  const t = Date.parse(c.expiresAt);
  return Number.isFinite(t) && t <= now;
}
