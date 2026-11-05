import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { AMUX_V19_SUBSCRIPTION_NO_PRICE_ID, AMUX_V4_CLAUDE_OPUS_55_COST_PROFILE } from
  "../lib/amux/ideaAnalysisApprovedCostProfile.ts";
import { readAmuxV19MaxPriceSelection } from
  "../lib/amux/ideaSessionMaxPriceSelectionRead.ts";

const reservationId = "bf72ad14-585c-41bd-b25e-aab4c17a6d3c";
const ideaId = "53d6918e-b05d-4531-a1ab-704dd756cc40";
const now = new Date("2026-11-04T00:00:00.000Z");

/** No price table on purpose: the read must not need one. */
const tx = (change: Record<string, unknown> = {}, idea: Record<string, unknown> = {}) => ({
  $queryRaw: async (strings: TemplateStringsArray) =>
    strings.join("").includes("clock_timestamp") ? [{ now }] : [{}],
  amuxIdeaSessionAnalysisReservation: { findUnique: async () => ({
    ideaId, status: "queued", modelProvider: "anthropic",
    modelId: "claude-opus-5-5", reasoningEffort: "high", ...change,
    idea: { submissionOrigin: "session", state: "submitted", cancelledAt: null,
      analysisCompletedAt: null, planRefusals: [],
      analysisDeadlineAt: new Date("2026-11-05T00:00:00.000Z"), ...idea },
  }) },
});
const read = (client: ReturnType<typeof tx>) => readAmuxV19MaxPriceSelection(
  client as never, { reservationId, ideaId });

test("a queued subscription reservation is ready with no approved price row", async () => {
  assert.deepEqual(await read(tx()), { kind: "ready",
    priceVersionId: AMUX_V19_SUBSCRIPTION_NO_PRICE_ID, provider: "anthropic",
    modelId: "claude-opus-5-5", reasoningEffort: "high" });
});

test("the runner's own id check still accepts the fixed id", () => {
  assert.match(AMUX_V19_SUBSCRIPTION_NO_PRICE_ID, /^[A-Za-z0-9:_-]{1,128}$/);
});

test("the claim guard's fixed rates are the code's fixed rates", () => {
  const guard = readFileSync(new URL(
    "../prisma/migrations/20261104150000_amux_v19_subscription_claim_no_price/migration.sql",
    import.meta.url), "utf8");
  const profile = AMUX_V4_CLAUDE_OPUS_55_COST_PROFILE;
  assert.ok(guard.includes(`ROW(${profile.inputTokensCap}, ${profile.outputTokensCap}, ${
    profile.inputMicroUsdPerMillion}, ${profile.outputMicroUsdPerMillion})`));
});

test("an open plan refusal holds the claim until it is decided", async () => {
  assert.deepEqual(await readAmuxV19MaxPriceSelection(
    tx({}, { planRefusals: [{ id: "r" }] }) as never, { reservationId, ideaId }), { kind: "hold" });
});

test("reservation state still holds the claim", async () => {
  for (const client of [tx({ status: "claimed" }), tx({ modelProvider: "gemini" }),
    tx({}, { submissionOrigin: "owner" }), tx({}, { state: "cancelled" }),
    tx({}, { cancelledAt: now }), tx({}, { analysisCompletedAt: now }),
    tx({}, { analysisDeadlineAt: now })]) {
    assert.deepEqual(await read(client), { kind: "hold" });
  }
});
