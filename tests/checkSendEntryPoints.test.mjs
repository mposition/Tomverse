import assert from "node:assert/strict";
import test from "node:test";

import {
  SEND_ALLOWLIST,
  SEND_ENTRY_POINTS,
  sendEntryPointUses,
  sendEntryPointViolations,
  staleAllowlistEntries,
} from "../scripts/check-send-entry-points-core.mjs";

// Who may put a message on the wire.
//
// Contract: docs/policy/email-product-news-redesign-draft.md section 7.4 (C41).
//
// The check is the gate that makes "every customer-facing send takes the
// address lock" enforceable rather than a habit, so these drive it on the
// shapes a real file uses -- including the two that look like a send and are
// not.

test("an import of a send entry point is a use of it", () => {
  assert.deepEqual(
    sendEntryPointUses(`import { deliverEmailOnce } from "@/lib/email";`),
    ["deliverEmailOnce"]
  );
  assert.deepEqual(
    sendEntryPointUses(`import { sendTransactionalEmail } from "@/lib/email";`),
    ["sendTransactionalEmail"]
  );
  // Beside another import from the same module, and over more than one line.
  assert.deepEqual(
    sendEntryPointUses(
      `import {\n  deliverEmailOnce,\n  type ProviderSendResult,\n} from "@/lib/email";`
    ),
    ["deliverEmailOnce"]
  );
  // A relative path reaches the same module.
  assert.deepEqual(
    sendEntryPointUses(`import { deliverEmailOnce } from "../lib/email";`),
    ["deliverEmailOnce"]
  );
});

test("calling the port's send is a use; asking it anything else is not", () => {
  assert.deepEqual(sendEntryPointUses(`await emailProvider().send(message, options)`), [
    "emailProvider().send",
  ]);
  // Every webhook route calls this, and none of them sends anything.
  assert.deepEqual(
    sendEntryPointUses(`emailProvider().verifyWebhook(raw, headers, stream)`),
    []
  );
});

test("a name that merely appears is not a use", () => {
  // A comment naming the function, or a test asserting on the string, must not
  // put a file on the list -- the check would then be noise nobody reads.
  assert.deepEqual(
    sendEntryPointUses(`// sendTransactionalEmail is what this replaced.`),
    []
  );
  assert.deepEqual(sendEntryPointUses(`const name = "deliverEmailOnce";`), []);
});

test("a file that is not allowed to send is reported", () => {
  const violations = sendEntryPointViolations([
    { path: "lib/somethingNew.ts", source: `import { deliverEmailOnce } from "@/lib/email";` },
    { path: "lib/emailSendLock.ts", source: `import { deliverEmailOnce } from "@/lib/email";` },
  ]);
  assert.deepEqual(
    violations.map((v) => v.path),
    ["lib/somethingNew.ts"]
  );
});

test("the notification queue is deliberately not on the list", () => {
  // It carries both kinds. Allowing the file would also allow a customer send
  // in it to skip the address lock, which is the bypass this exists to catch.
  assert.equal(Object.hasOwn(SEND_ALLOWLIST, "lib/notificationDeliveries.ts"), false);
  assert.equal(Object.hasOwn(SEND_ALLOWLIST, "lib/operatorNotificationSend.ts"), true);
});

test("every allowlist entry says why it is allowed", () => {
  for (const [path, reason] of Object.entries(SEND_ALLOWLIST)) {
    assert.equal(typeof reason, "string", path);
    assert.ok(reason.length > 30, `${path}: the reason is what a reader needs`);
  }
});

test("an allowlisted file that stopped sending is reported, not failed", () => {
  const files = Object.keys(SEND_ALLOWLIST).map((path) => ({ path, source: "" }));
  assert.deepEqual(staleAllowlistEntries(files).sort(), Object.keys(SEND_ALLOWLIST).sort());
  assert.deepEqual(sendEntryPointViolations(files), []);
});

test("the three ways to reach the provider are the ones named", () => {
  assert.deepEqual(SEND_ENTRY_POINTS, [
    "deliverEmailOnce",
    "sendTransactionalEmail",
    "emailProvider().send",
  ]);
});
