import { connect, createServer, type Server } from 'node:net';

/**
 * Both loopback addresses. `localhost` resolves to ::1 first on many systems,
 * so a dev server bound to `localhost` can hold a port on ::1 alone, which a
 * check against 127.0.0.1 doesn't see.
 */
const LOOPBACKS = ['127.0.0.1', '::1'] as const;
/** Errors that mean the host has no such address (IPv6 off), not that the port is taken. */
const NO_ADDRESS = new Set(['EADDRNOTAVAIL', 'EAFNOSUPPORT']);

function listen(port: number, host: string): Promise<Server | string> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', (err: NodeJS.ErrnoException) => resolve(err.code ?? 'EUNKNOWN'));
    srv.listen(port, host, () => resolve(srv));
  });
}

/**
 * Binds `port` (0 = any) on every loopback address and releases it, or
 * returns undefined when any of them has it in use.
 */
async function probe(port: number): Promise<number | undefined> {
  const held: Server[] = [];
  let chosen = port;
  try {
    for (const host of LOOPBACKS) {
      const r = await listen(chosen, host);
      if (typeof r === 'string') {
        if (host !== LOOPBACKS[0] && NO_ADDRESS.has(r)) continue;
        return undefined;
      }
      held.push(r);
      const addr = r.address();
      if (typeof addr === 'object' && addr) chosen = addr.port;
    }
    return chosen;
  } finally {
    await Promise.all(held.map((s) => new Promise((done) => s.close(done))));
  }
}

/** Whether `port` is free on both loopback addresses. */
export async function portFree(port: number): Promise<boolean> {
  return (await probe(port)) === port;
}

/** A TCP port free on both loopback addresses. */
export async function freePort(): Promise<number> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const port = await probe(0);
    if (port) return port;
  }
  throw new Error('no free port on the loopback addresses');
}

/**
 * Resolves once something accepts TCP connections on host:port. Rejects after
 * `timeoutMs`, or as soon as `signal` aborts (e.g. the process that should
 * listen has exited).
 */
export async function waitForPort(
  port: number,
  host = '127.0.0.1',
  timeoutMs = 30_000,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const ok = await new Promise<boolean>((resolve) => {
      const s = connect(port, host);
      s.once('connect', () => {
        s.end();
        resolve(true);
      });
      s.once('error', () => resolve(false));
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`nothing listening on ${host}:${port} after ${timeoutMs}ms`);
}
