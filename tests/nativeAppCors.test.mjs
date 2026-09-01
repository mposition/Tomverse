// N1a. What the Capacitor shell may read, and what nobody else may.
//
// Contract: .github/audits/2026-08-30-native-mobile-readiness.md §3.1.
//
// The completion criteria for N1a are three, and each has cases here:
//
//   1. a preflight from an allowed origin gets a correct CORS answer;
//   2. a forged `Authorization` header buys nothing;
//   3. a native mutation stays blocked until N1b exists.
//
// (2) was written when nothing in the edge read `Authorization` at all, as a
// test that would fail the day something did. It did its job: N2 added the
// verifier and this file failed, which is where the rewritten pair below came
// from. The rule it enforces is unchanged -- the header may be read, but only
// to be verified, and a security decision is never made on its presence.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import {
  NATIVE_APP_ORIGINS,
  isNativeAppOrigin,
  isPreflightRequest,
  nativeAppCorsHeaders,
  nativeAppPreflightHeaders,
  varyWithOrigin,
} from "../lib/nativeAppCors.ts";

/** Source with block and line comments removed. */
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const CAPACITOR_CONFIG = readFileSync("apps/mobile/capacitor.config.ts", "utf8");
const PROXY = readFileSync("proxy.ts", "utf8");
const REQUEST_ORIGIN = readFileSync("lib/requestOrigin.ts", "utf8");
const NATIVE_CORS = readFileSync("lib/nativeAppCors.ts", "utf8");

test("the allowlist is exactly the two origins Capacitor produces", () => {
  assert.deepEqual([...NATIVE_APP_ORIGINS], [
    "capacitor://localhost",
    "https://localhost",
  ]);
});

