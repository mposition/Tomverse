import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { amuxV4AnalysisQueueReadEnabled } from "../lib/amux/ideaAnalysisQueueCore.ts";
import { amuxV4AnalysisResultReadEnabled } from "../lib/amux/ideaAnalysisResultReadCore.ts";
import { AMUX_V4_ANALYSIS_BUDGET_RESERVE_CODE_LATCH } from
  "../lib/amux/ideaAnalysisBudgetReservationService.ts";
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
    amuxV4ContentRetentionEnabled, amuxV4LiveAnalysisCliEnabled,
    amuxV4AnalysisQueueReadEnabled, amuxV4AnalysisResultReadEnabled,
  ];
  for (const gate of gates) {
    assert.equal(gate(undefined), false, `${gate.name}: missing switch`);
    assert.equal(gate("disabled"), false, `${gate.name}: disabled switch`);
    assert.equal(gate("enabled"), true, `${gate.name}: explicit switch`);
  }
  assert.equal(AMUX_V4_ANALYSIS_BUDGET_RESERVE_CODE_LATCH, true);
  const claimRoute = readFileSync(new URL(
    "../app/api/internal/amux/v4/analysis-claim/route.ts", import.meta.url), "utf8");
  const resultRoute = readFileSync(new URL(
    "../app/api/internal/amux/v4/analysis-result/route.ts", import.meta.url), "utf8");
  const budgetService = readFileSync(new URL(
    "../lib/amux/ideaAnalysisBudgetReservationService.ts", import.meta.url), "utf8");
  const retentionHoldRoute = readFileSync(new URL(
    "../app/api/admin/amux/ideas/retention-holds/route.ts", import.meta.url), "utf8");
  const budgetRoute = readFileSync(new URL(
    "../app/api/admin/amux/ideas/analysis-reservations/route.ts", import.meta.url), "utf8");
  assert.match(claimRoute, /const CLAIM_CODE_LATCH = true;/);
  assert.match(resultRoute, /const RESULT_CODE_LATCH = true;/);
  assert.match(budgetService, /AMUX_V4_ANALYSIS_BUDGET_RESERVE_CODE_LATCH = true;/);
  assert.match(budgetRoute, /!AMUX_V4_ANALYSIS_BUDGET_RESERVE_CODE_LATCH \|\|\s*process\.env\[WRITE_ENV\] !== "enabled"/);
  assert.match(retentionHoldRoute, /const WRITE_CODE_LATCH = true;/);
  assert.match(retentionHoldRoute, /process\.env\[READ_ENV\] !== "enabled" \|\|\s*process\.env\[WRITE_ENV\] !== "enabled"/);
  for (const source of [claimRoute, resultRoute, retentionHoldRoute]) {
    assert.match(source, /process\.env\[[A-Z_]+ENV\] !== "enabled"/);
  }
});

test("unit no-commit recovery has a separate default-off switch", () => {
  const source = readFileSync(new URL(
    "../app/api/admin/amux/ideas/unit-decisions/no-commit/route.ts",
    import.meta.url), "utf8");
  assert.match(source, /UNIT_RECOVERY_WRITE_ENV = "TOMVERSE_AMUX_V4_UNIT_RECOVERY_WRITE"/);
  assert.match(source, /!AMUX_V4_UNIT_WRITE_CODE_ENABLED \|\|\s*process\.env\[UNIT_RECOVERY_WRITE_ENV\] !== "enabled"/);
});

test("v29 opens only four v22 code latches, not publication or outcome writes", () => {
  const sources = [
    ["../lib/amux/v22AutoPromotionCore.ts", "AMUX_V22_AUTO_PROMOTION_CODE_LATCH", true],
    ["../lib/amux/v22WorkerClaimCore.ts", "AMUX_V22_WORKER_CLAIM_CODE_LATCH", true],
    ["../lib/amux/v22TaskExecutionCore.ts", "AMUX_V22_TASK_EXECUTION_CODE_LATCH", true],
    ["../lib/amux/v22TaskExecutionCore.ts", "AMUX_V22_ENGINEERING_PUBLICATION_CODE_LATCH", false],
    ["../lib/amux/v22OutcomeObservationCore.ts", "AMUX_V22_OUTCOME_WRITE_CODE_LATCH", false],
    ["../lib/amux/v22OneShotSidecar.mjs", "AMUX_V22_SIDECAR_CODE_LATCH", true],
  ];
  for (const [path, name, enabled] of sources) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    assert.match(source, new RegExp(`export const ${name} = ${enabled};`), name);
  }
});
