import assert from "node:assert/strict";
import test from "node:test";

import {
  MobileAuthUnavailableError,
  authenticatedFetch,
} from "../apps/mobile/src/authenticatedFetch.ts";

/**
 * How the app's JavaScript uses a token it is handed, and what it never does.
 *
 * Design D19 and section 4 option A, approved 2026-08-31.
 *
 * The interesting cases are all about *not* doing something: not looping, not
 * coalescing, not attaching cookies, not retrying with the token that just
 * failed. Under option A a redundant refresh is not a wasted request, it is a
 * replay -- and a replay destroys the family.
 */

const grant = (token, msFromNow = 600_000) => ({
  accessToken: token,
  expiresAt: Date.now() + msFromNow,
});

const bridgeReturning = (...grants) => {
  const queue = [...grants];
  const calls = [];
  return {
    calls,
    bridge: {
      getAccessToken: async () => {
        const next = queue.length > 1 ? queue.shift() : queue[0];
        calls.push(next);
        return next;
      },
    },
  };
};

const responder = (...statuses) => {
  const queue = [...statuses];
  const seen = [];
  return {
    seen,
    fetchImpl: async (input, init) => {
      seen.push({ input, init });
      const status = queue.length > 1 ? queue.shift() : queue[0];
      return new Response(null, { status });
    },
  };
};

test("the token is attached as a bearer, and no cookie goes with it", async () => {
  const { bridge } = bridgeReturning(grant("token-1"));
  const { seen, fetchImpl } = responder(200);

  const response = await authenticatedFetch("/api/conversations", { method: "POST" }, {
    bridge,
    fetchImpl,
  });

  assert.equal(response.status, 200);
  assert.equal(seen.length, 1);
  assert.equal(new Headers(seen[0].init.headers).get("Authorization"), "Bearer token-1");
  // Two auth models must not travel on one request (D13). Asking the browser
  // to attach an ambient credential to a bearer request is how a later reader
  // stops being able to tell which one the server used.
  assert.equal(seen[0].init.credentials, "omit");
});

test("a 401 is retried exactly once, with a token that is actually different", async () => {
  const { bridge, calls } = bridgeReturning(grant("token-1"), grant("token-2"));
  const { seen, fetchImpl } = responder(401, 200);

  const response = await authenticatedFetch("/api/conversations", undefined, {
    bridge,
    fetchImpl,
  });

  assert.equal(response.status, 200);
  assert.equal(seen.length, 2);
  assert.equal(calls.length, 2);
  assert.equal(new Headers(seen[1].init.headers).get("Authorization"), "Bearer token-2");
});

test("a second 401 is the answer, not the start of a loop", async () => {
  // A loop against a revoked session hammers refresh until something gives up,
  // and the session is not coming back: the family is revoked and every
  // refresh will be refused.
  const { bridge } = bridgeReturning(grant("token-1"), grant("token-2"));
  const { seen, fetchImpl } = responder(401, 401);

  const response = await authenticatedFetch("/api/conversations", undefined, {
    bridge,
    fetchImpl,
  });

  assert.equal(response.status, 401);
  assert.equal(seen.length, 2, "two attempts, and no more");
});

test("the same token is never presented twice", async () => {
  // The bridge had nothing newer. Sending it again asks the same question and
  // gets the same answer, and under option A a pointless extra round trip is
  // the shape a replay takes.
  const { bridge } = bridgeReturning(grant("token-1"));
  const { seen, fetchImpl } = responder(401, 200);

  const response = await authenticatedFetch("/api/conversations", undefined, {
    bridge,
    fetchImpl,
  });

  assert.equal(response.status, 401);
  assert.equal(seen.length, 1);
});

test("an expired or empty grant spends no request at all", async () => {
  for (const bad of [grant("token-1", -1_000), grant("", 600_000)]) {
    const { bridge } = bridgeReturning(bad);
    const { seen, fetchImpl } = responder(200);
    await assert.rejects(
      authenticatedFetch("/api/conversations", undefined, { bridge, fetchImpl }),
      MobileAuthUnavailableError
    );
    assert.equal(seen.length, 0);
  }
});

test("concurrent callers each ask the bridge, because single-flight is the native layer's", async () => {
  // Deliberate. Coalescing here would be a second single-flight the native one
  // knows nothing about, and two of them are worse than one: the JS side cannot
  // see a refresh the native side started.
  const { bridge, calls } = bridgeReturning(grant("token-1"));
  const { fetchImpl } = responder(200);

  await Promise.all([
    authenticatedFetch("/a", undefined, { bridge, fetchImpl }),
    authenticatedFetch("/b", undefined, { bridge, fetchImpl }),
    authenticatedFetch("/c", undefined, { bridge, fetchImpl }),
  ]);

  assert.equal(calls.length, 3);
});

test("the caller's own headers survive, and only Authorization is imposed", async () => {
  const { bridge } = bridgeReturning(grant("token-1"));
  const { seen, fetchImpl } = responder(200);

  await authenticatedFetch(
    "/api/conversations",
    { method: "POST", headers: { "Content-Type": "application/json", "X-Trace": "abc" } },
    { bridge, fetchImpl }
  );

  const headers = new Headers(seen[0].init.headers);
  assert.equal(headers.get("Content-Type"), "application/json");
  assert.equal(headers.get("X-Trace"), "abc");
  assert.equal(seen[0].init.method, "POST");
});