test("the shell overrides neither scheme, so those two origins are the real ones", () => {
  // If apps/mobile ever sets a scheme, the allowlist above is the other half
  // of that change and this fails until both move together.
  const server = /(^|[\s,{])server\s*:\s*\{/m.test(stripComments(CAPACITOR_CONFIG));
  assert.equal(server, false, "apps/mobile/capacitor.config.ts declares a server block");
});

test("an allowed origin gets a preflight answer with the methods and headers", () => {
  for (const origin of NATIVE_APP_ORIGINS) {
    const headers = nativeAppPreflightHeaders(origin);
    assert.ok(headers, `${origin} should be allowed`);
    assert.equal(headers["Access-Control-Allow-Origin"], origin);
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
      assert.match(headers["Access-Control-Allow-Methods"], new RegExp(`\\b${method}\\b`));
    }
    assert.match(headers["Access-Control-Allow-Headers"], /\bAuthorization\b/);
    assert.match(headers["Access-Control-Allow-Headers"], /\bContent-Type\b/);
    assert.ok(Number(headers["Access-Control-Max-Age"]) > 0);
  }
});

test("credentials are never allowed, on any answer", () => {
  for (const origin of NATIVE_APP_ORIGINS) {
    for (const headers of [
      nativeAppCorsHeaders(origin),
      nativeAppPreflightHeaders(origin),
    ]) {
      assert.ok(headers);
      assert.equal(
        Object.keys(headers).some(
          (key) => key.toLowerCase() === "access-control-allow-credentials"
        ),
        false
      );
    }
  }
  // Belt and braces: the header name appears nowhere in the module's *code*,
  // so it cannot be added by a branch this test did not think to exercise.
  // Comments are stripped first -- the module explains at length why this
  // header is absent, and that explanation is not a use of it.
  assert.equal(
    /Access-Control-Allow-Credentials/i.test(stripComments(NATIVE_CORS)),
    false
  );
});

test("a hostile or near-miss origin is refused, and never echoed", () => {
  const refused = [
    "https://attacker.example",
    "https://localhost.attacker.example",
    "https://localhost:3000",
    "http://localhost",
    "capacitor://localhost:1",
    "capacitor://evil",
    "https://tomverse.app.attacker.example",
    "null",
    "",
    null,
    undefined,
  ];
  for (const origin of refused) {
    assert.equal(isNativeAppOrigin(origin), false, `${origin} must not be allowed`);
    assert.equal(nativeAppCorsHeaders(origin), null);
    assert.equal(nativeAppPreflightHeaders(origin), null);
  }
});

test("a matched origin is answered with the canonical literal, not its own input", () => {
  const headers = nativeAppCorsHeaders("  CAPACITOR://LOCALHOST  ");
  assert.equal(headers?.["Access-Control-Allow-Origin"], "capacitor://localhost");
});

test("a preflight is an OPTIONS that asks about a method", () => {
  assert.equal(
    isPreflightRequest({ method: "OPTIONS", accessControlRequestMethod: "POST" }),
    true
  );
  assert.equal(
    isPreflightRequest({ method: "options", accessControlRequestMethod: "GET" }),
    true
  );
  // A bare OPTIONS is not a preflight and must not be answered as one.
  assert.equal(
    isPreflightRequest({ method: "OPTIONS", accessControlRequestMethod: null }),
    false
  );
  assert.equal(
    isPreflightRequest({ method: "OPTIONS", accessControlRequestMethod: "   " }),
    false
  );
  assert.equal(
    isPreflightRequest({ method: "POST", accessControlRequestMethod: "POST" }),
    false
  );
});

test("Vary keeps what was there and adds Origin once", () => {
  assert.equal(varyWithOrigin(null), "Origin");
  assert.equal(varyWithOrigin(""), "Origin");
  assert.equal(varyWithOrigin("Accept-Language"), "Accept-Language, Origin");
  assert.equal(varyWithOrigin("Origin"), "Origin");
  assert.equal(varyWithOrigin("origin"), "origin");
  assert.equal(
    varyWithOrigin("Accept-Language, Cookie"),
    "Accept-Language, Cookie, Origin"
  );
});

// --- criterion 2: a forged bearer header buys nothing ---------------------

test("the origin decision never reads an Authorization header", () => {
  // `Authorization: Bearer anything` must never be a switch that turns the
  // edge off. `lib/requestOrigin.ts` decides on origin alone and has no reason
  // to know the header exists.
  assert.equal(
    /authorization/i.test(stripComments(REQUEST_ORIGIN)),
    false,
    "lib/requestOrigin.ts reads an Authorization header outside a comment"
  );
});

test("proxy reads Authorization only to hand it to the verifier", () => {
  // Rewritten when N2 landed, and the original wording is why. It said "until
  // a verifier exists, the presence of `Authorization` must change nothing" --
  // a placeholder for the day one did. That day is here: proxy reads the
  // header, but only as an argument to `nativeBearerVerdict`, and the
  // mutation-origin check is replaced by the *verdict*, never by the header.
  //
  // The behavioural half of this lives in tests/mobileBearerProxy.test.mjs,
  // which sends a real bearer to a real proxy and gets a 403. This half is
  // about shape: the one thing a future edit could quietly do is condition the
  // check on the header instead of the verdict.
  const withoutComments = stripComments(PROXY);
  const reads = [...withoutComments.matchAll(/["']authorization["']/gi)];
  assert.equal(reads.length, 1, "exactly one read of the header, and it is the gate's");
  assert.match(
    withoutComments,
    /authorization:\s*request\.headers\.get\(["']authorization["']\)/i,
    "the only read should be the argument passed to nativeBearerVerdict"
  );

  // The bypass is on the verdict. A condition naming the header instead would
  // be exactly the switch this test exists to prevent.
  const guard = /bearer\.kind !== "yes"/.test(withoutComments);
  assert.ok(guard, "the mutation-origin check must be replaced by the verdict");
});

test("the CORS module decides on origin alone", () => {
  const withoutComments = stripComments(NATIVE_CORS);
  // `Authorization` appears once, as a value in the allowed-request-headers
  // list. It is never read from a request here.
  assert.equal(
    /request\.headers|headers\.get/i.test(withoutComments),
    false,
    "lib/nativeAppCors.ts should take strings, not a request"
  );
});

// --- criterion 3: native mutations stay blocked ---------------------------

test("the mutation-origin check still rejects both native origins", async () => {
  const { hasValidMutationOrigin, requiresMutationOriginCheck } = await import(
    "../lib/requestOrigin.ts"
  );
  for (const origin of NATIVE_APP_ORIGINS) {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      assert.equal(
        requiresMutationOriginCheck(method, "/api/chat"),
        true,
        `${method} /api/chat must still be checked`
      );
      const request = new Request("https://tomverse.app/api/chat", {
        method,
        headers: { origin, host: "tomverse.app" },
      });
      assert.equal(
        hasValidMutationOrigin(request),
        false,
        `${origin} must not satisfy the mutation-origin check before N1b`
      );
    }
  }
});

test("a forged bearer header does not satisfy the mutation-origin check either", async () => {
  const { hasValidMutationOrigin } = await import("../lib/requestOrigin.ts");
  const request = new Request("https://tomverse.app/api/chat", {
    method: "POST",
    headers: {
      origin: "capacitor://localhost",
      host: "tomverse.app",
      authorization: "Bearer not-a-real-token",
    },
  });
  assert.equal(hasValidMutationOrigin(request), false);
});

// The two assertions that used to live here -- "the refusal carries CORS
// headers" and "the preflight branch sits after the host and origin-secret
// checks" -- were reading `proxy.ts` as text. `tests/nativeAppCorsProxy.test.mjs`
// now calls `proxy()` and asserts on the response instead, which is strictly
// better evidence for an ordering property: a check that is present in the
// source but reached too late reads identically to one that is not.
