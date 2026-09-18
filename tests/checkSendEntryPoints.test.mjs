import assert from "node:assert/strict";
import test from "node:test";

import {
  SEND_ALLOWLIST,
  SEND_ENTRY_POINTS,
  SEND_SCAN,
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
// shapes a real file uses -- including the five an independent review listed as
// walking past the first version of it, and the ones that look like a send and
// are not.

const uses = (source) => sendEntryPointUses(source, "lib/example.ts");

test("an import of a send entry point is a use of it", () => {
  assert.deepEqual(uses(`import { deliverEmailOnce } from "@/lib/email";`), [
    "deliverEmailOnce",
  ]);
  assert.deepEqual(uses(`import { sendTransactionalEmail } from "@/lib/email";`), [
    "sendTransactionalEmail",
  ]);
  assert.deepEqual(
    uses(`import {\n  deliverEmailOnce,\n  type ProviderSendResult,\n} from "@/lib/email";`),
    ["deliverEmailOnce"]
  );
  assert.deepEqual(uses(`import { deliverEmailOnce } from "../lib/email";`), [
    "deliverEmailOnce",
  ]);
});

test("an alias does not hide the import", () => {
  assert.deepEqual(uses(`import { deliverEmailOnce as send } from "@/lib/email";`), [
    "deliverEmailOnce",
  ]);
});

// --- the five the first version let through ---------------------------------

test("a re-export carries the send with it", () => {
  assert.deepEqual(uses(`export { deliverEmailOnce as deliver } from "@/lib/email";`), [
    "deliverEmailOnce",
  ]);
  assert.deepEqual(uses(`export * from "@/lib/email";`), ["lib/email (whole module)"]);
  assert.deepEqual(uses(`export * as mail from "@/lib/email";`), [
    "lib/email (whole module)",
  ]);
});

test("taking the whole module is taking both of them", () => {
  assert.deepEqual(uses(`import * as mail from "@/lib/email";`), [
    "lib/email (whole module)",
  ]);
  assert.deepEqual(uses(`import mail from "@/lib/email";`), [
    "lib/email (whole module)",
  ]);
});

test("a dynamic import is an import", () => {
  assert.deepEqual(uses(`const { deliverEmailOnce } = await import("@/lib/email");`), [
    "lib/email (whole module)",
  ]);
});

test("the port's send is found through a variable as well as directly", () => {
  assert.deepEqual(uses(`await emailProvider().send(message, options)`), [
    "emailProvider().send",
  ]);
  assert.deepEqual(
    uses(`const provider = emailProvider();\nawait provider.send(message);`),
    ["emailProvider().send"]
  );
});

// --- and the ones that are not sends ----------------------------------------

test("asking the port anything else is not a send", () => {
  // Every webhook route calls this, and none of them sends anything.
  assert.deepEqual(uses(`emailProvider().verifyWebhook(raw, headers, stream)`), []);
  assert.deepEqual(
    uses(`const provider = emailProvider();\nprovider.verifyWebhook(raw, h, s);`),
    []
  );
});

test("a name that merely appears is not a use", () => {
  // A comment naming the function, or a test asserting on the string, must not
  // put a file on the list -- the check would then be noise nobody reads.
  assert.deepEqual(uses(`// sendTransactionalEmail is what this replaced.`), []);
  assert.deepEqual(uses(`const name = "deliverEmailOnce";`), []);
  // A different module that happens to export the same name.
  assert.deepEqual(uses(`import { deliverEmailOnce } from "@/lib/emailDrafts";`), []);
});

test("a type-only import sends nothing", () => {
  // It is erased before anything runs.
  assert.deepEqual(uses(`import type { deliverEmailOnce } from "@/lib/email";`), []);
  assert.deepEqual(uses(`export type { deliverEmailOnce } from "@/lib/email";`), []);
});

// --- the list itself ---------------------------------------------------------

test("a file that is not allowed to send is reported", () => {
  const violations = sendEntryPointViolations([
    {
      path: "lib/somethingNew.ts",
      source: `import { deliverEmailOnce } from "@/lib/email";`,
    },
    {
      path: "lib/emailSendLock.ts",
      source: `import { deliverEmailOnce } from "@/lib/email";`,
    },
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
  assert.deepEqual(
    staleAllowlistEntries(files).sort(),
    Object.keys(SEND_ALLOWLIST).sort()
  );
  assert.deepEqual(sendEntryPointViolations(files), []);
});

test("the three ways to reach the provider are the ones named", () => {
  assert.deepEqual(SEND_ENTRY_POINTS, [
    "deliverEmailOnce",
    "sendTransactionalEmail",
    "emailProvider().send",
  ]);
});

test("the scan reaches past the two directories it started with", () => {
  // The first version read `app` and `lib` for `.ts`/`.tsx` only, so a `.mjs`
  // script or a file at the repository root could send unseen.
  for (const root of ["app", "lib", "scripts"]) {
    assert.ok(SEND_SCAN.roots.includes(root), root);
  }
  for (const extension of [".ts", ".tsx", ".mjs", ".js"]) {
    assert.ok(SEND_SCAN.extensions.includes(extension), extension);
  }
  // A test is not a sender, and neither is the check.
  assert.equal(SEND_SCAN.skipFile("tests/emailThing.test.ts"), true);
  assert.equal(SEND_SCAN.skipFile("scripts/check-send-entry-points-core.mjs"), true);
  assert.equal(SEND_SCAN.skipFile("lib/email.ts"), false);
});
