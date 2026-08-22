import assert from "node:assert/strict";
import { test } from "node:test";

import {
  OPERATOR_ALERT_PATHS,
  operatorAlertProbeResult,
} from "../lib/operatorAlertProbeCore.ts";

// What a test send through an operator-alert path reports back.
// Contract: docs/policy/email-notifications.md §14.1.
// Background: docs/ops/email-sending-domains.md §1.2, §3.5.2.

const probe = (send, recipient = "ops@example.com", path = "operational") =>
  operatorAlertProbeResult({ path, recipient, send });

test("both alert paths are covered, and only those", () => {
  // A path missing from this list has no way to be tested on purpose, which is
  // the state that let three of four senders drift onto a stale domain.
  assert.deepEqual([...OPERATOR_ALERT_PATHS], ["operational", "provider"]);
});

test("a delivered probe reports the address the provider accepted", () => {
  // Not the address this screen believes is configured. The gap between those
  // two is exactly what went unseen when the sending domain moved.
  const result = probe({
    ok: true,
    providerMessageId: "resend-1",
    from: "Tomverse Review <hello@mail.tomverse.app>",
  });
  assert.equal(result.delivered, true);
  assert.equal(result.from, "Tomverse Review <hello@mail.tomverse.app>");
  assert.equal(result.providerMessageId, "resend-1");
  assert.equal(result.recipient, "ops@example.com");
  assert.equal(result.failure, null);
});

test("no recipient is a failure with a name, not a silent pass", () => {
  // The path itself returns quietly here, which is right for an alert -- but a
  // probe that reported "fine" would be asserting that alerts reach somebody.
  const result = probe(null, null);
  assert.equal(result.delivered, false);
  assert.equal(result.failure.code, "RECIPIENT_NOT_CONFIGURED");
  assert.match(result.failure.message, /OPS_ALERT_EMAIL/);

  // Each path names its own variables: the operational path falls back to
  // ADMIN_ALERT_EMAIL and the provider path has only that one.
  const provider = operatorAlertProbeResult({
    path: "provider",
    recipient: null,
    send: null,
  });
  assert.equal(provider.failure.code, "RECIPIENT_NOT_CONFIGURED");
  assert.equal(/OPS_ALERT_EMAIL/.test(provider.failure.message), false);
});

test("the four ways a send fails are told apart", () => {
  // They need different repairs: set a key, set an address, wait, or call
  // somebody. Collapsing them into "failed" hands an operator no next step.
  assert.equal(
    probe({ ok: false, status: null, notConfigured: true }).failure.code,
    "PROVIDER_KEY_MISSING"
  );
  assert.equal(
    probe({ ok: false, status: null, identityRefusal: "MARKETING_FROM_MISSING" })
      .failure.code,
    "MARKETING_FROM_MISSING"
  );
  assert.equal(
    probe({ ok: false, status: null, transportError: new Error("socket") })
      .failure.code,
    "NO_RESPONSE"
  );
  assert.equal(probe({ ok: false, status: 401 }).failure.code, "HTTP_401");
});

test("a failure never carries the provider's own words", () => {
  // The provider's body can name a recipient, and this string is rendered to a
  // screen and written into an audit entry.
  const result = probe({ ok: false, status: 422 });
  assert.equal(result.from, null);
  assert.equal(result.providerMessageId, null);
  assert.equal(result.failure.code, "HTTP_422");
  assert.match(result.failure.message, /refused the message with 422/);
});

test("a path that never reached the provider says so", () => {
  const result = probe(null);
  assert.equal(result.delivered, false);
  assert.equal(result.failure.code, "NOT_ATTEMPTED");
});
