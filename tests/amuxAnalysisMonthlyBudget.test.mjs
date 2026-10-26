import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { analysisBudgetUsdToMicroUsd, analysisBudgetMicroUsdToUsd,
  readPendingAnalysisBudgetSetting, analysisBudgetSavedMatches,
  readAnalysisBudgetSnapshotReply, AMUX_ANALYSIS_BUDGET_READ_ENV,
  AMUX_ANALYSIS_BUDGET_WRITE_ENV } from "../lib/amux/ideaAnalysisBudgetSettingCore.ts";

test("currency conversion is exact, with no exponent, rounding, sign or whitespace coercion", () => {
  for (const [input, expected] of [["1000", "1000000000"], ["0.01", "10000"],
    ["50.50", "50500000"], ["9223372036854.77", "9223372036854770000"]]) {
    assert.equal(analysisBudgetUsdToMicroUsd(input), expected);
  }
  for (const value of [null, 1000, "0", "0.00", "-1", "+1", "1e3", "Infinity",
    "NaN", " 1000", "1000 ", "01", ".50", "1.001", "1.", "9223372036854.78"])
    assert.equal(analysisBudgetUsdToMicroUsd(value), null);
  assert.equal(analysisBudgetMicroUsdToUsd("1000000000"), "1000.00");
  assert.equal(analysisBudgetMicroUsdToUsd("42240001"), "42.240001");
});

const pending = { id: "34340477-7664-42f4-b3fe-845d10365051", expectedPreviousVersion: 0, monthlyUsd: "1000" };
const saved = { state: "saved", id: pending.id, version: 1, limitMicroUsd: "1000000000", auditId: "synthetic-audit" };
test("lost-write recovery binds the exact ID, version, amount and canonical audit", () => {
  assert.deepEqual(readPendingAnalysisBudgetSetting(pending), pending);
  assert.equal(readPendingAnalysisBudgetSetting({ ...pending, unexpected: true }), null);
  assert.equal(analysisBudgetSavedMatches(saved, pending), true);
  for (const change of [{ id: "another" }, { version: 2 }, { limitMicroUsd: "50000000" },
    { auditId: "" }, { state: "not_visible" }])
    assert.equal(analysisBudgetSavedMatches({ ...saved, ...change }, pending), false);
});

const snapshot = { state: "snapshot", version: 1, monthStart: "2026-10-01T00:00:00.000Z",
  limitMicroUsd: "1000000000", spentMicroUsd: "42240000", reservedMicroUsd: "0",
  remainingMicroUsd: "957760000", shadowOverrunMicroUsd: "0", writeEnabled: true };
test("display accepts only coherent server accounting, never unknown usage as zero", () => {
  assert.equal(readAnalysisBudgetSnapshotReply(snapshot)?.remainingMicroUsd, "957760000");
  for (const change of [{ spentMicroUsd: null }, { limitMicroUsd: "0" }, { reservedMicroUsd: "-1" },
    { remainingMicroUsd: "1000000000" }, { shadowOverrunMicroUsd: "42240001" },
    { writeEnabled: undefined }, { monthStart: "yesterday" }])
    assert.equal(readAnalysisBudgetSnapshotReply({ ...snapshot, ...change }), null);
  assert.equal(readAnalysisBudgetSnapshotReply({ ...snapshot, limitMicroUsd: "40000000",
    spentMicroUsd: "50000000", shadowOverrunMicroUsd: "10000000",
    remainingMicroUsd: "0" })?.spentMicroUsd, "50000000");
});

test("the monthly setting reuses the existing budget switches and never adds a call or user-credit capability", () => {
  assert.equal(AMUX_ANALYSIS_BUDGET_READ_ENV, "TOMVERSE_AMUX_V4_ANALYSIS_BUDGET_READ");
  assert.equal(AMUX_ANALYSIS_BUDGET_WRITE_ENV, "TOMVERSE_AMUX_V4_ANALYSIS_BUDGET_RESERVE");
  const route = readFileSync(new URL("../app/api/admin/amux/ideas/analysis-budget-settings/route.ts", import.meta.url), "utf8");
  assert.match(route, /getAdminRole\(session\) !== "owner"/);
  assert.match(route, /assertRecentAdminAuthentication/);
  assert.match(route, /\.strict\(\)/);
  assert.match(route, /private, no-store/);
  assert.doesNotMatch(route, /lockCreditAccount|streamText|generateText|dispatchAnalysis/);
  const panel = readFileSync(new URL("../components/admin/AmuxAnalysisMonthlyBudgetPanel.tsx", import.meta.url), "utf8");
  assert.match(panel, /sessionStorage\.setItem\(recoveryKey, JSON\.stringify\(attempt\)\)/);
  assert.match(panel, /analysisBudgetSavedMatches/);
  assert.match(panel, /setPending\(attempt\)/);
  assert.match(panel, /aria-describedby/);
  assert.equal((panel.match(/setRequiresReauthentication\(response\.status === 428\)/g) ?? []).length, 3);
  assert.match(panel, /requiresReauthentication \? <AmuxAnalysisBudgetReauthenticationNotice/);
});
