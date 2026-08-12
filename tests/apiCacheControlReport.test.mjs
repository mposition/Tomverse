import assert from "node:assert/strict";
import test from "node:test";

import {
  readRouteCacheControl,
  routesWithoutCacheControl,
  summarizeCacheControl,
} from "../scripts/report-api-cache-control-core.mjs";

// What the survey counts, and what it deliberately does not.
//
// Next.js attaches no Cache-Control to an App Router route handler's response,
// so a route that names none sends none -- and a response with no directive
// and a cacheable status is heuristically cacheable by a shared cache. The
// report exists because that is true of forty-one authenticated GET routes
// here, and because the two obvious central fixes both override a route's own
// header rather than defaulting behind it.

const route = (file, source) => ({ file, source });

const authenticatedGet = `
  import { getServerSession } from "next-auth/next";
  export async function GET() {
    return NextResponse.json({ ok: true });
  }
`;

test("an authenticated GET that names no caching is reported", () => {
  const findings = routesWithoutCacheControl([
    route("app/api/user/settings/route.ts", authenticatedGet),
  ]);
  assert.deepEqual(
    findings.map((finding) => finding.file),
    ["app/api/user/settings/route.ts"]
  );
});

test("a route that names any Cache-Control is not reported", () => {
  // Any value, not just no-store: a route that deliberately caches has made a
  // decision, and this survey is about routes that made none.
  for (const header of [
    '"Cache-Control": "no-store"',
    '"Cache-Control": "public, s-maxage=300"',
    'headers.set("Cache-Control", "private, no-cache")',
  ]) {
    assert.deepEqual(
      routesWithoutCacheControl([
        route("app/api/x/route.ts", `${authenticatedGet}\n${header}`),
      ]),
      []
    );
  }
});

// A shared cache stores responses to GET. Reporting a POST-only route would
// bury the ones that matter under ones a conforming cache never stores.
test("a route with no GET is not reported", () => {
  assert.deepEqual(
    routesWithoutCacheControl([
      route(
        "app/api/x/route.ts",
        `import { getServerSession } from "next-auth/next";
         export async function POST() { return NextResponse.json({}); }`
      ),
    ]),
    []
  );
});

test("an unauthenticated GET is not reported", () => {
  // A public response being cached is the intended behaviour of a public
  // response, not a finding.
  assert.deepEqual(
    routesWithoutCacheControl([
      route("app/api/public/x/route.ts", "export async function GET() {}"),
    ]),
    []
  );
});

test("each of the three authentication markers counts", () => {
  for (const marker of [
    "getServerSession",
    "isAdminSession",
    "MAINTENANCE_SECRET",
  ]) {
    const [read] = readRouteCacheControl([
      route("app/api/x/route.ts", `${marker}\nexport async function GET() {}`),
    ]);
    assert.equal(read.authenticated, true, marker);
  }
});

test("methods are reported, deduplicated and sorted", () => {
  const [read] = readRouteCacheControl([
    route(
      "app/api/x/route.ts",
      `export async function GET() {}
       export const POST = handler;
       export async function DELETE() {}`
    ),
  ]);
  assert.deepEqual(read.methods, ["DELETE", "GET", "POST"]);
});

test("the summary separates authenticated from declaring", () => {
  const summary = summarizeCacheControl([
    route("app/api/a/route.ts", authenticatedGet),
    route(
      "app/api/b/route.ts",
      `${authenticatedGet}\n"Cache-Control": "no-store"`
    ),
    route("app/api/c/route.ts", "export async function GET() {}"),
  ]);
  assert.deepEqual(summary, {
    total: 3,
    authenticated: 2,
    declaring: 1,
    silentAuthenticatedGets: 1,
  });
});
