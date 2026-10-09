import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { amuxIdeaAnalysisClaimReadbackDigest } from
  "../lib/amux/ideaAnalysisClaimResolutionCore.ts";
import { isAmuxClaimResolutionWriteOutcomeUnknown } from
  "../lib/amux/ideaAnalysisClaimResolutionUiCore.ts";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("claim read-back digest is deterministic and binds the result receipt", () => {
  const snapshot = { holdId: "hold-1", previewId: "preview-1", ideaId: "idea-1",
    chunkIndex: 0, leaseGeneration: 1, reservedMicroUsd: "10560000",
    holdStatus: "outcome_unknown", claimRequestId: "claim-1",
    ideaState: "analyzing", ideaCancelledAt: null,
    payloadDigest: "a".repeat(64), resultRequestId: "result-1",
    resultDigest: "b".repeat(64), resultOutcome: "verified_success",
    resultEffectiveOutcome: "outcome_unknown",
    resultFailureReason: "usage_unverified", zeroReleaseEligible: false };
  const digest = amuxIdeaAnalysisClaimReadbackDigest(snapshot);
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(amuxIdeaAnalysisClaimReadbackDigest({ ...snapshot }), digest);
  assert.notEqual(amuxIdeaAnalysisClaimReadbackDigest({ ...snapshot,
    resultDigest: "c".repeat(64) }), digest);
  assert.notEqual(amuxIdeaAnalysisClaimReadbackDigest({ ...snapshot,
    resultFailureReason: null }), digest);
  assert.notEqual(amuxIdeaAnalysisClaimReadbackDigest({ ...snapshot,
    ideaState: "cancelled", ideaCancelledAt: "2026-10-08T00:00:00.000Z" }), digest);
  assert.notEqual(amuxIdeaAnalysisClaimReadbackDigest({ ...snapshot,
    zeroReleaseEligible: true }), digest);
});

test("only the deterministic integrity 503 skips read-only recovery", () => {
  assert.equal(isAmuxClaimResolutionWriteOutcomeUnknown(503,
    { error: "outcome_unknown" }), true);
  assert.equal(isAmuxClaimResolutionWriteOutcomeUnknown(503,
    { error: "integrity_unavailable" }), false);
  assert.equal(isAmuxClaimResolutionWriteOutcomeUnknown(500,
    { error: "outcome_unknown" }), true);
  assert.equal(isAmuxClaimResolutionWriteOutcomeUnknown(502,
    "gateway HTML"), true);
  assert.equal(isAmuxClaimResolutionWriteOutcomeUnknown(503, null), true);
  assert.equal(isAmuxClaimResolutionWriteOutcomeUnknown(409,
    { error: "conflict" }), false);
});

test("owner resolution stays dark, exact, Agent-only, and distinct from cancellation", async () => {
  const [route, service, panel, budgetPanel, migration, cancellation] = await Promise.all([
    read("app/api/admin/amux/ideas/analysis-claim-resolution/route.ts"),
    read("lib/amux/ideaAnalysisClaimResolutionService.ts"),
    read("components/admin/AmuxAnalysisClaimResolutionPanel.tsx"),
    read("components/admin/AmuxAnalysisBudgetPanel.tsx"),
    read("prisma/migrations/20261008130000_amux_v4_claim_owner_resolution/migration.sql"),
    read("lib/amux/ideaAnalysisBudgetCancellationService.ts"),
  ]);
  assert.match(route, /TOMVERSE_AMUX_V4_ANALYSIS_CLAIM_RESOLUTION_READ/);
  assert.match(route, /TOMVERSE_AMUX_V4_ANALYSIS_CLAIM_RESOLUTION_WRITE/);
  assert.match(route, /process\.env\[READ_ENV\] !== "enabled"/);
  assert.match(route, /process\.env\[WRITE_ENV\] !== "enabled"/);
  assert.match(route, /ADMIN_REAUTHENTICATION_REQUIRED/);
  assert.match(service, /getAdminRole\(session\) !== "owner"/);
  assert.match(service, /takeAuditChainLock\(tx\)/);
  assert.match(service, /writeAdminAuditLog/);
  assert.match(service, /userCreditLedgerTouched: false/);
  assert.match(service, /!snapshot\.zeroReleaseEligible/);
  assert.doesNotMatch(service, /CreditAccount|CreditLot|ChatCost|Conversation/);
  assert.match(panel, /AdminApiFailureNotice/);
  assert.match(panel, /resolutionRequestId/);
  assert.match(panel, /resolutionRequestId: pendingRequestId/);
  assert.match(panel, /state !== "resolution_found"/);
  assert.match(panel, /isAmuxClaimResolutionWriteOutcomeUnknown/);
  assert.match(panel, /disabled=\{!readback\.zeroReleaseEligible\}/);
  assert.match(budgetPanel, /holdStatus === "owner_released_unstarted"/);
  assert.match(budgetPanel, /holdStatus === "owner_consumed"/);
  assert.match(budgetPanel, /holdStatus === "reserved"/);
  assert.match(budgetPanel, /holdStatus === "in_flight"/);
  assert.match(budgetPanel, /holdStatus === "outcome_unknown"/);
  assert.match(budgetPanel, /\["succeeded", "failed"\]\.includes\(holdStatus\)/);
  assert.match(budgetPanel, /holdStatus === "released"/);
  assert.match(budgetPanel, /holdStatus === "expired"/);
  assert.match(budgetPanel, /!knownHoldStatus/);
  assert.match(budgetPanel, /onResolved=/);
  assert.match(budgetPanel, /loadHold\(\)\.catch/);
  assert.match(migration, /owner_released_unstarted/);
  assert.match(migration, /"dispatchedAt" IS NOT NULL/);
  assert.match(migration, /"settledMicroUsd" = 0/);
  assert.match(cancellation, /hold\.status !== "reserved"/);
  assert.doesNotMatch(cancellation, /owner_released_unstarted/);
});
