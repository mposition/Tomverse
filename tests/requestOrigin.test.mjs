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
  assert.equal(
    requiresMutationOriginCheck("POST", "/api/auth/email-login/request"),
    true
  );
  assert.equal(
    requiresMutationOriginCheck("POST", "/api/auth/callback/google"),
    false
  );
  assert.equal(requiresMutationOriginCheck("GET", "/api/user/settings"), false);
});

test("provider webhooks are exempt from the mutation-origin check", () => {
  // Resend, like any server-to-server caller, sends no Origin header. Without
  // the exemption every delivery, bounce and complaint event is rejected and
  // the suppression list silently never fills -- which presents as bounced
  // addresses being mailed forever.
  assert.equal(
    requiresMutationOriginCheck("POST", "/api/webhooks/email/resend"),
    false
  );

  // Everything under the prefix is exempt, and everything under it has to
  // carry its own proof of origin. This one is verified by its Svix signature.
  assert.equal(requiresMutationOriginCheck("POST", "/api/webhooks/anything"), false);

  // Nothing outside it gets in.
  assert.equal(requiresMutationOriginCheck("POST", "/api/webhook"), true);
  assert.equal(requiresMutationOriginCheck("POST", "/api/user/settings"), true);
});
