import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { pipeline } from 'node:stream/promises';

/**
 * `plat dev`'s upload relay (`DEV_UPLOAD_PATH` in core): a browser PUTs to the
 * app's local host with a presigned URL in `?to=`, and the relay forwards it to
 * the AWS Emulator without the `Origin` header, which makes the emulator refuse
 * the presigned request (S3 accepts it). Only presigned URLs on the emulator's
 * own endpoint are relayed, so this is no open proxy.
 */
export interface UploadRelayOptions {
  /** The emulator's endpoint (`AWS_ENDPOINT_URL`). */
  endpoint: string;
  /** The emulator's CA, for an https endpoint. */
  ca?: Buffer;
  /** The local router's port: browser origins on `localhost` or `*.localhost` at it may upload. */
  port: number;
}

/** Request headers that describe the browser or the hop, not the object being uploaded. */
const DROPPED = new Set([
  'host',
  'origin',
  'referer',
  'cookie',
  'authorization',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'proxy-connection',
]);

export function allowedOrigin(origin: string | undefined, port: number): string | undefined {
  if (!origin) return undefined;
  const local = new RegExp(`^http://([a-z0-9-]+\\.)*localhost:${port}$`);
  return local.test(origin) ? origin : undefined;
}

export async function relayUpload(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  opts: UploadRelayOptions,
): Promise<void> {
  const origin = allowedOrigin(req.headers.origin, opts.port);
  const cors: Record<string, string> = origin
    ? { 'access-control-allow-origin': origin, vary: 'Origin' }
    : {};

  // Same-origin uploads need no preflight; one from the app's other local host does.
  if (req.method === 'OPTIONS') {
    if (!origin) return void res.writeHead(403).end();
    return void res
      .writeHead(204, {
        ...cors,
        'access-control-allow-methods': 'PUT',
        'access-control-allow-headers': req.headers['access-control-request-headers'] ?? '*',
        'access-control-max-age': '3600',
      })
      .end();
  }
  if (req.method !== 'PUT') return void res.writeHead(405, { allow: 'PUT, OPTIONS' }).end();
  if (req.headers.origin && !origin) return void res.writeHead(403).end();

  const target = parseTarget(url.searchParams.get('to'), opts.endpoint);
  if (!target) {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8', ...cors });
    return void res.end('`to` must be a presigned URL on the emulator\n');
  }

  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value !== undefined && !DROPPED.has(name) && !name.startsWith('sec-')) headers[name] = value;
  }
  headers.host = target.host;

  const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
  const upstream = await new Promise<IncomingMessage>((resolve, reject) => {
    const out = send(
      target,
      { method: 'PUT', headers, ...(target.protocol === 'https:' && opts.ca ? { ca: opts.ca } : {}) },
      resolve,
    );
    out.once('error', reject);
    pipeline(req, out).catch(reject);
  });
  const passed: Record<string, string | string[]> = { ...cors };
  for (const name of ['content-type', 'etag', 'x-amz-request-id']) {
    const value = upstream.headers[name];
    if (value !== undefined) passed[name] = value;
  }
  if (origin) passed['access-control-expose-headers'] = 'ETag';
  res.writeHead(upstream.statusCode ?? 502, passed);
  await pipeline(upstream, res);
}

function parseTarget(to: string | null, endpoint: string): URL | undefined {
  if (!to) return undefined;
  try {
    const target = new URL(to);
    return target.origin === new URL(endpoint).origin ? target : undefined;
  } catch {
    return undefined;
  }
}
