import { readFileSync } from 'node:fs';
import { HOST_HEADER } from './constants.ts';

/**
 * Builds the CloudFront Function (JavaScript runtime 2.0) that routes every
 * request on `*.<domain>`: look up the host in the KeyValueStore, then either
 * rewrite the URI into the sites bucket (the distribution's default S3 origin)
 * or switch the origin to the stage's Lambda Web Function with OAC signing.
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
  req.headers[${JSON.stringify(HOST_HEADER)}] = { value: host };
  if (d.t === 'static') {
    req.uri = d.key;
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
