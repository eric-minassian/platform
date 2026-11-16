// Routing decision shared by the CloudFront Function (edge) and the `plat dev`
// local router. It is inlined verbatim into the CloudFront Function, so it must
// stay within the CloudFront Functions JavaScript runtime 2.0 subset: no imports,
// no external calls, plain functions, small. The `export` keyword is stripped
// when inlined.
//
// rec: route record from the KeyValueStore (see RouteRecord in router.ts)
//   o   - the server's domain, optional: a Web Function endpoint, or a function URL when c is 'r'
//         (request mode). Which one only changes how the CloudFront Function calls it (OAC, or
//         the origin secret k in a header); `plat dev` runs the server itself.
//   s   - static key prefix in the sites bucket, e.g. "foo/prod/d01j..." , optional
//   r   - server route prefixes when both o and s exist, e.g. ["/api/"]
//   spa - 1 to serve index.html for unknown non-file paths
//   rt  - realtime: { n: channel namespace, m: 'p' | 's' }, optional
//   p   - public store names, optional
// returns { t: 'server' } | { t: 'static', key: '/<prefix>/<path>' } | { t: 'health' } | { t: 'realtime' }
//         | { t: 'storage', key: '/<app>/<stage>/<store>/<key>' } | { t: 'notfound' }
//   health   - the router answers /__platform/health itself (HealthResponse with rec.d as the
//              revision): a stage without a server has nothing else to report what it serves.
//   realtime - /__platform/realtime is the router's own: it answers the browser's config, or passes
//              a WebSocket to AppSync. Other /__platform/realtime/* paths (the token) are the server's.
//   storage  - /__platform/storage/<store>/<key> of a public store, served from the storage bucket
//              (whose origin path adds `_public`); every other path below /__platform/storage/ is
//              not found, so it never reaches the server. The key stays percent-encoded, as S3
//              decodes it, and keys with `.` or `..` segments (also encoded) are refused.

export function decide(rec, uri) {
  if (!rec || (!rec.o && !rec.s && !rec.p)) return { t: 'notfound' };
  if (uri.indexOf('/__platform/') === 0) {
    if (uri.indexOf('/__platform/storage/') === 0) return storage(rec, uri.substring(20));
    if (uri === '/__platform/realtime' && rec.rt) return { t: 'realtime' };
    if (rec.o) return { t: 'server' };
    return uri === '/__platform/health' ? { t: 'health' } : { t: 'notfound' };
  }
  if (!rec.s) return rec.o ? { t: 'server' } : { t: 'notfound' };
  if (rec.o) {
    var routes = rec.r || [];
    for (var i = 0; i < routes.length; i++) {
      var p = routes[i];
      var bare = p.charAt(p.length - 1) === '/' ? p.substring(0, p.length - 1) : p;
      if (uri.indexOf(p) === 0 || uri === bare) return { t: 'server' };
    }
  }
  var last = uri.substring(uri.lastIndexOf('/') + 1);
  if (last.indexOf('.') !== -1) return { t: 'static', key: '/' + rec.s + uri };
  if (rec.spa) return { t: 'static', key: '/' + rec.s + '/index.html' };
  if (rec.o) return { t: 'server' };
  var dir = uri.charAt(uri.length - 1) === '/' ? uri : uri + '/';
  return { t: 'static', key: '/' + rec.s + dir + 'index.html' };
}

function storage(rec, rest) {
  var slash = rest.indexOf('/');
  if (slash <= 0) return { t: 'notfound' };
  var store = rest.substring(0, slash);
  var key = rest.substring(slash + 1);
  if (!rec.p || rec.p.indexOf(store) === -1 || !servableKey(key)) return { t: 'notfound' };
  return { t: 'storage', key: '/' + rec.app + '/' + rec.stage + '/' + store + '/' + key };
}

// isServableKey in storage.ts. S3 decodes the key once, so an encoded dot or slash counts as one.
function servableKey(key) {
  if (!key) return false;
  var parts = key.replace(/%2e/gi, '.').replace(/%2f/gi, '/').split('/');
  for (var i = 0; i < parts.length; i++) {
    if (parts[i] === '.' || parts[i] === '..') return false;
  }
  return true;
}
