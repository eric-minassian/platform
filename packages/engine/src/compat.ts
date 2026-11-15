import { Readable } from 'node:stream';

/**
 * AWS Emulator v1.0.385 serializes Lambda Web Function timestamps (`createdAt`,
 * `updatedAt`, ...) as epoch numbers, while the service model (and the JS SDK
 * deserializer) requires RFC 3339 strings, so every response fails to parse.
 * This middleware rewrites `*At` number fields to ISO strings before the SDK
 * deserializes. Only installed when the engine targets the emulator; delete it
 * once the emulator is fixed.
 */
export function addEmulatorCompat(client: {
  middlewareStack: { add: (mw: never, opts: { step: 'deserialize'; name: string; priority: 'low' }) => void };
}): void {
  const middleware =
    (next: (args: unknown) => Promise<{ response?: { body?: unknown } }>) => async (args: unknown) => {
      const out = await next(args);
      const res = out.response as { body?: unknown } | undefined;
      const body = res?.body as AsyncIterable<Uint8Array> | undefined;
      if (
        res &&
        body &&
        typeof (body as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function'
      ) {
        const chunks: Buffer[] = [];
        for await (const c of body) chunks.push(Buffer.from(c));
        res.body = Readable.from([Buffer.from(fixTimestamps(Buffer.concat(chunks).toString('utf8')))]);
      }
      return out;
    };
  client.middlewareStack.add(middleware as never, {
    step: 'deserialize',
    name: 'platformEmulatorTimestampCompat',
    priority: 'low',
  });
}

/** Exported for tests. */
export function fixTimestamps(json: string): string {
  if (!json) return json;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return json;
  }
  const visit = (o: unknown): void => {
    if (Array.isArray(o)) {
      for (const v of o) visit(v);
      return;
    }
    if (!o || typeof o !== 'object') return;
    const rec = o as Record<string, unknown>;
    for (const [k, v] of Object.entries(rec)) {
      if (/At$/.test(k) && typeof v === 'number') {
        rec[k] = new Date(v < 1e12 ? v * 1000 : v).toISOString();
      } else {
        visit(v);
      }
    }
  };
  visit(parsed);
  return JSON.stringify(parsed);
}
