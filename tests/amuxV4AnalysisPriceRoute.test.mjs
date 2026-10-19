import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { AMUX_V4_CLAUDE_OPUS_55_COST_PROFILE,
  amuxSubscriptionCliCostProfileMatches,
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
  assert.match(source, /readAnalysisMonthlyBudgetSetting\(tx\)/);
  assert.match(source, /limitMicroUsd: BigInt\(monthlySetting\.limitMicroUsd\)/);
  assert.match(source, /monthlyLimitMicroUsd: window\.limitMicroUsd\.toString\(\)/);
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

test("the v19 Max runner's subscription_cli price uses the same reviewed rates", async () => {
  const row = { ...AMUX_V4_CLAUDE_OPUS_55_COST_PROFILE, status: "approved", mode: "subscription_cli" };
  assert.equal(amuxV4ApprovedCliCostProfileMatches(row, "subscription_cli"), true);
  assert.equal(amuxV4ApprovedCliCostProfileMatches(row), false, "the v4 API path still refuses it");
  assert.equal(amuxV4ApprovedCliCostProfileMatches({ ...row, mode: "api" }, "subscription_cli"), false);
  assert.equal(amuxV4ApprovedCliCostProfileMatches(
    { ...row, inputMicroUsdPerMillion: 7_999_999 }, "subscription_cli"), false);
  const route = await readFile(new URL(
    "../app/api/admin/amux/ideas/analysis-prices/route.ts", import.meta.url), "utf8");
  assert.match(route, /mode: z\.enum\(\["api", "subscription_cli"\]\)\.optional\(\)/);
  assert.match(route, /mode: body\.mode \?\? profile\.mode/);
  assert.match(route, /amuxV4ApprovedCliCostProfileMatches\(latest\)/);
  const page = await readFile(new URL(
    "../app/(site)/(application)/admin/amux-settings/page.tsx", import.meta.url), "utf8");
  assert.match(page, /<AmuxOperatingScopePanel[^>]*\/>\s*<AmuxMaxSubscriptionPricePanel \/>/);
});

test("every approved Frontier model's subscription price is the reviewed Opus profile under its own channel", async () => {
  const profile = AMUX_V4_CLAUDE_OPUS_55_COST_PROFILE;
  for (const model of [{ provider: "anthropic", modelId: "claude-opus-5-5" },
    { provider: "openai", modelId: "gpt-6-luna" },
    { provider: "github-copilot", modelId: "claude-sonnet-4.5" },
    { provider: "cursor", modelId: "gpt-5" }]) {
    const row = { ...profile, ...model, status: "approved", mode: "subscription_cli" };
    assert.equal(amuxSubscriptionCliCostProfileMatches(row, model), true, model.provider);
    for (const change of [{ mode: "api" }, { status: "revoked" },
      { provider: model.provider === "cursor" ? "openai" : "cursor" },
      { modelId: "other-model" }, { inputTokensCap: 999_999 },
      { outputTokensCap: 128_001 }, { inputMicroUsdPerMillion: 7_999_999 },
      { outputMicroUsdPerMillion: 20_000_001 }]) {
      assert.equal(amuxSubscriptionCliCostProfileMatches({ ...row, ...change }, model), false);
    }
    assert.equal(amuxV4ApprovedCliCostProfileMatches(row), false,
      "the v4 API profile check is unchanged");
  }
  const route = await readFile(new URL(
    "../app/api/admin/amux/ideas/analysis-prices/route.ts", import.meta.url), "utf8");
  // A subscription price names its model; the API price never takes one.
  assert.match(route, /provider: provider\.optional\(\),\n {2}modelId: modelId\.optional\(\),/);
  assert.match(route, /subscription !== \(body\.provider !== undefined\) \|\|\n\s+subscription !== \(body\.modelId !== undefined\)/);
  assert.match(route, /provider: subscription \? body\.provider! : profile\.provider/);
  assert.match(route, /requireCurrentFrontierModel: true as const/);
  assert.match(route, /keyCount === 3 && profileName === "max-subscription"/);
  assert.match(route, /amuxSubscriptionCliCostProfileMatches\(latest, selected\.data\)/);
  const writer = await readFile(new URL(
    "../lib/amux/ideaAnalysisPriceVersionWrite.ts", import.meta.url), "utf8");
  assert.match(writer, /input\.requireCurrentFrontierModel === true[\s\S]*readCurrentAmuxIdeaFrontierModelFromTx\(tx,/);
  assert.match(writer, /input\.mode === "api" && !isAmuxV4AnalysisProvider\(input\.provider\)/);
});
