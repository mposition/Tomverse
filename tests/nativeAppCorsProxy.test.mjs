// N1a, exercised through the real proxy rather than by reading its source.
//
// `tests/nativeAppCors.test.mjs` pins the decisions. This runs them: it builds
// a `NextRequest`, calls `proxy()`, and asserts on the response the edge would
// actually return. The distinction matters because the bug this milestone is
// written against is an *ordering* bug -- a check that is present but reached
// too late, or skipped by an earlier branch -- and no assertion over source
// text can see that.
//
// The three completion criteria for N1a, one describe block each:
//
//   1. an allowed preflight is answered correctly;
//   2. a forged bearer header changes nothing;
//   3. a native mutation is still refused, and the refusal is readable.

import assert from "node:assert/strict";
import test from "node:test";

import { NextRequest } from "next/server";

import { proxy } from "../proxy.ts";
import { NATIVE_APP_ORIGINS } from "../lib/nativeAppCors.ts";

const request = (init = {}, url = "https://tomverse.app/api/chat") =>
  new NextRequest(new Request(url, init));

const headerOf = (response, name) => response.headers.get(name);

const preflight = (origin, host = "tomverse.app") =>
  proxy(
    request({
      method: "OPTIONS",
      headers: {
        origin,
        host,
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization,content-type",
      },
    })
  );

// --- 1. the preflight is answered ----------------------------------------

test("an allowed preflight is answered 204 with the origin, methods and headers", () => {
  for (const origin of NATIVE_APP_ORIGINS) {
    const response = preflight(origin);
    assert.equal(response.status, 204, `${origin} preflight should be answered`);
    assert.equal(headerOf(response, "access-control-allow-origin"), origin);
    assert.match(
      headerOf(response, "access-control-allow-methods"),
      /\bPOST\b/
    );
    assert.match(
      headerOf(response, "access-control-allow-headers"),
      /\bAuthorization\b/
    );
    assert.ok(Number(headerOf(response, "access-control-max-age")) > 0);
    assert.equal(headerOf(response, "access-control-allow-credentials"), null);
    assert.match(headerOf(response, "vary"), /\bOrigin\b/);
  }
});

test("a hostile origin's preflight is not answered and carries no allowance", () => {
  for (const origin of [
    "https://attacker.example",
    "https://localhost.attacker.example",
    // Near misses. Any process on the machine can serve these, and neither is
    // an origin Capacitor produces.
    "https://localhost:3000",
    "http://localhost",
  ]) {
    const response = preflight(origin);
    assert.equal(
      headerOf(response, "access-control-allow-origin"),
      null,
      `${origin} must receive no Access-Control-Allow-Origin`
    );
    assert.notEqual(
      response.status,
      204,
      `${origin} must not receive the preflight answer`
    );
  }
});

test("a preflight does not skip the host allowlist", () => {
  const response = preflight("capacitor://localhost", "evil.example");
  assert.equal(response.status, 421);
  assert.equal(headerOf(response, "access-control-allow-origin"), null);
});

test("a preflight does not skip the Cloudflare origin-secret check", () => {
  // The check is off by default, so turning it on is the only way to observe
  // that the preflight branch sits behind it rather than in front of it.
  const previousRequire = process.env.REQUIRE_CLOUDFLARE_ORIGIN_SECRET;
  const previousSecret = process.env.CLOUDFLARE_ORIGIN_SECRET;
  process.env.REQUIRE_CLOUDFLARE_ORIGIN_SECRET = "true";
  process.env.CLOUDFLARE_ORIGIN_SECRET = "x".repeat(48);
  try {
    const refused = preflight("capacitor://localhost");
    assert.equal(refused.status, 421, "a preflight with no origin secret must be refused");
    assert.equal(headerOf(refused, "access-control-allow-origin"), null);

    const allowed = proxy(
      request({
        method: "OPTIONS",
        headers: {
          origin: "capacitor://localhost",
          host: "tomverse.app",
          "access-control-request-method": "POST",
          "x-tomverse-origin-verify": "x".repeat(48),
        },
      })
    );
    assert.equal(allowed.status, 204, "with the secret it is answered as usual");
    assert.equal(
      headerOf(allowed, "access-control-allow-origin"),
      "capacitor://localhost"
    );
  } finally {
    if (previousRequire === undefined) delete process.env.REQUIRE_CLOUDFLARE_ORIGIN_SECRET;
    else process.env.REQUIRE_CLOUDFLARE_ORIGIN_SECRET = previousRequire;
    if (previousSecret === undefined) delete process.env.CLOUDFLARE_ORIGIN_SECRET;
    else process.env.CLOUDFLARE_ORIGIN_SECRET = previousSecret;
  }
});

