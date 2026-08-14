import assert from "node:assert/strict";
import test from "node:test";

import {
  auditApiCaching,
  pathnameForRouteFile,
  routeCachingDeclarations,
} from "../scripts/check-api-cache-control-core.mjs";
import {
  API_ROUTES_CHOOSING_THEIR_OWN_CACHING,
  apiRouteChoosesOwnCaching,
  DEFAULT_API_CACHE_CONTROL,
  isApiPathname,
} from "../lib/apiCacheControlPolicy.ts";

// The proxy sets `private, no-store` on /api/* because Next.js sets no
// Cache-Control at all and a response with none is heuristically cacheable by a
// shared cache. A header set in middleware overrides the route's own -- that
// was measured against a real build, not assumed -- so the routes that
// deliberately permit storage or reuse are listed, and this is what keeps the
// list honest in both directions.

const route = (file, source) => ({ file, source });

test("a route permitting storage or reuse must be listed", () => {
  const problems = auditApiCaching({
    routes: [
      route("app/api/x/route.ts", '"Cache-Control": "public, s-maxage=600"'),
    ],
    exceptions: [],
  });
  assert.equal(problems.length, 1);
  assert.equal(problems[0].kind, "unlisted");
  assert.match(problems[0].message, /private, no-store/);
});

// The default already says this, so an entry would be noise -- and a needless
// exemption is a route quietly opted out of a safeguard.
test("a no-store variant needs no entry", () => {
  for (const value of [
    "no-store",
    "private, no-store",
    "no-store, max-age=0",
    "private, no-store, max-age=0",
  ]) {
    assert.deepEqual(
      auditApiCaching({
        routes: [route("app/api/x/route.ts", `"Cache-Control": "${value}"`)],
        exceptions: [],
      }),
      [],
      value
    );
  }
});

// `no-cache` is not `no-store`: the response may be stored and must be
// revalidated. The model catalogue's shared snapshot depends on that.
test("no-cache counts as a decision worth keeping", () => {
  const problems = auditApiCaching({
    routes: [route("app/api/x/route.ts", '"Cache-Control": "private, no-cache"')],
    exceptions: [],
  });
  assert.equal(problems[0]?.kind, "unlisted");
});

test("a listed route passes", () => {
  assert.deepEqual(
    auditApiCaching({
      routes: [
        route("app/api/x/route.ts", '"Cache-Control": "public, s-maxage=600"'),
      ],
      exceptions: [
        { pathname: "/api/x", route: "app/api/x/route.ts", reason: "public" },
      ],
    }),
    []
  );
});

test("an entry whose route names no Cache-Control is stale", () => {
  const problems = auditApiCaching({
    routes: [route("app/api/x/route.ts", "export async function GET() {}")],
    exceptions: [
      { pathname: "/api/x", route: "app/api/x/route.ts", reason: "was once" },
    ],
  });
  assert.equal(problems[0].kind, "stale");
});

test("an entry that only covers no-store variants is unnecessary", () => {
  const problems = auditApiCaching({
    routes: [route("app/api/x/route.ts", '"Cache-Control": "no-store"')],
    exceptions: [
      { pathname: "/api/x", route: "app/api/x/route.ts", reason: "not needed" },
    ],
  });
  assert.ok(problems.some((problem) => problem.kind === "unnecessary"));
});

test("an entry with no reason fails", () => {
  const problems = auditApiCaching({
    routes: [
      route("app/api/x/route.ts", '"Cache-Control": "public, s-maxage=600"'),
    ],
    exceptions: [
      { pathname: "/api/x", route: "app/api/x/route.ts", reason: "  " },
    ],
  });
  assert.ok(problems.some((problem) => problem.kind === "no_reason"));
});

test("a route file maps to its pathname, ignoring route groups", () => {
  assert.equal(
    pathnameForRouteFile("app/api/models/status/route.ts"),
    "/api/models/status"
  );
  assert.equal(
    pathnameForRouteFile("app/(site)/api/x/route.ts"),
    "/api/x"
  );
});

test("declarations record every value the file names", () => {
  const [declared] = routeCachingDeclarations([
    route(
      "app/api/x/route.ts",
      `"Cache-Control": "no-store"\n"Cache-Control": "public, max-age=60"`
    ),
  ]);
  assert.deepEqual(declared.values, ["no-store", "public, max-age=60"]);
  assert.deepEqual(declared.cachingValues, ["public, max-age=60"]);
});

// The runtime half: the proxy asks these two questions per request.
test("the proxy matches an exempt pathname exactly, trailing slash aside", () => {
  assert.equal(apiRouteChoosesOwnCaching("/api/models/status"), true);
  assert.equal(apiRouteChoosesOwnCaching("/api/models/status/"), true);
  // Not a prefix match: /api/models/status-history is a different route and
  // must not inherit the exemption.
  assert.equal(apiRouteChoosesOwnCaching("/api/models/status-history"), false);
  assert.equal(apiRouteChoosesOwnCaching("/api/user/settings"), false);
});

test("only /api paths take the default", () => {
  assert.equal(isApiPathname("/api/user/settings"), true);
  assert.equal(isApiPathname("/apidocs"), false);
  assert.equal(isApiPathname("/chat"), false);
});

test("every shipped exemption states a reason and names a real route file", () => {
  for (const exception of API_ROUTES_CHOOSING_THEIR_OWN_CACHING) {
    assert.ok(
      exception.reason.trim().length > 20,
      `${exception.pathname} has no usable reason`
    );
    assert.equal(
      pathnameForRouteFile(exception.route),
      exception.pathname,
      `${exception.route} does not serve ${exception.pathname}`
    );
  }
});

test("the default refuses both storing and sharing", () => {
  assert.match(DEFAULT_API_CACHE_CONTROL, /no-store/);
  assert.match(DEFAULT_API_CACHE_CONTROL, /private/);
});
