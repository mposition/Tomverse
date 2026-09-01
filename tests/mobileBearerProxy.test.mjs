// Section 5.4 and 5.5, exercised through the real `proxy()`.
//
// `tests/nativeBearerGate.test.mjs` pins the gate's decisions with an injected
// route list. This runs the edge as deployed -- with `N1B_BEARER_ROUTES` empty,
// as approved -- and asserts what a request actually gets back.
//
// Two things can only be seen here:
//
//   1. **the order.** Section 5.5 requires the internal-header strip and the
//      bearer verdict to happen before the mutation-origin check. A check that
//      is present but reached too late is invisible to any assertion over
//      source text;
//   2. **that the empty list really is inert.** Adding the gate must not have
//      changed a single response while no route is registered, and "must not
//      have changed anything" is a claim about behaviour, not about code.

import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import test from "node:test";

import { NextRequest } from "next/server";

import { proxy } from "../proxy.ts";
import { MOBILE_IDENTITY_HEADERS } from "../lib/nativeBearerGate.ts";
import { NATIVE_APP_ORIGINS } from "../lib/nativeAppCors.ts";

// A real deployment configuration, so the vectors below can present a token
// this process would actually accept rather than a string shaped like one.
process.env.MOBILE_AUTH_SIGNING_KEYS = `sign-1:${generateKeyPairSync("ed25519")
  .privateKey.export({ format: "der", type: "pkcs8" })
  .toString("base64")}`;
process.env.MOBILE_AUTH_ACTIVE_SIGNING_KEY_ID = "sign-1";
process.env.MOBILE_AUTH_REFRESH_PEPPERS = `pep-1:${randomBytes(32).toString("base64url")}`;
process.env.MOBILE_AUTH_ACTIVE_REFRESH_PEPPER_ID = "pep-1";
process.env.MOBILE_AUTH_TOKEN_ISSUER = "https://tomverse.app";
process.env.MOBILE_AUTH_TOKEN_AUDIENCE = "tomverse-mobile-api";

const { mintMobileAccessToken } = await import("../lib/mobileAccessToken.ts");

const validBearer = () =>
  `Bearer ${
    mintMobileAccessToken({
      userId: "user_1",
      deviceId: "device_1",
      familyId: "family_1",
    }).token
  }`;

const request = (init = {}, url = "https://tomverse.app/api/conversations") =>
  new NextRequest(new Request(url, init));

const post = (headers, url) =>
  proxy(request({ method: "POST", headers: { host: "tomverse.app", ...headers } }, url));

const get = (headers, url = "https://tomverse.app/chat") =>
  proxy(request({ headers: { host: "tomverse.app", ...headers } }, url));

// --- 1. a bearer header never buys anything by existing ------------------

test("a bearer header does not skip the mutation-origin check", async () => {
  // Section 5.1's first prohibition, and the reason the whole milestone is
  // split into N1a, N2 and N1b. `proxy.ts`'s own prefetch comment says it:
  // gating a security layer on a request header lets any caller opt out of it.
  for (const origin of NATIVE_APP_ORIGINS) {
    const response = await post({ origin, authorization: "Bearer anything" });
    assert.equal(response.status, 403, origin);
    assert.equal((await response.json()).code, "INVALID_REQUEST_ORIGIN");
  }
});

test("a hostile origin with a bearer header is still 403, and cannot read it", async () => {
  const response = await post({
    origin: "https://evil.example",
    authorization: "Bearer anything",
  });
  assert.equal(response.status, 403);
  // No allowance for that origin, so the browser cannot show the body either.
  assert.equal(response.headers.get("access-control-allow-origin"), null);
});

test("with the shipped empty route list, a malformed bearer is not a 401", async () => {
  // The gate's `reject` branch is real, but it is only reachable from a
  // registered route. On an unregistered one the verdict is `not_applicable`
  // and the request meets exactly what it met before -- here, the 403.
  const response = await post({
    origin: NATIVE_APP_ORIGINS[0],
    authorization: "not-even-a-scheme",
  });
  assert.equal(response.status, 403);
});

// --- 2. the internal namespace, on every branch --------------------------

const forged = {
  [MOBILE_IDENTITY_HEADERS.subject]: "someone-elses-account",
  [MOBILE_IDENTITY_HEADERS.device]: "someone-elses-device",
  [MOBILE_IDENTITY_HEADERS.family]: "someone-elses-family",
};

const forwardedHeaders = (response) => {
  // What NextResponse.next({ request: { headers } }) forwards is carried on the
  // response as an override header; reading it is how a test can see the
  // headers the route will be given.
  const override = response.headers.get("x-middleware-override-headers");
  if (!override) return null;
  const forwarded = new Headers();
  for (const name of override.split(",").map((value) => value.trim())) {
    if (!name) continue;
    const value = response.headers.get(`x-middleware-request-${name}`);
    if (value !== null) forwarded.set(name, value);
  }
  return forwarded;
};

