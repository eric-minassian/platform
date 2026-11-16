import { timingSafeEqual } from 'node:crypto';
import { Readable, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { ORIGIN_HEADER, originSecret } from '@ericminassian/platform-core';
import { tryBindings } from './bindings.ts';

/**
 * Request mode: the server bundle as a regular Lambda function behind a
 * function URL whose invoke mode is RESPONSE_STREAM. Lambda calls the handler
 * once per request with the URL's payload (format 2.0), and the response
 * streams back as the app produces it.
 *
 * - A request body is at most 6 MB (Lambda's limit for a synchronous invoke;
 *   a binary body arrives base64-encoded, which counts). A response streams
 *   up to 200 MB; past its first 6 MB, at up to 2 MB/s.
 * - Function URLs take requests from anyone, so the router sends the stage's
 *   origin secret in `ORIGIN_HEADER` and anything without it is answered 403
 *   before any app code runs. The app never sees the header.
 */

/** A function URL request (payload format 2.0): what the handler reads of it. */
export interface FunctionUrlEvent {
  rawPath: string;
  rawQueryString?: string;
  /** Lowercase names; repeated headers arrive comma-joined. */
  headers?: Record<string, string | undefined>;
  /** The request's cookies, moved out of `headers`. */
  cookies?: string[];
  body?: string;
  isBase64Encoded?: boolean;
  requestContext: { domainName?: string; http: { method: string } };
}

/** What the response stream's prelude carries (status, headers, Set-Cookie values). */
export interface ResponsePrelude {
  statusCode: number;
  headers: Record<string, string>;
  cookies?: string[];
}

/** The Node.js runtime's response streaming API (the `awslambda` global). */
export interface LambdaStreaming {
  streamifyResponse(handler: RequestModeHandler): RequestModeHandler;
  HttpResponseStream: { from(stream: Writable, prelude: ResponsePrelude): Writable };
}

export type RequestModeHandler = (
  event: FunctionUrlEvent,
  responseStream: Writable,
  context: unknown,
) => Promise<void>;

/** The function URL's request as a web `Request` (cookies and base64 bodies restored). */
export function toWebRequest(event: FunctionUrlEvent): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(event.headers ?? {})) {
    if (value !== undefined && name !== ORIGIN_HEADER) headers.set(name, value);
  }
  if (event.cookies?.length) headers.set('cookie', event.cookies.join('; '));
  const host = headers.get('host') ?? event.requestContext.domainName ?? 'localhost';
  const query = event.rawQueryString ? `?${event.rawQueryString}` : '';
  const method = event.requestContext.http.method;
  const hasBody = method !== 'GET' && method !== 'HEAD' && event.body !== undefined;
  return new Request(`https://${host}${event.rawPath}${query}`, {
    method,
    headers,
    ...(hasBody ? { body: event.isBase64Encoded ? Buffer.from(event.body!, 'base64') : event.body! } : {}),
  });
}

/** Status and headers for the stream's prelude. Repeated headers are comma-joined, as HTTP allows; Set-Cookie is not. */
export function responsePrelude(response: Response): ResponsePrelude {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    if (name !== 'set-cookie') headers[name] = value;
  });
  const cookies = response.headers.getSetCookie();
  return { statusCode: response.status, headers, ...(cookies.length ? { cookies } : {}) };
}

/** Streams `response` to Lambda's response stream: the prelude, then the body as it arrives. */
export async function streamResponse(
  streaming: LambdaStreaming,
  responseStream: Writable,
  response: Response,
): Promise<void> {
  const out = streaming.HttpResponseStream.from(responseStream, responsePrelude(response));
  if (!response.body) {
    // The prelude is only sent with the first write, so a bodiless response (204, 304, HEAD)
    // writes an empty chunk.
    out.write('');
    out.end();
    return;
  }
  await pipeline(Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>), out);
}

let expected: { stageKey: string; secret: Promise<Buffer> } | undefined;

/** Whether the request carries the stage's origin secret (compared in constant time). */
export async function fromEdge(event: FunctionUrlEvent): Promise<boolean> {
  const given = event.headers?.[ORIGIN_HEADER];
  const stageKey = tryBindings()?.stageKey;
  if (!given || !stageKey) return false;
  if (expected?.stageKey !== stageKey)
    expected = { stageKey, secret: originSecret(stageKey).then((s) => Buffer.from(s)) };
  const secret = await expected.secret;
  const candidate = Buffer.from(given);
  // The secret's length is fixed and public; only its bytes need a constant-time compare.
  return candidate.length === secret.length && timingSafeEqual(candidate, secret);
}

/** The streaming handler Lambda calls for each request: the origin check, then `fetch`. */
export function createRequestModeHandler(
  fetch: (request: Request) => Promise<Response>,
  streaming: LambdaStreaming,
): RequestModeHandler {
  return streaming.streamifyResponse(async (event, responseStream) => {
    if (!(await fromEdge(event))) {
      await streamResponse(
        streaming,
        responseStream,
        new Response('Forbidden', {
          status: 403,
          headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' },
        }),
      );
      return;
    }
    await streamResponse(streaming, responseStream, await fetch(toWebRequest(event)));
  });
}
