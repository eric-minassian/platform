import { readFileSync } from 'node:fs';
import { HOST_HEADER, NOT_FOUND_ORIGIN_ID, ORIGIN_HEADER, SITES_ORIGIN_ID } from './constants.ts';
import { APPSYNC_REALTIME_PATH, REALTIME_KVS_KEY } from './realtime.ts';
import { PUBLIC_STORAGE_ROOT, STORAGE_CACHE_HOST, STORAGE_PATH } from './storage.ts';

/**
 * Builds the CloudFront Function (JavaScript runtime 2.0) that routes every
 * request on `*.<domain>`: look up the host in the KeyValueStore, then either
 * rewrite the URI into the sites bucket (the distribution's default S3 origin)
 * or switch the origin to the stage's server: a Lambda Web Function with OAC
 * signing, or a request-mode function URL with the stage's origin secret.
 * `REALTIME_PATH` is answered here (the browser's config) or passed to the
 * AppSync realtime endpoint (a WebSocket). The `STORAGE_PATH` behavior runs
 * it too: a public store's file is rewritten into that behavior's origin.
 *
 * A host from platform.config.ts `hosts` has a `HostRecord` instead: a
 * redirect is answered here, and an alias reads the app's own host's record
 * and goes on with it.
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

// Query values arrive as the viewer sent them (still encoded), so they're joined as they are.
function query(qs) {
  var parts = [];
  for (var key in qs) {
    var values = qs[key].multiValue || [qs[key]];
    for (var i = 0; i < values.length; i++) parts.push(values[i].value === '' ? key : key + '=' + values[i].value);
  }
  return parts.length ? '?' + parts.join('&') : '';
}

function redirect(req, host) {
  return { statusCode: 301, statusDescription: 'Moved Permanently', headers: { location: { value: 'https://' + host + req.uri + query(req.querystring) }, 'cache-control': { value: 'public, max-age=86400' } } };
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
  if (rec.x) return redirect(req, rec.x);
  var own = host;
  if (rec.a) {
    own = rec.a;
    try { raw = await kvs.get(own); } catch (e) { return notFound(); }
    try { rec = JSON.parse(raw); } catch (e) { return notFound(); }
  }
  var d = decide(rec, req.uri);
  if (d.t === 'notfound') return notFound();
  if (d.t === 'health') return health(rec);
  if (d.t === 'realtime') return await realtime(req, rec);
  // A server sees the host the viewer asked for; an alias's files share the own host's cache entries.
  req.headers[${JSON.stringify(HOST_HEADER)}] = { value: d.t === 'static' ? own : host };
  if (d.t === 'static') {
    req.uri = d.key;
    req.cookies = {};
    delete req.headers['authorization'];
    // A file the build doesn't have (S3 answers 403 without ListBucket) goes to the not-found
    // origin, which serves the build's 404 page. CloudFront fails over only GET and HEAD.
    if (req.method === 'GET' || req.method === 'HEAD') {
      cf.createRequestOriginGroup({ originIds: [${JSON.stringify(SITES_ORIGIN_ID)}, ${JSON.stringify(NOT_FOUND_ORIGIN_ID)}], failoverCriteria: { statusCodes: [403, 404] } });
    }
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
  // A viewer's copy of the origin header never reaches a server.
  delete req.headers[${JSON.stringify(ORIGIN_HEADER)}];
  if (rec.c === 'r') {
    // Request mode: a function URL, which anyone may call, so the server only answers requests
    // carrying the stage's secret. OAC would make clients hash POST bodies (x-amz-content-sha256).
    cf.updateRequestOrigin({
      domainName: rec.o,
      originAccessControlConfig: { enabled: false },
      customOriginConfig: { port: 443, protocol: 'https', sslProtocols: ['TLSv1.2'] },
      customHeaders: { ${JSON.stringify(ORIGIN_HEADER)}: rec.k },
      timeouts: { readTimeout: ${readTimeout} }
    });
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
