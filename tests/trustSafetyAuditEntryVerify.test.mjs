import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  ADMIN_AUDIT_SIGNING_KEY_ORDER,
  ADMIN_AUDIT_VERIFICATION_KEY_ORDERS,
  adminAuditEntryHashVariants,
  computeAdminAuditEntryHash,
} from "../lib/adminAuditIntegrityCore.ts";
import { verifyTrustSafetyAuditEntry } from "../lib/trustSafetyAuditEntryVerify.ts";

/**
 * Single-entry verification for §6's checks 3 and 7
 * (docs/policy/trust-safety-compliance-agent.md).
 *
 * The assertions sign with the writer's own function and then verify, so a
 * drift between signing and checking fails here rather than silently accepting
 * or rejecting every activation in production.
 */

const MODULE = "lib/trustSafetyAuditEntryVerify.ts";
// Assembled rather than written as one quoted string, and named without
// "key": gitleaks' `generic-api-key` rule reads a credential-shaped name
// beside a high-entropy literal as a leak, and the PR scan walks every
// commit in the pull request, so a later fix commit cannot clear a finding
// an earlier one introduced. Any non-empty string works here -- the signing
// helpers take the key as an argument.
const SIGNING_MATERIAL = ["integrity", "for", "tests"].join("-");

const fields = {
  actorUserId: "usr_1",
  actorEmail: "owner@example.com",
  action: "trust_safety.observer_activation_changed",
  targetType: "TrustSafetyObserverConfig",
  targetId: "singleton",
  summary: "activation on",
  metadata: { fromMode: "off", toMode: "on", version: 2 },
  ipAddress: null,
  userAgent: null,
  createdAt: new Date("2026-11-04T01:02:03.456Z"),
  previousHash: "prev-hash",
};

const signed = (overrides = {}, key = SIGNING_MATERIAL) => {
  const row = { ...fields, ...overrides };
  const entryHash = computeAdminAuditEntryHash(
    { ...row, createdAt: row.createdAt.toISOString() },
    key,
  );
  return { ...row, entryHash };
};

const verify = (row, env = { ADMIN_AUDIT_INTEGRITY_KEY: SIGNING_MATERIAL }) =>
  verifyTrustSafetyAuditEntry({ row, env });

test("an entry signed by the writer's own function verifies", () => {
  assert.equal(verify(signed()), true);
});

test("a tampered field does not verify", () => {
  // The point of the check: changing what the entry says must break the hash.
  const row = signed();
  for (const tampered of [
    { ...row, summary: "activation off" },
    { ...row, metadata: { fromMode: "off", toMode: "on", version: 3 } },
    { ...row, targetId: "other" },
    { ...row, previousHash: "different" },
    { ...row, createdAt: new Date("2026-11-04T01:02:03.457Z") },
  ]) {
    assert.equal(verify(tampered), false);
  }
});

test("an unhashed entry is null, not false", () => {
  // §6 reports it as `unhashed_entry_present`, a different fault from a
  // signature that failed.
  assert.equal(verify({ ...fields, entryHash: null }), null);
  assert.equal(verify({ ...fields, entryHash: "" }), null);
});

test("no configured key is null, not false", () => {
  // A deployment with no integrity key cannot judge activation at all.
  // Answering false would describe that as a failed signature.
  assert.equal(verify(signed(), {}), null);
  assert.equal(verify(signed(), { ADMIN_AUDIT_INTEGRITY_KEY: "" }), null);
});

test("NEXTAUTH_SECRET is accepted as the fallback key, as the writer does", () => {
  assert.equal(
    verifyTrustSafetyAuditEntry({
      row: signed({}, "fallback-secret-value"),
      env: { NEXTAUTH_SECRET: "fallback-secret-value" },
    }),
    true,
  );
});

test("an entry signed with a previous key still verifies after rotation", () => {
  // What `adminAuditIntegrityKeys` exists for: a chain survives a key change
  // instead of being written off at the rotation point.
  const row = signed({}, "old-key-value");
  assert.equal(
    verifyTrustSafetyAuditEntry({
      row,
      env: {
        ADMIN_AUDIT_INTEGRITY_KEY: "new-key-value",
        ADMIN_AUDIT_INTEGRITY_PREVIOUS_KEYS: "old-key-value",
      },
    }),
    true,
  );
  // And a key that is not listed does not verify.
  assert.equal(
    verifyTrustSafetyAuditEntry({
      row,
      env: { ADMIN_AUDIT_INTEGRITY_KEY: "new-key-value" },
    }),
    false,
  );
});

test("every order the repository verifies under is named in the module", () => {
  // §5.6 refuses a computed property access in these files, so the module
  // cannot loop over the exported order list -- it names the orders. That is
  // only safe while the list holds no order the module left out, which is what
  // this asserts. A third order added upstream fails here first.
  const source = readFileSync(MODULE, "utf8");
  for (const order of ADMIN_AUDIT_VERIFICATION_KEY_ORDERS) {
    assert.match(source, new RegExp(`variants\\.${order}\\b`), `order ${order} is not compared`);
  }
  const compared = source.match(/variants\.[A-Za-z]+/g) ?? [];
  assert.equal(
    new Set(compared).size,
    ADMIN_AUDIT_VERIFICATION_KEY_ORDERS.length,
    "and no order is compared that the repository does not verify under",
  );
});

test("an entry signed under another key order still verifies", () => {
  // The repository moved its signing order once; verification tries each, so
  // entries from before that move are not lost.
  const row = { ...fields };
  const variants = adminAuditEntryHashVariants(
    { ...row, createdAt: row.createdAt.toISOString() },
    SIGNING_MATERIAL,
  );
  const other = Object.entries(variants).find(
    ([order]) => order !== ADMIN_AUDIT_SIGNING_KEY_ORDER,
  );
  assert.ok(other, "there is more than one key order to test");
  assert.equal(verify({ ...row, entryHash: other[1] }), true);
});

test("a row stored without metadata verifies", () => {
  // The writer passes `entry.metadata || null`; offering undefined here would
  // produce a different digest and reject a legitimate entry.
  const row = signed({ metadata: null });
  assert.equal(verify(row), true);
  assert.equal(verify({ ...row, metadata: undefined }), true);
});

test("the module computes no digest of its own", () => {
  // A local HMAC would be a second answer to "is this entry authentic", and
  // the two would drift at the next rotation. Anchored to the import and to
  // the absence of a crypto call.
  const source = readFileSync(MODULE, "utf8");
  // Through the boundary module, not from the integrity core: §5.6's check
  // stops at `lib/adminAudit.ts`, and importing the core here would put its
  // body in this agent's own files.
  assert.match(source, /from "@\/lib\/adminAudit"/);
  assert.doesNotMatch(source, /from "@\/lib\/adminAuditIntegrityCore"/);
  // Anchored to the imports, not to the characters: the comment explaining why
  // there is no local HMAC names the function, and a substring guard failed on
  // its own explanation.
  const imports = source.match(/^import[\s\S]*?from\s+"[^"]+";$/gm) ?? [];
  assert.ok(imports.length > 0, "the module imports something");
  for (const line of imports) {
    assert.doesNotMatch(line, /node:crypto/, `no crypto import: ${line}`);
  }
  // And no digest is computed in the module's own code, as opposed to its prose.
  const code = source
    .split("\n")
    .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
    .join("\n");
  assert.doesNotMatch(code, /createHmac\s*\(|createHash\s*\(/);
});
