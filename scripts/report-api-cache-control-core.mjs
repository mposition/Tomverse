// Which API routes leave `Cache-Control` to chance.
//
// Next.js attaches no `Cache-Control` to an App Router route handler's
// response. A response with no cache directive and a cacheable status is not
// "uncacheable" -- it is *heuristically* cacheable, and a shared cache may
// store and reuse it (RFC 9111 §4.2.2). Most route files here set `no-store`
// themselves. The ones that do not emit no directive at all.
//
// Measured on this tree, `next build && next start`, Next 16.3:
//
//   GET /api/build-info      -> cache-control: no-store        (route sets it)
//   GET /api/user/settings   -> (no cache-control header)
//   GET /api/conversations   -> (no cache-control header)
//   GET /api/user/usage      -> (no cache-control header)
//
// Two central fixes were tried and both are wrong, which is the more useful
// half of this note:
//
//   * setting it on `NextResponse.next()` in proxy.ts, and
//   * a `source: "/api/:path*"` entry in next.config's `headers()`
//
// both *override* a route's own header rather than defaulting behind it. Each
// turned `/api/public/proof-metrics` from its deliberate
// `public, s-maxage=300, stale-while-revalidate=3600` into `private, no-store`,
// which would take a CDN-cached public endpoint back to the origin on every
// request. In Next 16.3 the header has to be set where the response is made.
//
// So this reports rather than gates: the remedy is per-route and the routes
// below have not been changed. It is a survey for whoever schedules that work,
// in the shape of `report:credit-lot-invariants` -- a count that should move
// toward zero, not a check that blocks a merge today.

/** How a route file is recognised as needing a session. */
const AUTHENTICATION_MARKERS = [
  "getServerSession",
  "isAdminSession",
  "MAINTENANCE_SECRET",
];

const METHOD_PATTERN =
  /export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE|HEAD)\b/g;

export const readRouteCacheControl = (routes) =>
  routes.map(({ file, source }) => {
    const methods = [
      ...new Set(Array.from(source.matchAll(METHOD_PATTERN), (m) => m[1])),
    ].sort();
    return {
      file,
      methods,
      authenticated: AUTHENTICATION_MARKERS.some((marker) =>
        source.includes(marker)
      ),
      // Any Cache-Control at all: a route that deliberately caches has made a
      // decision, and this survey is about routes that made none.
      declaresCacheControl: /["']Cache-Control["']\s*[,:]/i.test(source),
    };
  });

/**
 * Routes worth reporting: authenticated, readable with a GET, and silent about
 * caching.
 *
 * GET because that is what a shared cache stores. A POST-only route is not
 * stored by a cache that follows the specification, and treating it as an
 * equal finding would bury the ones that matter.
 */
export const routesWithoutCacheControl = (routes) =>
  readRouteCacheControl(routes)
    .filter(
      (route) =>
        route.authenticated &&
        !route.declaresCacheControl &&
        route.methods.includes("GET")
    )
    .sort((left, right) => (left.file < right.file ? -1 : 1));

export const summarizeCacheControl = (routes) => {
  const read = readRouteCacheControl(routes);
  return {
    total: read.length,
    authenticated: read.filter((route) => route.authenticated).length,
    declaring: read.filter((route) => route.declaresCacheControl).length,
    silentAuthenticatedGets: routesWithoutCacheControl(routes).length,
  };
};