test("a bare OPTIONS is not treated as a preflight", () => {
  const response = proxy(
    request({
      method: "OPTIONS",
      headers: { origin: "capacitor://localhost", host: "tomverse.app" },
    })
  );
  assert.notEqual(response.status, 204);
});

// --- 2. a forged bearer header changes nothing ---------------------------

test("a forged Bearer header does not change any response", async () => {
  const withoutHeader = proxy(
    request({
      method: "POST",
      headers: { origin: "capacitor://localhost", host: "tomverse.app" },
    })
  );
  const withHeader = proxy(
    request({
      method: "POST",
      headers: {
        origin: "capacitor://localhost",
        host: "tomverse.app",
        authorization: "Bearer forged-token-value",
      },
    })
  );

  assert.equal(withHeader.status, withoutHeader.status);
  assert.equal(withHeader.status, 403);

  // Same refusal, field for field, except the per-request trace id.
  const body = async (response) => {
    const parsed = JSON.parse(await response.clone().text());
    delete parsed.traceId;
    return parsed;
  };
  assert.deepEqual(await body(withHeader), await body(withoutHeader));
  assert.deepEqual(await body(withHeader), {
    error: "Cross-site mutation request rejected.",
    code: "INVALID_REQUEST_ORIGIN",
  });
});

test("a forged Bearer header does not buy a hostile origin an allowance", () => {
  const response = proxy(
    request({
      method: "POST",
      headers: {
        origin: "https://attacker.example",
        host: "tomverse.app",
        authorization: "Bearer forged-token-value",
      },
    })
  );
  assert.equal(response.status, 403);
  assert.equal(headerOf(response, "access-control-allow-origin"), null);
});

// --- 3. native mutations stay refused, readably --------------------------

test("every mutating method from a native origin is still refused", async () => {
  for (const origin of NATIVE_APP_ORIGINS) {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const response = proxy(
        request({ method, headers: { origin, host: "tomverse.app" } })
      );
      assert.equal(
        response.status,
        403,
        `${method} from ${origin} must be refused before N1b`
      );
      // Readable, so the app can tell a refusal from an outage. This is the
      // whole difference N1a makes to a mutation: it does not become allowed,
      // it becomes diagnosable.
      assert.equal(headerOf(response, "access-control-allow-origin"), origin);
      const parsed = JSON.parse(await response.clone().text());
      assert.equal(parsed.code, "INVALID_REQUEST_ORIGIN");
    }
  }
});

test("a safe request from a native origin is readable", () => {
  for (const origin of NATIVE_APP_ORIGINS) {
    const response = proxy(
      request({ method: "GET", headers: { origin, host: "tomverse.app" } })
    );
    assert.equal(headerOf(response, "access-control-allow-origin"), origin);
    assert.match(headerOf(response, "vary"), /\bOrigin\b/);
  }
});

test("an ordinary web request is unchanged apart from Vary", () => {
  const response = proxy(
    request({ method: "GET", headers: { host: "tomverse.app" } })
  );
  assert.equal(headerOf(response, "access-control-allow-origin"), null);
  // Vary: Origin regardless, so a shared cache cannot replay a native-origin
  // response -- allowance header included -- to a request from another origin.
  assert.match(headerOf(response, "vary"), /\bOrigin\b/);
});

test("a non-API path gets no CORS headers at all", () => {
  const response = proxy(
    request(
      {
        method: "GET",
        headers: { origin: "capacitor://localhost", host: "tomverse.app" },
      },
      "https://tomverse.app/chat"
    )
  );
  assert.equal(headerOf(response, "access-control-allow-origin"), null);
});
