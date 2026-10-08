import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { amuxV4AnalysisQueueReadEnabled } from "../lib/amux/ideaAnalysisQueueCore.ts";
import { amuxV4AnalysisResultReadEnabled } from "../lib/amux/ideaAnalysisResultReadCore.ts";
import { amuxV4ContentRetentionEnabled } from "../lib/amux/ideaContentRetentionCore.ts";
import { frontierCatalogReadPermitted, frontierCatalogWritePermitted } from
  "../lib/amux/ideaFrontierCatalogWriteCore.ts";
import { initialPlanReadbackPermitted, initialPlanWritePermitted } from
  "../lib/amux/ideaInitialSourcePlanCore.ts";
import { amuxV4LiveAnalysisCliEnabled } from "../lib/amux/ideaLocalIsolatedCliRunner.mjs";
import { amuxV4ResolutionPreviewEnabled } from "../lib/amux/ideaResolutionChoiceCore.ts";
import { sourceScopePreviewPermitted } from "../lib/amux/ideaSourceScopePreviewCore.ts";
import { ideaSubmissionReadBackPermitted, ideaSubmissionWritePermitted } from
  "../lib/amux/ideaSubmissionCore.ts";
import { amuxV4UnitWriteEnabled } from "../lib/amux/ideaUnitDecisionStore.ts";
import { transferConfirmReadPermitted, transferConfirmWritePermitted } from
  "../lib/amux/ideaTransferConfirmationCore.ts";
import { transferPreviewReadPermitted, transferPreviewWritePermitted } from
  "../lib/amux/ideaTransferPreviewInputCore.ts";
import { amuxV4PortfolioWriteEnabled } from "../lib/amux/portfolioAssessmentService.ts";
import { amuxV4TaskCatalogWriteEnabled } from "../lib/amux/v4TaskCostCatalogApprovalService.ts";

test("v4 code activation keeps every exposed stage closed without its environment switch", () => {
  const gates = [
    ideaSubmissionWritePermitted, ideaSubmissionReadBackPermitted,
    initialPlanWritePermitted, initialPlanReadbackPermitted,
    sourceScopePreviewPermitted,
    frontierCatalogWritePermitted, frontierCatalogReadPermitted,
    transferPreviewWritePermitted, transferPreviewReadPermitted,
    transferConfirmWritePermitted, transferConfirmReadPermitted,
    amuxV4ResolutionPreviewEnabled, amuxV4UnitWriteEnabled,
    amuxV4PortfolioWriteEnabled, amuxV4TaskCatalogWriteEnabled,
  ];
  for (const gate of gates) {
    assert.equal(gate(undefined), false, `${gate.name}: missing switch`);
    assert.equal(gate("disabled"), false, `${gate.name}: disabled switch`);
    assert.equal(gate("enabled"), true, `${gate.name}: explicit switch`);
  }
  assert.equal(amuxV4ContentRetentionEnabled("enabled"), false);
  assert.equal(amuxV4LiveAnalysisCliEnabled("enabled"), false);
  assert.equal(amuxV4AnalysisQueueReadEnabled("enabled"), false);
  assert.equal(amuxV4AnalysisResultReadEnabled("enabled"), false);
  const claimRoute = readFileSync(new URL(
    "../app/api/internal/amux/v4/analysis-claim/route.ts", import.meta.url), "utf8");
  const resultRoute = readFileSync(new URL(
    "../app/api/internal/amux/v4/analysis-result/route.ts", import.meta.url), "utf8");
  const budgetService = readFileSync(new URL(
    "../lib/amux/ideaAnalysisBudgetReservationService.ts", import.meta.url), "utf8");
  const retentionHoldRoute = readFileSync(new URL(
    "../app/api/admin/amux/ideas/retention-holds/route.ts", import.meta.url), "utf8");
  assert.match(claimRoute, /const CLAIM_CODE_LATCH = false;/);
  assert.match(resultRoute, /const RESULT_CODE_LATCH = false;/);
  assert.match(budgetService, /AMUX_V4_ANALYSIS_BUDGET_RESERVE_CODE_LATCH = false;/);
  assert.match(retentionHoldRoute, /const WRITE_CODE_LATCH = false;/);
});

test("unit no-commit recovery has a separate default-off switch", () => {
  const source = readFileSync(new URL(
    "../app/api/admin/amux/ideas/unit-decisions/no-commit/route.ts",
    import.meta.url), "utf8");
  assert.match(source, /UNIT_RECOVERY_WRITE_ENV = "TOMVERSE_AMUX_V4_UNIT_RECOVERY_WRITE"/);
  assert.match(source, /!AMUX_V4_UNIT_WRITE_CODE_ENABLED \|\|\s*process\.env\[UNIT_RECOVERY_WRITE_ENV\] !== "enabled"/);
});
