import type { ChildProcess } from 'node:child_process';

/**
 * Dev children are spawned `detached` so each leads its own process group:
 * `shell: true` commands (`pnpm --dir web dev` → pnpm → vite) and `tsx watch`
 * fork grandchildren that a plain `child.kill()` leaves running.
 */
export function killTree(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}
