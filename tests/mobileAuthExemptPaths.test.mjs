import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { requiresMutationOriginCheck } from "../lib/requestOrigin.ts";

/**
 * The condition attached to the mobile auth mutation-origin exemption.
 *
 * Design D14, approved 2026-08-31: the three native paths are exempt *because*
 * they never accept a cookie identity. That sentence is only true while it is
 * true, and the day one of those handlers reaches for the session it becomes a
 * CSRF hole rather than a correct exception -- so the sentence is a test.
 */

const EXEMPT = [
  "/api/auth/mobile/exchange",
  "/api/auth/mobile/refresh",
  "/api/auth/mobile/logout",
];

const HANDLERS = {
  "/api/auth/mobile/exchange": "app/api/auth/mobile/exchange/route.ts",
  "/api/auth/mobile/refresh": "app/api/auth/mobile/refresh/route.ts",
  "/api/auth/mobile/logout": "app/api/auth/mobile/logout/route.ts",
};

const post = (pathname) => requiresMutationOriginCheck("POST", pathname);

test("the three native paths skip the mutation-origin check", () => {
  for (const pathname of EXEMPT) {
    assert.equal(post(pathname), false, pathname);
  }
});

test("no exempt handler reads a cookie identity", () => {
  // The whole basis of the exemption. A body credential is not ambient, so
  // CSRF has nothing to work with -- but a handler that also honoured the
  // cookie would be reachable cross-site with the check removed.
  for (const [pathname, file] of Object.entries(HANDLERS)) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    for (const forbidden of ["getServerSession", "cookies(", "next-auth", "auth()"]) {
      assert.ok(
        !source.includes(forbidden),
        `${pathname} references ${forbidden}, which would make its exemption a CSRF hole`
      );
    }
  }
});

test("device revocation is not exempt, because D14 puts it behind N1b", () => {
  // Until its route is registered in N1B_BEARER_ROUTES, a native POST here is
  // refused at the proxy. That is the intended state, not a gap.
  assert.equal(post("/api/auth/mobile/devices/abc/revoke"), true);
});

test("the grant endpoint is not exempt, because it is a browser request", () => {
  // It is authenticated by the cookie session, which is exactly the ambient
  // credential CSRF is about.
  assert.equal(post("/api/auth/mobile/login-grant"), true);
});

test("the exemption is by exact path, so a prefix cannot inherit it", () => {
  for (const pathname of [
    "/api/auth/mobile/exchange/anything",
    "/api/auth/mobile/refreshx",
    "/api/auth/mobile",
    "/api/auth/mobile/logout/../../chat",
  ]) {
    assert.equal(post(pathname), true, pathname);
  }
});

test("GET is unaffected either way", () => {
  assert.equal(
    requiresMutationOriginCheck("GET", "/api/auth/mobile/devices"),
    false
  );
});
