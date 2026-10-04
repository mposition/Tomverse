import assert from "node:assert/strict";
import test from "node:test";

import {
  MobileApiOriginError,
  MobileApiPathError,
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

const API_ORIGIN = "https://tomverse.app";

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
    apiOrigin: API_ORIGIN,
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
    apiOrigin: API_ORIGIN,
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
    apiOrigin: API_ORIGIN,
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
    apiOrigin: API_ORIGIN,
  });

  assert.equal(response.status, 401);
  assert.equal(seen.length, 1);
});

test("an expired or empty grant spends no request at all", async () => {
  for (const bad of [grant("token-1", -1_000), grant("", 600_000)]) {
    const { bridge } = bridgeReturning(bad);
    const { seen, fetchImpl } = responder(200);
    await assert.rejects(
      authenticatedFetch("/api/conversations", undefined, { bridge, fetchImpl, apiOrigin: API_ORIGIN }),
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
    authenticatedFetch("/api/a", undefined, { bridge, fetchImpl, apiOrigin: API_ORIGIN }),
    authenticatedFetch("/api/b", undefined, { bridge, fetchImpl, apiOrigin: API_ORIGIN }),
    authenticatedFetch("/api/c", undefined, { bridge, fetchImpl, apiOrigin: API_ORIGIN }),
  ]);

  assert.equal(calls.length, 3);
});

test("the caller's own headers survive, and only Authorization is imposed", async () => {
  const { bridge } = bridgeReturning(grant("token-1"));
  const { seen, fetchImpl } = responder(200);

  await authenticatedFetch(
    "/api/conversations",
    { method: "POST", headers: { "Content-Type": "application/json", "X-Trace": "abc" } },
    { bridge, fetchImpl, apiOrigin: API_ORIGIN }
  );

  const headers = new Headers(seen[0].init.headers);
  assert.equal(headers.get("Content-Type"), "application/json");
  assert.equal(headers.get("X-Trace"), "abc");
  assert.equal(seen[0].init.method, "POST");
});

// --- the path allowlist ---------------------------------------------------

test("a path is resolved against the API origin, not against the bundle's", async () => {
  // The bundle is served from capacitor://localhost, so a bare relative path
  // would reach nothing at all. What the caller passes is a path; the origin is
  // configuration.
  const { bridge } = bridgeReturning(grant("token-1"));
  const { seen, fetchImpl } = responder(200);

  await authenticatedFetch("/api/conversations", undefined, {
    bridge,
    fetchImpl,
    apiOrigin: API_ORIGIN,
  });

  assert.equal(seen[0].input, "https://tomverse.app/api/conversations");
});

test("a token is never attached to anything but this API", async () => {
  // The finding. A caller free to pass an absolute URL is a caller who can send
  // this device's access token wherever they like -- and the scheme-relative
  // form is the one that looks like a path while resolving elsewhere.
  const refused = [
    "https://evil.example/api/steal",
    "http://tomverse.app/api/conversations",
    "//evil.example/api/steal",
    "//tomverse.app/api/conversations",
    "/chat",
    "/",
    "/api",
    "/apiary/x",
    "/api/../../chat",
    "\\evil.example/api",
    "/api/\\..\\chat",
    "capacitor://localhost/api/x",
    "",
    "api/conversations",
  ];

  for (const path of refused) {
    const { bridge, calls } = bridgeReturning(grant("token-1"));
    const { seen, fetchImpl } = responder(200);
    await assert.rejects(
      authenticatedFetch(path, undefined, { bridge, fetchImpl, apiOrigin: API_ORIGIN }),
      MobileApiPathError,
      `${path} should be refused`
    );
    assert.equal(seen.length, 0, `${path}: no request may be made`);
    // And the bridge is not even asked, so a refused path cannot cause a
    // refresh either.
    assert.equal(calls.length, 0, `${path}: no token may be fetched`);
  }
});

test("an ordinary API path with a query and a fragment still resolves inside /api/", async () => {
  const { bridge } = bridgeReturning(grant("token-1"));
  const { seen, fetchImpl } = responder(200);

  await authenticatedFetch("/api/conversations?limit=20", undefined, {
    bridge,
    fetchImpl,
    apiOrigin: API_ORIGIN,
  });
  assert.equal(seen[0].input, "https://tomverse.app/api/conversations?limit=20");
});

test("a redirect is refused rather than followed", async () => {
  // Same-origin redirects keep the Authorization header, so following one
  // silently is how a token reaches a path nobody chose. Asserted as the
  // contract handed to fetch, which is where the platform enforces it.
  const { bridge } = bridgeReturning(grant("token-1"));
  const { seen, fetchImpl } = responder(200);

  await authenticatedFetch("/api/conversations", undefined, {
    bridge,
    fetchImpl,
    apiOrigin: API_ORIGIN,
  });
  assert.equal(seen[0].init.redirect, "error");
});

// --- the origin has to be an origin, and encrypted -------------------------

test("a plaintext origin is refused, and no token is fetched for it", async () => {
  // The finding. `http://tomverse.app` matches an origin comparison perfectly
  // and puts this device's access token on a plaintext connection.
  const refused = [
    ["http://tomverse.app", /only https/],
    ["capacitor://localhost", /only https/],
    ["file:///", /only https/],
    ["https://user:pass@tomverse.app", /credentials/],
    ["https://tomverse.app/api", /and nothing more/],
    ["https://tomverse.app/?x=1", /and nothing more/],
    ["https://tomverse.app/#x", /and nothing more/],
    ["not-a-url", /not a URL/],
    ["", /not a URL/],
  ];

  for (const [apiOrigin, message] of refused) {
    const { bridge, calls } = bridgeReturning(grant("token-1"));
    const { seen, fetchImpl } = responder(200);
    await assert.rejects(
      authenticatedFetch("/api/conversations", undefined, { bridge, fetchImpl, apiOrigin }),
      (error) => {
        assert.ok(error instanceof MobileApiOriginError, `${apiOrigin}: ${error}`);
        assert.match(error.message, message);
        return true;
      },
      `${apiOrigin} should be refused`
    );
    assert.equal(seen.length, 0, `${apiOrigin}: no request may be made`);
    assert.equal(calls.length, 0, `${apiOrigin}: no token may be fetched`);
  }
});

test("an origin with a trailing slash is the same origin", async () => {
  // A real value an operator would write. Refusing it would be pedantry, and
  // `new URL` normalises it to exactly the same origin.
  const { bridge } = bridgeReturning(grant("token-1"));
  const { seen, fetchImpl } = responder(200);

  await authenticatedFetch("/api/conversations", undefined, {
    bridge,
    fetchImpl,
    apiOrigin: "https://tomverse.app/",
  });
  assert.equal(seen[0].input, "https://tomverse.app/api/conversations");
});
