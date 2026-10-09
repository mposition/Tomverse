// A system audit entry read as evidence (S2d2 round-2 review).
//
// The dispatch of an autonomous post compares the admission it is about to go
// out under with the one the autonomous insert recorded. The round-2 review
// rejected comparing values alone: a row with the right numbers but no hash,
// another actor, or no place in the chain would have passed. These are the
// refusals that close that, against rows hashed with the real function.

import assert from "node:assert/strict";
import test from "node:test";

import {
  MARKETING_POST_AUDIT_TARGET_TYPE,
  verifyMarketingSystemAuditEvidence,
} from "@/lib/marketingAuditEvidence";

import {
  auditEvidenceReads,
  hashedSystemAuditRow,
  configureTestAuditIntegrityKey,
  type StoredAuditRow,
} from "./support/hashedAuditEntry";

configureTestAuditIntegrityKey();

const ACTION = "marketing_post.autonomous_scheduled";
const POST_ID = "post-1";

const requirement = {
  action: ACTION,
  systemActor: "marketing-guard" as const,
  targetType: MARKETING_POST_AUDIT_TARGET_TYPE,
  targetId: POST_ID,
};

const row = (overrides: Partial<StoredAuditRow> = {}, systemActor = "marketing-guard") =>
  hashedSystemAuditRow(
    {
      action: ACTION,
      systemActor,
      targetType: MARKETING_POST_AUDIT_TARGET_TYPE,
      targetId: POST_ID,
      metadata: { admissionCodeDigest: "d", configGeneration: 3, deploymentId: "x" },
    },
    overrides,
  );

const reader = (
  entry: StoredAuditRow | null,
  options?: Parameters<typeof auditEvidenceReads>[1],
) => {
  const reads = auditEvidenceReads(entry, options);
  return {
    adminAuditLog: { findFirst: async (args: never) => reads(args) ?? null },
  } as never;
};

test("a hashed, linked system row by the named actor is evidence, and its metadata comes back", async () => {
  const entry = row();
  const verdict = await verifyMarketingSystemAuditEvidence(reader(entry), requirement);
  assert.equal(verdict.ok, true);
  if (verdict.ok) {
    assert.equal(verdict.auditLogId, entry.id);
    assert.equal((verdict.metadata as { configGeneration: number }).configGeneration, 3);
  }
});

test("each way a row can carry the right values and still not be evidence is refused", async () => {
  const cases: Array<[string, StoredAuditRow | null, Parameters<typeof auditEvidenceReads>[1], string]> = [
    ["no row", null, undefined, "entry_missing"],
    ["unhashed", { ...row(), entryHash: null }, undefined, "entry_unhashed"],
    ["edited after hashing", { ...row(), summary: "changed" }, undefined, "entry_hash_mismatch"],
    ["another system actor", row({}, "marketing-publisher"), undefined, "actor_mismatch"],
    ["a human row", row({ actorUserId: "user-1" }), undefined, "actor_not_system"],
    ["another target type", row({ targetType: "MarketingChannel" }), undefined, "target_mismatch"],
    ["not linked to the row before", row(), { before: "some-other-hash" }, "entry_not_linked"],
    ["not linked to the row after", row(), { after: { previousHash: "x" } }, "entry_not_linked"],
  ];
  for (const [label, entry, options, problem] of cases) {
    const verdict = await verifyMarketingSystemAuditEvidence(reader(entry, options), requirement);
    assert.deepEqual(verdict, { ok: false, problem }, label);
  }
});
