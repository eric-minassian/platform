import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

/**
 * Minimal Node `http` ⇄ web `fetch` adapter (no framework dependency).
 * Streams request and response bodies, preserves multiple Set-Cookie headers.
 */
export type FetchFn = (request: Request) => Promise<Response>;

export function toRequest(req: IncomingMessage, signal?: AbortSignal): Request {
  const host = req.headers.host ?? 'localhost';
  const url = new URL(req.url ?? '/', `http://${host}`);
  const headers = new Headers();
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const k = req.rawHeaders[i]!;
    const v = req.rawHeaders[i + 1]!;
    if (k.startsWith(':')) continue;
    headers.append(k, v);
  }
  const method = req.method ?? 'GET';
  const hasBody = method !== 'GET' && method !== 'HEAD';
  return new Request(url, {
    method,
    headers,
    ...(hasBody ? { body: Readable.toWeb(req) as ReadableStream, duplex: 'half' } : {}),
    ...(signal ? { signal } : {}),
  } as RequestInit);
}

export async function writeResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, key) => {
    if (key === 'set-cookie') return;
    headers[key] = value;
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length) headers['set-cookie'] = cookies;
  res.writeHead(response.status, response.statusText || undefined, headers);
  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(value)) await new Promise<void>((r) => res.once('drain', r));
    }
  } finally {
    res.end();
  }
}

export function createNodeServer(fetchFn: FetchFn): Server {
  return createServer((req, res) => {
    const controller = new AbortController();
    res.once('close', () => {
      if (!res.writableFinished) controller.abort();
    });
    fetchFn(toRequest(req, controller.signal))
      .then((response) => writeResponse(res, response))
      .catch((e) => {
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({ error: { code: 'internal', message: String((e as Error)?.message ?? e) } }),
          );
        } else res.destroy(e as Error);
      });
  });
}

/** Parse `host:port` (IPv6 in brackets allowed). */
export function parseEndpoint(endpoint: string): { host: string; port: number } {
  const i = endpoint.lastIndexOf(':');
  if (i <= 0) throw new Error(`Invalid listen endpoint "${endpoint}" (expected host:port)`);
  const host = endpoint.slice(0, i).replace(/^\[|\]$/g, '');
  const port = Number(endpoint.slice(i + 1));
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid port in "${endpoint}"`);
  return { host, port };
}
