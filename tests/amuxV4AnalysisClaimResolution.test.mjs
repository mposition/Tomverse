import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { amuxIdeaAnalysisClaimReadbackDigest } from
  "../lib/amux/ideaAnalysisClaimResolutionCore.ts";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("claim read-back digest is deterministic and binds the result receipt", () => {
  const snapshot = { holdId: "hold-1", previewId: "preview-1", ideaId: "idea-1",
    chunkIndex: 0, leaseGeneration: 1, reservedMicroUsd: "10560000",
    holdStatus: "outcome_unknown", claimRequestId: "claim-1",
    payloadDigest: "a".repeat(64), resultRequestId: "result-1",
    resultDigest: "b".repeat(64) };
  const digest = amuxIdeaAnalysisClaimReadbackDigest(snapshot);
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(amuxIdeaAnalysisClaimReadbackDigest({ ...snapshot }), digest);
  assert.notEqual(amuxIdeaAnalysisClaimReadbackDigest({ ...snapshot,
    resultDigest: "c".repeat(64) }), digest);
});

test("owner resolution stays dark, exact, Agent-only, and distinct from cancellation", async () => {
  const [route, service, panel, migration, cancellation] = await Promise.all([
    read("app/api/admin/amux/ideas/analysis-claim-resolution/route.ts"),
    read("lib/amux/ideaAnalysisClaimResolutionService.ts"),
    read("components/admin/AmuxAnalysisClaimResolutionPanel.tsx"),
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
  assert.doesNotMatch(service, /CreditAccount|CreditLot|ChatCost|Conversation/);
  assert.match(panel, /AdminApiFailureNotice/);
  assert.match(panel, /resolutionRequestId/);
  assert.match(panel, /resolutionRequestId: pendingRequestId/);
  assert.match(panel, /state !== "resolution_found"/);
  assert.match(migration, /owner_released_unstarted/);
  assert.match(migration, /"dispatchedAt" IS NOT NULL/);
  assert.match(migration, /"settledMicroUsd" = 0/);
  assert.match(cancellation, /hold\.status !== "reserved"/);
  assert.doesNotMatch(cancellation, /owner_released_unstarted/);
});
