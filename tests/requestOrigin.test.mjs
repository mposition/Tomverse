import assert from "node:assert/strict";
import test from "node:test";
import {
  hasValidMutationOrigin,
  requiresMutationOriginCheck,
} from "../lib/requestOrigin.ts";

test("cookie-auth mutation origin policy rejects cross-site requests", () => {
  assert.equal(
    hasValidMutationOrigin(
      new Request("https://tomverse.app/api/user/settings", {
        method: "POST",
        headers: { origin: "https://evil.example" },
      })
    ),
    false
  );
  assert.equal(
    hasValidMutationOrigin(
      new Request("https://tomverse.app/api/user/settings", {
        method: "POST",
        headers: { origin: "https://tomverse.app" },
      })
    ),
    true
  );
});

test("cookie-auth mutation origin policy uses the trusted public host behind a reverse proxy", () => {
  assert.equal(
    hasValidMutationOrigin(
      new Request("http://railway-internal:8080/api/chat", {
        method: "POST",
        headers: {
          host: "tomverse.app",
          origin: "https://tomverse.app",
          "x-forwarded-proto": "https",
        },
      })
    ),
    true
  );
  assert.equal(
    hasValidMutationOrigin(
      new Request("http://railway-internal:8080/api/chat", {
        method: "POST",
        headers: {
          host: "tomverse.app",
          origin: "https://evil.example",
          "x-forwarded-proto": "https",
        },
      })
    ),
    false
  );
});

test("cookie-auth mutation origin policy does not trust an unapproved Host header", () => {
  assert.equal(
    hasValidMutationOrigin(
      new Request("http://railway-internal:8080/api/chat", {
        method: "POST",
        headers: {
          host: "evil.example",
          origin: "https://evil.example",
          "x-forwarded-proto": "https",
        },
      })
    ),
    false
  );
});

test("machine-auth and webhook routes are exempt while user mutations are checked", () => {
  assert.equal(requiresMutationOriginCheck("POST", "/api/user/settings"), true);
  assert.equal(requiresMutationOriginCheck("DELETE", "/api/user/account"), true);
  assert.equal(requiresMutationOriginCheck("POST", "/api/internal/maintenance/cleanup"), false);
  assert.equal(requiresMutationOriginCheck("POST", "/api/billing/webhook"), false);
  assert.equal(requiresMutationOriginCheck("GET", "/api/user/settings"), false);
});
