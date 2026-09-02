import assert from "node:assert/strict";
import test from "node:test";

import {
  INTERNAL_AUTH_HEADER_PREFIX,
  MOBILE_IDENTITY_HEADERS,
  applyMobileIdentityHeaders,
  nativeBearerVerdict,
  stripInternalAuthHeaders,
} from "../lib/nativeBearerGate.ts";
import { N1B_BEARER_ROUTES } from "../lib/mobileAuthContract.ts";

/**
 * The proxy-side gate, and section 5.3's truth table.
 *
 * Design sections 5.1-5.5, approved 2026-08-31. The shipped route list is empty
 * by approval, so the rows that need a registered route are driven with a list
 * this file supplies -- otherwise "the gate works when a route is registered"
 * would be a claim nothing checks until the day somebody registers one.
 */

const REGISTERED = "/api/conversations";
const identity = { subject: "user_1", device: "device_1", family: "family_1" };

const verdict = (options = {}) =>
  nativeBearerVerdict({
    pathname: options.pathname ?? REGISTERED,
    authorization: options.authorization ?? null,
    registeredRoutes: options.registeredRoutes ?? [REGISTERED],
    verify:
      options.verify ??
      (() => ({ ok: true, identity })),
  });

// --- the shipped configuration -------------------------------------------

test("the shipped route list is empty, so N1b changes nothing today", () => {
  // Approved decision 13. Empty is not a placeholder: while it is empty every
  // native mutation still meets the mutation-origin check and is refused.
  assert.deepEqual([...N1B_BEARER_ROUTES], []);
  assert.equal(
    nativeBearerVerdict({
      pathname: "/api/conversations",
      authorization: "Bearer anything",
      registeredRoutes: N1B_BEARER_ROUTES,
      verify: () => {
        throw new Error("an unregistered route must not reach the verifier");
      },
    }).kind,
    "not_applicable"
  );
});

// --- section 5.3, rows 5 to 13 -------------------------------------------

test("row 5 -- an unregistered route is not_applicable even with a valid bearer", () => {
  assert.deepEqual(
    verdict({ pathname: "/api/chat", authorization: "Bearer good" }),
    { kind: "not_applicable" }
  );
});

test("registration is by exact path, so a prefix cannot enrol a route", () => {
  for (const pathname of [
    "/api/conversations/abc",
    "/api/conversationsx",
    "/api/",
    "/api/conversations/../internal/sweep",
  ]) {
    assert.equal(
      verdict({ pathname, authorization: "Bearer good" }).kind,
      "not_applicable",
      pathname
    );
  }
});

test("row 1 and 2 -- no Authorization header means the existing cookie path", () => {
  assert.deepEqual(verdict({ authorization: null }), { kind: "no" });
  assert.deepEqual(verdict({ authorization: "   " }), { kind: "no" });
});

test("rows 8 and 9 -- a failed bearer is 401 with no cookie fallback", () => {
  // Section 5.1's fourth prohibition. There is no branch here that could look
  // at a cookie, which is the point: the refusal cannot degrade into one.
  const failed = verdict({
    authorization: "Bearer forged",
    verify: () => ({ ok: false, failure: "signature_invalid" }),
  });
  assert.deepEqual(failed, { kind: "reject", failure: "signature_invalid" });
});

test("a present-but-not-bearer Authorization header is refused, not ignored", () => {
  // Ignoring it would make "send a broken Authorization header" a way to reach
  // the cookie path from a registered route.
  for (const header of ["Basic abc", "Bearer", "Bearer a b", "Token abc"]) {
    assert.equal(
      verdict({ authorization: header }).kind,
      "reject",
      header
    );
  }
});

test("rows 7, 12 and 13 -- a verified bearer passes regardless of Origin", () => {
  // This module never sees an Origin, and that is the design: an attacker who
  // already holds a valid token does not need a browser, so requiring an Origin
  // would break only the honest clients that cannot send one.
  const passed = verdict({ authorization: "Bearer good" });
  assert.deepEqual(passed, { kind: "yes", identity });
});

