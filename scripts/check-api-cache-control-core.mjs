// Whether every route whose own caching must survive the proxy default is
// named in the policy.
//
// `/api/*` gets `private, no-store` from the proxy, because Next.js attaches no
// `Cache-Control` to a route handler response and a response with none is
// heuristically cacheable by a shared cache. A header set in middleware
// *overrides* the route's own -- measured, not assumed -- so the routes that
// deliberately permit storage or reuse are listed in
// lib/apiCacheControlPolicy.ts and skipped.
//
// The failure this prevents: someone adds `public, s-maxage=600` to a route,
// sees it work in development (where nothing caches anyway), and ships an
// endpoint the proxy quietly turns back into `private, no-store`. Nothing about
// that is visible in the route file.
//
// A `no-store` variant needs no entry. `private, no-store` says the same thing
// or more, so overriding it changes nothing.

/** Directives that permit a cache to store or reuse the response. */
const PERMITS_STORAGE_OR_REUSE = /(^|[,\s])(public|s-maxage|max-age|no-cache|no-transform|stale-while-revalidate|immutable)/i;

const CACHE_CONTROL_VALUE =
  /["']Cache-Control["']\s*[,:]\s*["']([^"']+)["']/gi;

/** `app/api/models/status/route.ts` -> `/api/models/status` */
export const pathnameForRouteFile = (file) =>
  "/" +
  file
    .replace(/^app\//, "")
    .replace(/\/route\.ts$/, "")
    .split("/")
    // Route groups do not appear in the URL.
    .filter((segment) => !segment.startsWith("(") || !segment.endsWith(")"))
    .join("/");

/**
 * Every `Cache-Control` value a route file names, with the ones that merely
 * restate `no-store` filtered out.
 */
export const routeCachingDeclarations = (routes) =>
  routes
    .map(({ file, source }) => {
      const values = Array.from(
        source.matchAll(CACHE_CONTROL_VALUE),
        (match) => match[1]
      );
      return {
        file,
        pathname: pathnameForRouteFile(file),
        values,
        // A value is only interesting if it lets a cache keep or reuse the
        // response. `no-store, max-age=0` contains max-age but is still a
        // refusal, so the no-store test comes first.
        cachingValues: values.filter(
          (value) =>
            !/(^|[,\s])no-store/i.test(value) &&
            PERMITS_STORAGE_OR_REUSE.test(value)
        ),
      };
    })
    .filter((route) => route.values.length > 0);

export const auditApiCaching = ({ routes, exceptions }) => {
  const problems = [];
  const declared = routeCachingDeclarations(routes);
  const byPathname = new Map(exceptions.map((entry) => [entry.pathname, entry]));

  for (const route of declared) {
    if (route.cachingValues.length === 0) continue;
    if (byPathname.has(route.pathname)) continue;
    problems.push({
      kind: "unlisted",
      file: route.file,
      message:
        `${route.file} sets ${route.cachingValues.map((v) => `"${v}"`).join(", ")}, ` +
        `which the proxy default would replace with "private, no-store". ` +
        `Add ${route.pathname} to API_ROUTES_CHOOSING_THEIR_OWN_CACHING, or drop the header.`,
    });
  }

  const declaredByPathname = new Map(declared.map((route) => [route.pathname, route]));
  for (const exception of exceptions) {
    if (!exception.reason || exception.reason.trim() === "") {
      problems.push({
        kind: "no_reason",
        file: exception.route,
        message: `${exception.pathname} is exempt with no reason given.`,
      });
    }
    const route = declaredByPathname.get(exception.pathname);
    if (!route) {
      problems.push({
        kind: "stale",
        file: exception.route,
        message:
          `${exception.pathname} is exempt but its route names no Cache-Control. ` +
          "An exemption that describes nothing silently opts a route out of the default.",
      });
      continue;
    }
    if (route.file !== exception.route) {
      problems.push({
        kind: "wrong_file",
        file: exception.route,
        message: `${exception.pathname} names ${exception.route}; the route is ${route.file}.`,
      });
    }
    if (route.cachingValues.length === 0) {
      problems.push({
        kind: "unnecessary",
        file: route.file,
        message:
          `${exception.pathname} is exempt but only sets no-store variants, which the ` +
          "default already says. Remove the exemption.",
      });
    }
  }

  return problems;
};
