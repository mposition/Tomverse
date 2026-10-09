import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { AMUX_V4_CLAUDE_OPUS_55_COST_PROFILE,
  amuxV4ApprovedCliCostProfileMatches,
  amuxV4ApprovedCliPriceEvidenceDigest } from
  "../lib/amux/ideaAnalysisApprovedCostProfile.ts";

test("analysis price approval is owner-only and independently switched", async () => {
  const route = await readFile(new URL(
    "../app/api/admin/amux/ideas/analysis-prices/route.ts", import.meta.url), "utf8");
  assert.match(route, /getAdminRole\(session\) !== "owner"/);
  assert.match(route, /assertRecentAdminAuthentication\(session\)/);
  assert.match(route, /const WRITE_ENV = "TOMVERSE_AMUX_V4_ANALYSIS_PRICE_WRITE"/);
  assert.match(route, /const READ_ENV = "TOMVERSE_AMUX_V4_ANALYSIS_PRICE_READ"/);
  assert.match(route, /commitAmuxIdeaAnalysisPriceApproval\(tx,/);
  assert.match(route, /export async function DELETE\(request: Request\)/);
  assert.match(route, /commitAmuxIdeaAnalysisPriceRevocation\(tx,/);
  assert.match(route, /retryWrite: false/);
  assert.doesNotMatch(route, /\b(?:runAmuxV4IsolatedApprovedAnalysis|commitAmuxIdeaOnlyAnalysisClaim)\s*\(/);
});

test("only the approved worst-tier CLI price profile can reserve", () => {
  const profile = AMUX_V4_CLAUDE_OPUS_55_COST_PROFILE;
  const row = { ...profile, status: "approved" };
  assert.equal(profile.maxReservationMicroUsd, 10_560_000n);
  assert.match(amuxV4ApprovedCliPriceEvidenceDigest(), /^[a-f0-9]{64}$/);
  assert.equal(amuxV4ApprovedCliCostProfileMatches(row), true);
  for (const change of [
    { status: "revoked" }, { modelId: "claude-sonnet-5-5" },
    { mode: "subscription_cli" }, { inputTokensCap: 999_999 },
    { outputTokensCap: 127_999 },
    { inputTokensCap: 1_000_001 },
    { outputTokensCap: 128_001 },
    { inputMicroUsdPerMillion: 7_999_999 },
    { inputMicroUsdPerMillion: 8_000_001 },
    { outputMicroUsdPerMillion: 19_999_999 },
  ]) assert.equal(amuxV4ApprovedCliCostProfileMatches({ ...row, ...change }), false);
});

test("reservation route cannot claim or dispatch and binds an owner", async () => {
  const route = await readFile(new URL(
    "../app/api/admin/amux/ideas/analysis-reservations/route.ts", import.meta.url), "utf8");
  assert.match(route, /getAdminRole\(session\) !== "owner"/);
  assert.match(route, /assertRecentAdminAuthentication\(session\)/);
  assert.match(route, /preview\.confirmedByUserId !== session\.user!.id!/);
  assert.match(route, /idea\.actorUserId !== session\.user!.id!/);
  assert.match(route, /amuxV4ApprovedCliCostProfileMatches\(price\)/);
  assert.match(route, /commitAmuxIdeaAnalysisBudgetReservation\(tx,/);
  assert.match(route, /previewId: parsed\.data/);
  assert.doesNotMatch(route, /\b(?:runAmuxV4IsolatedApprovedAnalysis|commitAmuxIdeaOnlyAnalysisClaim)\s*\(/);
});

test("first reservation creates a capped UTC monthly ledger in the same transaction", async () => {
  const source = await readFile(new URL(
    "../lib/amux/ideaAnalysisBudgetReservationService.ts", import.meta.url), "utf8");
  assert.match(source, /amuxIdeaAnalysisBudgetWindow\.createMany/);
  assert.match(source, /limitMicroUsd: BigInt\(AMUX_V4_ANALYSIS_MONTHLY_CAP_MICROUSD\)/);
  assert.match(source, /monthStart = new Date\(Date\.UTC/);
});

test("Admin budget step is shown only after transfer confirmation", async () => {
  const panel = await readFile(new URL(
    "../components/admin/AmuxFrontierModelsPanel.tsx", import.meta.url), "utf8");
  const budget = await readFile(new URL(
    "../components/admin/AmuxAnalysisBudgetPanel.tsx", import.meta.url), "utf8");
  assert.match(panel, /confirmation\.kind === "confirmed" \? <AmuxAnalysisBudgetPanel/);
  assert.match(budget, /analysis-reservations\?\$\{query\}/);
  assert.match(budget, /setUnknown\("hold"\)/);
  assert.match(budget, /ownerConfirmedWorstTier: true/);
  assert.match(budget, /method: "DELETE"/);
  assert.match(budget, /pendingRevocationId/);
});