test("a client-sent identity header never reaches a route", async () => {
  const response = await get(forged);
  const headers = forwardedHeaders(response);
  assert.ok(headers, "a document request should forward rewritten headers");
  for (const name of Object.values(MOBILE_IDENTITY_HEADERS)) {
    assert.equal(headers.get(name), null, name);
  }
});

test("the strip survives the prefetch branch, which is the one early return that reaches a route", async () => {
  // `NextResponse.next()` with no argument forwards the request untouched, so
  // this branch is exactly where a forged header would have survived.
  const response = await get({ ...forged, "next-router-prefetch": "1" });
  const override = response.headers.get("x-middleware-override-headers");
  // Asserted rather than tolerated: before the strip moved above this branch,
  // there was no override list at all here and the request went through
  // untouched. An absent list would be that behaviour returning, and a test
  // that shrugged at it would pass through the regression.
  assert.ok(override, "the prefetch branch must forward rewritten headers");

  const headers = forwardedHeaders(response);
  for (const name of Object.values(MOBILE_IDENTITY_HEADERS)) {
    assert.equal(headers.get(name), null, name);
    assert.ok(!override.includes(name), name);
  }
});

test("the routing conveniences outside the namespace are untouched", async () => {
  // `x-tomverse-pathname` is deliberately not in the auth namespace: it is a
  // routing convenience every consumer already treats as raw input.
  const response = await get({});
  const headers = forwardedHeaders(response);
  assert.equal(headers?.get("x-tomverse-pathname"), "/chat");
});

// --- 3. the vectors that need a genuinely valid token --------------------

test("V27 -- a valid mobile bearer on an unregistered route is still 403", async () => {
  // Not 401, and not 200. N1b is not applied to a route nobody registered, so
  // the request meets the mutation-origin check exactly as it did before N2 --
  // which is the whole point of an opt-in list.
  for (const origin of NATIVE_APP_ORIGINS) {
    const response = await post({ origin, authorization: validBearer() });
    assert.equal(response.status, 403, origin);
    assert.equal((await response.json()).code, "INVALID_REQUEST_ORIGIN");
  }
});

test("V26 -- an operational secret on an internal route is untouched", async () => {
  // `/api/internal/**` uses `Authorization: Bearer <operational secret>`, which
  // is not a JWT. Putting those routes behind the mobile verifier would answer
  // 401 to ordinary maintenance (T13), so the gate must not run there at all.
  const response = await post(
    { authorization: "Bearer an-operational-secret" },
    "https://tomverse.app/api/internal/maintenance/cleanup"
  );
  // A pass-through, not merely "not a 401": the proxy hands the request on and
  // the route checks its own secret, exactly as it did before N2.
  assert.equal(response.headers.get("x-middleware-next"), "1");
  // And the header the route authenticates with survives the strip, because it
  // is not in the internal identity namespace.
  assert.equal(
    response.headers.get("x-middleware-request-authorization"),
    "Bearer an-operational-secret"
  );
});

test("V26b -- a valid mobile token on an internal route is the route's business, not the gate's", async () => {
  // The proxy does not answer this one. The internal route checks its own
  // secret and refuses; nothing about N1b is involved either way.
  const response = await post(
    { authorization: validBearer() },
    "https://tomverse.app/api/internal/maintenance/cleanup"
  );
  assert.equal(response.headers.get("x-middleware-next"), "1");
  // No identity header is written, because the gate never ran.
  for (const name of Object.values(MOBILE_IDENTITY_HEADERS)) {
    assert.equal(response.headers.get(`x-middleware-request-${name}`), null, name);
  }
});

test("a valid bearer does not turn a hostile origin into an allowed one", async () => {
  // Row 11. The token is real; the origin is not ours and the route is not
  // registered, so this is a 403 with no allowance for the origin to read.
  const response = await post({
    origin: "https://evil.example",
    authorization: validBearer(),
  });
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("access-control-allow-origin"), null);
});

// --- 3. nothing else moved ----------------------------------------------

test("an ordinary same-origin mutation is unaffected", async () => {
  const response = await post({ origin: "https://tomverse.app" });
  assert.equal(response.headers.get("x-middleware-next"), "1");
  for (const name of Object.values(MOBILE_IDENTITY_HEADERS)) {
    assert.equal(response.headers.get(`x-middleware-request-${name}`), null, name);
  }
});

test("a preflight is still answered before any of this", async () => {
  const response = proxy(
    request({
      method: "OPTIONS",
      headers: {
        host: "tomverse.app",
        origin: NATIVE_APP_ORIGINS[0],
        authorization: "Bearer anything",
        "access-control-request-method": "POST",
      },
    })
  );
  assert.equal(response.status, 204);
});

test("the host and origin-secret boundary still comes first", async () => {
  // Step 2 of the order. A bearer header, a forged identity header and a
  // disallowed host together are still a 421 -- nothing below step 2 ran.
  const response = await post({
    host: "not-tomverse.example",
    origin: NATIVE_APP_ORIGINS[0],
    authorization: "Bearer anything",
    ...forged,
  });
  assert.equal(response.status, 421);
});
