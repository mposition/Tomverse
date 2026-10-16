import assert from "node:assert/strict";
import test from "node:test";

import {
  AMUX_V19_TRACKED_CHECKOUT_AUDIT_SUMMARY,
  AMUX_V19_TRACKED_CHECKOUT_AUDIT_ACTOR,
  AMUX_V19_TRACKED_CHECKOUT_RECORDED_ACTION,
  AMUX_V19_TRACKED_CHECKOUT_RECORDED_SCOPE,
  AMUX_V19_TRACKED_CHECKOUT_RECORDED_TARGET,
  amuxTrackedCheckoutEvidenceAuditMetadata,
  inspectAmuxTrackedCheckoutEvidence,
} from "../lib/amux/ideaTrackedCheckoutEvidenceCore.ts";
import {
  auditRowActorKind,
  systemAuditActionAllowed,
} from "../lib/adminAuditSystemActors.ts";

const valid = () => ({
  ideaId: "idea-1",
  referenceOrdinal: 0,
  pinnedCommitSha: "a".repeat(40),
  excludedCount: 6,
  excludedPathDigest: "b".repeat(64),
  excludedPathDigestKeyId: "amux-v19-checkout-digest-v1",
  excludedReasons: {
    secret_path: 1,
    secret_content: 2,
    non_regular: 1,
    unscannable_content: 2,
  },
});

test("tracked checkout evidence accepts only content-free aggregate proof", () => {
  const inspected = inspectAmuxTrackedCheckoutEvidence(valid());
  assert.ok(inspected);
  assert.deepEqual(inspected, {
    ideaId: "idea-1",
    referenceOrdinal: 0,
    pinnedCommitSha: "a".repeat(40),
    excludedCount: 6,
    excludedPathDigest: "b".repeat(64),
    excludedPathDigestKeyId: "amux-v19-checkout-digest-v1",
    excludedSecretPathCount: 1,
    excludedSecretContentCount: 2,
    excludedNonRegularCount: 1,
    excludedUnscannableCount: 2,
  });
  const metadata = amuxTrackedCheckoutEvidenceAuditMetadata("evidence-1", inspected);
  assert.deepEqual(Object.keys(metadata).sort(), [
    "evidenceId", "excludedCount", "excludedNonRegularCount",
    "excludedPathDigest", "excludedPathDigestKeyId",
    "excludedSecretContentCount", "excludedSecretPathCount",
    "excludedUnscannableCount", "ideaId", "pinnedCommitSha",
    "policyVersion", "referenceOrdinal",
  ].sort());
  assert.equal(JSON.stringify(metadata).includes(".env"), false);
  assert.equal(AMUX_V19_TRACKED_CHECKOUT_AUDIT_SUMMARY,
    "Recorded one content-free AMUX v19 pinned checkout evidence.");
  assert.equal(systemAuditActionAllowed(AMUX_V19_TRACKED_CHECKOUT_AUDIT_ACTOR,
    AMUX_V19_TRACKED_CHECKOUT_RECORDED_ACTION,
    AMUX_V19_TRACKED_CHECKOUT_RECORDED_TARGET), true);
  assert.equal(auditRowActorKind({
    action: AMUX_V19_TRACKED_CHECKOUT_RECORDED_ACTION,
    targetType: AMUX_V19_TRACKED_CHECKOUT_RECORDED_TARGET,
    actorUserId: null,
    actorEmail: null,
    ipAddress: null,
    userAgent: null,
    metadata: { systemActor: AMUX_V19_TRACKED_CHECKOUT_AUDIT_ACTOR,
      actorScope: AMUX_V19_TRACKED_CHECKOUT_RECORDED_SCOPE },
  }), "system");
});

test("tracked checkout evidence rejects malformed SHA, digest, key and count totals", () => {
  for (const candidate of [
    { ...valid(), pinnedCommitSha: "A".repeat(40) },
    { ...valid(), pinnedCommitSha: "a".repeat(39) },
    { ...valid(), referenceOrdinal: -1 },
    { ...valid(), excludedPathDigest: "b".repeat(63) },
    { ...valid(), excludedPathDigestKeyId: "path key" },
    { ...valid(), excludedCount: 5 },
    { ...valid(), excludedReasons: { ...valid().excludedReasons, secret_path: -1 } },
  ]) {
    assert.equal(inspectAmuxTrackedCheckoutEvidence(candidate), null);
  }
});
