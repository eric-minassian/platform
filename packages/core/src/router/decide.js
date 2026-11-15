// Routing decision shared by the CloudFront Function (edge) and the `plat dev`
// local router. It is inlined verbatim into the CloudFront Function, so it must
// stay within the CloudFront Functions JavaScript runtime 2.0 subset: no imports,
// no external calls, plain functions, small. The `export` keyword is stripped
// when inlined.
//
// rec: route record from the KeyValueStore (see RouteRecord in router.ts)
//   o   - Web Function endpoint domain (server), optional
//   s   - static key prefix in the sites bucket, e.g. "foo/prod/d01j..." , optional
//   r   - server route prefixes when both o and s exist, e.g. ["/api/"]
//   spa - 1 to serve index.html for unknown non-file paths
// returns { t: 'server' } | { t: 'static', key: '/<prefix>/<path>' } | { t: 'notfound' }

export function decide(rec, uri) {
  if (!rec || (!rec.o && !rec.s)) return { t: 'notfound' };
  if (uri.indexOf('/__platform/') === 0) return rec.o ? { t: 'server' } : { t: 'notfound' };
  if (!rec.s) return { t: 'server' };
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
