import { Readable } from 'node:stream';

type Client = {
  middlewareStack: { add: (mw: never, opts: { step: 'deserialize'; name: string; priority: 'low' }) => void };
};

/**
 * AWS Emulator v1.0.385 serializes Lambda Web Function timestamps (`createdAt`,
 * `updatedAt`, ...) as epoch numbers, while the service model (and the JS SDK
 * deserializer) requires RFC 3339 strings, so every response fails to parse.
 * This middleware rewrites `*At` number fields to ISO strings before the SDK
 * deserializes. Only installed when the engine targets the emulator; delete it
 * once the emulator is fixed.
 */
export function addEmulatorCompat(client: Client): void {
  rewriteResponses(client, 'platformEmulatorTimestampCompat', fixTimestamps);
}

/**
 * AWS Emulator v1.0.385 writes ECS service timestamps as epoch seconds with
 * nanosecond digits (`1794787458.178454563`). The SDK reads numbers with more
 * digits than a double holds as big decimals, which its timestamp parser
 * rejects, so DescribeServices, CreateService and UpdateService all fail.
 * Re-serializing the body rounds them to doubles. Emulator only.
 */
export function addEmulatorEcsCompat(client: Client): void {
  rewriteResponses(client, 'platformEmulatorEpochPrecisionCompat', roundNumbers);
}

function rewriteResponses(client: Client, name: string, rewrite: (body: string) => string): void {
  const middleware =
    (next: (args: unknown) => Promise<{ response?: { body?: unknown } }>) => async (args: unknown) => {
      const out = await next(args);
      const res = out.response;
      const body = res?.body as AsyncIterable<Uint8Array> | undefined;
      if (
        res &&
        body &&
        typeof (body as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function'
      ) {
        const chunks: Buffer[] = [];
        for await (const c of body) chunks.push(Buffer.from(c));
        res.body = Readable.from([Buffer.from(rewrite(Buffer.concat(chunks).toString('utf8')))]);
      }
      return out;
    };
  client.middlewareStack.add(middleware as never, { step: 'deserialize', name, priority: 'low' });
}

/** Exported for tests. */
export function roundNumbers(json: string): string {
  if (!json) return json;
  try {
    return JSON.stringify(JSON.parse(json));
  } catch {
    return json;
  }
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
      if (k.endsWith('At') && typeof v === 'number') {
        rec[k] = new Date(v < 1e12 ? v * 1000 : v).toISOString();
      } else {
        visit(v);
      }
    }
  };
  visit(parsed);
  return JSON.stringify(parsed);
}
