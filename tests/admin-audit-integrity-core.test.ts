import assert from "node:assert/strict";
import test from "node:test";
import { computeAdminAuditEntryHash } from "../lib/adminAuditIntegrityCore.ts";

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
