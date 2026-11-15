import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { unzipSync, type Zippable, zipSync } from 'fflate';

/** Every file under `dir`, as zip paths (forward slashes) → absolute paths. */
export function listFiles(dir: string): Array<{ zipPath: string; absPath: string }> {
  const out: Array<{ zipPath: string; absPath: string }> = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const abs = join(d, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) out.push({ zipPath: relative(dir, abs).split(sep).join('/'), absPath: abs });
    }
  };
  walk(dir);
  return out.sort((a, b) => a.zipPath.localeCompare(b.zipPath));
}

/** Zip a directory. Timestamps are fixed so identical inputs produce identical zips. */
export function zipDirectory(dir: string): Uint8Array {
  const files: Zippable = {};
  for (const f of listFiles(dir)) files[f.zipPath] = [readFileSync(f.absPath), { mtime: FIXED_MTIME }];
  return zipSync(files, { level: 6 });
}

export function zipEntries(entries: Record<string, Uint8Array | string>): Uint8Array {
  const files: Zippable = {};
  for (const [name, data] of Object.entries(entries)) {
    files[name] = [typeof data === 'string' ? new TextEncoder().encode(data) : data, { mtime: FIXED_MTIME }];
  }
  return zipSync(files, { level: 6 });
}

export function zipFileNames(zip: Uint8Array): string[] {
  return Object.keys(unzipSync(zip)).sort();
}

export function dirExists(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

const FIXED_MTIME = new Date('2020-01-01T00:00:00Z');
