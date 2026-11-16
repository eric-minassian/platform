import { readFileSync } from 'node:fs';
import { HOST_HEADER } from './constants.ts';
import { APPSYNC_REALTIME_PATH, REALTIME_KVS_KEY } from './realtime.ts';
import { PUBLIC_STORAGE_ROOT, STORAGE_CACHE_HOST, STORAGE_PATH } from './storage.ts';

/**
 * Builds the CloudFront Function (JavaScript runtime 2.0) that routes every
 * request on `*.<domain>`: look up the host in the KeyValueStore, then either
 * rewrite the URI into the sites bucket (the distribution's default S3 origin)
 * or switch the origin to the stage's Lambda Web Function with OAC signing.
 * `REALTIME_PATH` is answered here (the browser's config) or passed to the
 * AppSync realtime endpoint (a WebSocket). The `STORAGE_PATH` behavior runs
 * it too: a public store's file is rewritten into that behavior's origin.
 */
export function buildRouterFunctionCode(opts: { kvsId: string; originReadTimeoutSeconds?: number }): string {
  const decideSrc = readFileSync(new URL('./router/decide.js', import.meta.url), 'utf8')
    .replace(/^\/\/.*$/gm, '')
    .replace(/^export function decide/m, 'function decide')
    .trim();
  const readTimeout = opts.originReadTimeoutSeconds ?? 60;
  return `import cf from 'cloudfront';
const kvs = cf.kvs(${JSON.stringify(opts.kvsId)});

${decideSrc}

function health(rec) {
  var body = JSON.stringify({ ok: true, app: rec.app, stage: rec.stage, revision: rec.d });
  return { statusCode: 200, statusDescription: 'OK', headers: { 'content-type': { value: 'application/json' }, 'cache-control': { value: 'no-store' } }, body: body };
}

function json(body) {
  return { statusCode: 200, statusDescription: 'OK', headers: { 'content-type': { value: 'application/json' }, 'cache-control': { value: 'no-store' } }, body: JSON.stringify(body) };
}

async function realtime(req, rec) {
  var raw;
  try { raw = await kvs.get(${JSON.stringify(REALTIME_KVS_KEY)}); } catch (e) { return notFound(); }
  var rt;
  try { rt = JSON.parse(raw); } catch (e) { return notFound(); }
  // CloudFront drops Upgrade and Connection before functions run; a WebSocket
  // handshake still carries Sec-WebSocket-Key.
  if (req.headers['sec-websocket-key']) {
    req.uri = ${JSON.stringify(APPSYNC_REALTIME_PATH)};
    req.querystring = {};
    req.cookies = {};
    delete req.headers['authorization'];
    // AppSync authenticates the subprotocol header, not a signature: no OAC.
    cf.updateRequestOrigin({
      domainName: rt.o,
      originAccessControlConfig: { enabled: false },
      customOriginConfig: { port: 443, protocol: 'https', sslProtocols: ['TLSv1.2'] },
      timeouts: { readTimeout: ${readTimeout} }
    });
    return req;
  }
  var cfg = { v: 1, host: rt.h, namespace: rec.rt.n, subscribe: rec.rt.m === 's' ? 'signed-in' : 'public' };
  if (rec.rt.m !== 's') cfg.apiKey = rt.k;
  return json(cfg);
}

function notFound() {
  return { statusCode: 404, statusDescription: 'Not Found', headers: { 'content-type': { value: 'text/plain' }, 'cache-control': { value: 'no-store' } }, body: 'Nothing is deployed here.' };
}

async function handler(event) {
  var req = event.request;
  var host = ((req.headers.host && req.headers.host.value) || '').toLowerCase();
  // The CloudFront Functions runtime rejects \`await\` inside call arguments.
  var raw;
  try { raw = await kvs.get(host); } catch (e) { return notFound(); }
  var rec;
  try { rec = JSON.parse(raw); } catch (e) { return notFound(); }
  var d = decide(rec, req.uri);
  if (d.t === 'notfound') return notFound();
  if (d.t === 'health') return health(rec);
  if (d.t === 'realtime') return await realtime(req, rec);
  req.headers[${JSON.stringify(HOST_HEADER)}] = { value: host };
  if (d.t === 'static') {
    req.uri = d.key;
    req.cookies = {};
    delete req.headers['authorization'];
    return req;
  }
  // Only on the ${STORAGE_PATH}* behavior, whose origin is the storage bucket under ${PUBLIC_STORAGE_ROOT}.
  // Its own cache key (STORAGE_CACHE_HOST in core). No query string: the OAC-signed request would
  // pass S3's response-* overrides through.
  if (d.t === 'storage') {
    req.headers[${JSON.stringify(HOST_HEADER)}] = { value: ${JSON.stringify(STORAGE_CACHE_HOST)} };
    req.uri = d.key;
    req.querystring = {};
    req.cookies = {};
    delete req.headers['authorization'];
    return req;
  }
  cf.updateRequestOrigin({
    domainName: rec.o,
    originAccessControlConfig: { enabled: true, signingBehavior: 'always-amz-auth', signingProtocol: 'sigv4', originType: 'lambda' },
    customOriginConfig: { port: 443, protocol: 'https', sslProtocols: ['TLSv1.2'] },
    timeouts: { readTimeout: ${readTimeout} }
  });
  return req;
}
`;
}
