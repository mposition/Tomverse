import assert from "node:assert/strict";
import test from "node:test";
import {
  ADMIN_AUDIT_KEY_ORDERS,
  ADMIN_AUDIT_SIGNING_KEY_ORDER,
  ADMIN_AUDIT_VERIFICATION_KEY_ORDERS,
  adminAuditEntryHashVariants,
  computeAdminAuditEntryHash,
} from "../lib/adminAuditIntegrityCore.ts";

const input = {
  previousHash: null,
  actorUserId: "admin-1",
  actorEmail: "admin@example.test",
  action: "user.security.suspend",
  targetType: "User",
  targetId: "user-1",
  summary: "Suspended a user account.",
  metadata: { reason: "security incident", nested: { b: 2, a: 1 } },
  ipAddress: "127.0.0.1",
  userAgent: "test",
  createdAt: "2026-07-18T00:00:00.000Z",
};

test("admin audit HMAC is stable and detects content or linkage changes", () => {
  const secret = "admin-audit-integrity-test-secret-32-chars";
  const hash = computeAdminAuditEntryHash(input, secret);
  assert.equal(
    hash,
    computeAdminAuditEntryHash(
      { ...input, metadata: { nested: { a: 1, b: 2 }, reason: "security incident" } },
      secret
    )
  );
  assert.notEqual(hash, computeAdminAuditEntryHash({ ...input, summary: "Changed" }, secret));
  assert.notEqual(hash, computeAdminAuditEntryHash({ ...input, previousHash: "other" }, secret));
});

const SECRET = "admin-audit-integrity-test-secret-32-chars";

test("signing orders keys by code point, not by the runtime's collation", () => {
  // The pair is the whole point: `localeCompare` and code point disagree about
  // it, so a row carrying both keys hashes differently on a runtime whose ICU
  // data differs -- with nothing about the row having changed.
  assert.notEqual(
    "creditUsd".localeCompare("creditsPurchased") < 0,
    "creditUsd" < "creditsPurchased"
  );

  const row = { ...input, metadata: { creditUsd: 12, creditsPurchased: 3 } };
  const variants = adminAuditEntryHashVariants(row, SECRET);
  assert.notEqual(variants.locale, variants.codepoint);
  assert.equal(
    computeAdminAuditEntryHash(row, SECRET),
    variants.codepoint,
    "signing must depend on the bytes alone"
  );
});

test("the two key orders agree on a row with no divergent pair", () => {
  // Why the migration is not a wholesale re-signing: for every object whose
  // keys do not straddle a collation difference the orders produce one digest
  // under two names, so almost no existing row is affected either way.
  const variants = adminAuditEntryHashVariants(input, SECRET);
  assert.equal(variants.locale, variants.codepoint);
});

test("verification tries the signing order first and every order eventually", () => {
  // The verifier depends on both halves. Signing order first, or an entry
  // written today would be reported as a legacy-order row; every order
  // present, or entries signed before 2026-08-27 stop verifying -- which is
  // the wholesale loss this migration exists to avoid.
  assert.equal(ADMIN_AUDIT_VERIFICATION_KEY_ORDERS[0], ADMIN_AUDIT_SIGNING_KEY_ORDER);
  assert.deepEqual(
    [...ADMIN_AUDIT_VERIFICATION_KEY_ORDERS].sort(),
    Object.keys(ADMIN_AUDIT_KEY_ORDERS).sort()
  );
  assert.equal(
    new Set(ADMIN_AUDIT_VERIFICATION_KEY_ORDERS).size,
    ADMIN_AUDIT_VERIFICATION_KEY_ORDERS.length,
    "an order listed twice would double every failing row's work for nothing"
  );
});
