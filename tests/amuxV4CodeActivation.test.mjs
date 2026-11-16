import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { amuxV4ContentRetentionEnabled } from "../lib/amux/ideaContentRetentionCore.ts";
import { amuxV4LiveAnalysisCliEnabled } from "../lib/amux/ideaLocalIsolatedCliRunner.mjs";

test("v4 code activation keeps every exposed stage closed without its environment switch", () => {
  const gates = [
    amuxV4ContentRetentionEnabled, amuxV4LiveAnalysisCliEnabled,
  ];
  for (const gate of gates) {
    assert.equal(gate(undefined), false, `${gate.name}: missing switch`);
    assert.equal(gate("disabled"), false, `${gate.name}: disabled switch`);
    assert.equal(gate("enabled"), true, `${gate.name}: explicit switch`);
  }
  const claimRoute = readFileSync(new URL(
    "../app/api/internal/amux/v4/analysis-claim/route.ts", import.meta.url), "utf8");
  const budgetService = readFileSync(new URL(
    "../lib/amux/ideaAnalysisBudgetReservationService.ts", import.meta.url), "utf8");
  const budgetRoute = readFileSync(new URL(
    "../app/api/admin/amux/ideas/analysis-reservations/route.ts", import.meta.url), "utf8");
  assert.doesNotMatch(claimRoute, /CODE_LATCH/);
  assert.doesNotMatch(budgetService, /BUDGET_RESERVE_CODE_LATCH/);
  assert.match(budgetRoute, /process\.env\[WRITE_ENV\] !== "enabled"/);
  assert.doesNotMatch(budgetRoute, /BUDGET_RESERVE_CODE_LATCH|BUDGET_READ/);
  assert.match(claimRoute, /process\.env\[[A-Z_]+ENV\] !== "enabled"/);
});

test("v4 live CLI retains its v13 child and tunnel limits", () => {
  const source = readFileSync(new URL(
    "../lib/amux/ideaLocalIsolatedCliRunner.mjs", import.meta.url), "utf8");
  const runOnce = source.slice(source.indexOf("async function runIsolatedCliOnce("),
    source.indexOf("export async function runAmuxV4IsolatedSyntheticCliS0("));
  assert.ok(runOnce.startsWith("async function runIsolatedCliOnce("));
  assert.match(runOnce, /createAmuxV4EgressProxy\(selection\.egressHosts/);
  assert.match(runOnce, /await awaitAmuxV4BoundedChild\(child,\s*AMUX_V4_CLI_HARD_DEADLINE_MS\)/);
  assert.doesNotMatch(runOnce, /createAmuxV19EgressProxy|awaitAmuxV19StoppableChild/);
});

test("v29 opens four v22 code latches and v49 adds publication, not outcome writes", () => {
  const sources = [
    ["../lib/amux/v22AutoPromotionCore.ts", "AMUX_V22_AUTO_PROMOTION_CODE_LATCH", true],
    ["../lib/amux/v22WorkerClaimCore.ts", "AMUX_V22_WORKER_CLAIM_CODE_LATCH", true],
    ["../lib/amux/v22TaskExecutionCore.ts", "AMUX_V22_TASK_EXECUTION_CODE_LATCH", true],
    ["../lib/amux/v22TaskExecutionCore.ts", "AMUX_V22_ENGINEERING_PUBLICATION_CODE_LATCH", true],
    ["../lib/amux/v22OutcomeObservationCore.ts", "AMUX_V22_OUTCOME_WRITE_CODE_LATCH", false],
    ["../lib/amux/v22OneShotSidecar.mjs", "AMUX_V22_SIDECAR_CODE_LATCH", true],
  ];
  for (const [path, name, enabled] of sources) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    assert.match(source, new RegExp(`export const ${name} = ${enabled};`), name);
  }
});