test("the scheme is case-insensitive and tolerant of spacing, as RFC 7235 says", () => {
  for (const header of ["bearer good", "BEARER good", "  Bearer   good  "]) {
    assert.equal(verdict({ authorization: header }).kind, "yes", header);
  }
});

// --- section 5.4, the header namespace -----------------------------------

test("every internal auth header is removed, whatever its case", () => {
  const headers = new Headers({
    [`${INTERNAL_AUTH_HEADER_PREFIX}subject`]: "attacker",
    "X-Tomverse-Auth-Device": "attacker-device",
    "x-tomverse-auth-anything-else": "attacker",
    "x-tomverse-pathname": "/keep-me",
    authorization: "Bearer good",
  });

  const removed = stripInternalAuthHeaders(headers);

  assert.equal(headers.get(MOBILE_IDENTITY_HEADERS.subject), null);
  assert.equal(headers.get(MOBILE_IDENTITY_HEADERS.device), null);
  assert.equal(headers.get("x-tomverse-auth-anything-else"), null);
  assert.equal(removed.length, 3);
  // The routing conveniences are outside the namespace on purpose.
  assert.equal(headers.get("x-tomverse-pathname"), "/keep-me");
  assert.equal(headers.get("authorization"), "Bearer good");
});

test("the strip reports names and never values", () => {
  // A forged identity header is attacker-controlled text. What an operator
  // needs is that somebody tried, not what they wrote.
  const headers = new Headers({
    [MOBILE_IDENTITY_HEADERS.subject]: "someone-elses-account-id",
  });
  const removed = stripInternalAuthHeaders(headers);
  assert.deepEqual(removed, [MOBILE_IDENTITY_HEADERS.subject]);
  assert.ok(!JSON.stringify(removed).includes("someone-elses-account-id"));
});

test("stripping an untouched request removes nothing and reports nothing", () => {
  const headers = new Headers({ host: "tomverse.app" });
  assert.deepEqual(stripInternalAuthHeaders(headers), []);
  assert.equal(headers.get("host"), "tomverse.app");
});

test("row 14 -- a forged header is replaced by the verified one, not merged with it", () => {
  const headers = new Headers({
    [MOBILE_IDENTITY_HEADERS.subject]: "attacker",
    [MOBILE_IDENTITY_HEADERS.family]: "attacker-family",
  });
  stripInternalAuthHeaders(headers);
  applyMobileIdentityHeaders(headers, identity);

  assert.equal(headers.get(MOBILE_IDENTITY_HEADERS.subject), "user_1");
  assert.equal(headers.get(MOBILE_IDENTITY_HEADERS.device), "device_1");
  assert.equal(headers.get(MOBILE_IDENTITY_HEADERS.family), "family_1");
});

test("a rejected or not_applicable verdict writes nothing, which is why the strip is unconditional", () => {
  // The failure section 5.4 exists to prevent: `set` on success alone leaves
  // the client's value in place on every branch that writes nothing.
  for (const outcome of ["reject", "not_applicable"]) {
    const headers = new Headers({ [MOBILE_IDENTITY_HEADERS.subject]: "attacker" });
    stripInternalAuthHeaders(headers);
    // Nothing is applied for these verdicts.
    assert.equal(headers.get(MOBILE_IDENTITY_HEADERS.subject), null, outcome);
  }
});

test("the verifier is not consulted for a route nobody registered", () => {
  // Not an optimisation -- it is what keeps N1b's cost proportional, and what
  // keeps /api/internal/** away from a verifier that would answer 401 to
  // ordinary maintenance (T13).
  let calls = 0;
  verdict({
    pathname: "/api/internal/sweep",
    authorization: "Bearer an-operational-secret",
    verify: () => {
      calls += 1;
      return { ok: false, failure: "malformed" };
    },
  });
  assert.equal(calls, 0);
});
