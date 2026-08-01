import assert from "node:assert/strict";
import test from "node:test";
import {
  FALLBACK_COST_SOURCE,
  summarizeFallbackPricingDecisions,
  summarizeFallbackReservations,
} from "../lib/fallbackPricingMetricsCore.ts";
import {
  CREDIT_BALANCE_INSUFFICIENT,
  OPERATIONAL_COST_GUARDRAIL_TRIGGERED,
} from "../lib/chatCostSafetyCore.ts";

const fallbackModel = (modelId) => ({
  modelId,
  costSource: FALLBACK_COST_SOURCE,
});
const pricedModel = (modelId) => ({ modelId, costSource: "explicit_profile" });

const allowed = (models) => ({
  decision: "allowed",
  errorCode: null,
  limitLayer: null,
  models,
});
const rejected = (models, errorCode, limitLayer) => ({
  decision: "rejected",
  errorCode,
  limitLayer,
  models,
});

test("the fallback share counts decisions, not models", () => {
  const summary = summarizeFallbackPricingDecisions([
    allowed([fallbackModel("grok-4"), fallbackModel("qwen3.7-max")]),
    allowed([pricedModel("claude-opus-4-8")]),
    allowed([pricedModel("gpt-5-5"), fallbackModel("grok-4")]),
    allowed([pricedModel("gemini-3-1-pro")]),
  ]);
  assert.equal(summary.decisions, 4);
  assert.equal(summary.fallbackDecisions, 2);
  assert.equal(summary.fallbackShare, 0.5);
});

test("an empty window reports no share rather than zero", () => {
  const summary = summarizeFallbackPricingDecisions([]);
  assert.equal(summary.decisions, 0);
  assert.equal(summary.fallbackShare, null);
});

test("only cost-code refusals are attributed to the fallback", () => {
  const summary = summarizeFallbackPricingDecisions([
    rejected([fallbackModel("grok-4")], CREDIT_BALANCE_INSUFFICIENT, "entitlement"),
    rejected(
      [fallbackModel("grok-4")],
      OPERATIONAL_COST_GUARDRAIL_TRIGGERED,
      "operational_guardrail"
    ),
    // A refusal with no cost code says nothing about pricing.
    rejected([fallbackModel("grok-4")], "ATTACHMENT_TOO_LARGE", null),
    // A cost refusal on a priced model is not the fallback's doing.
    rejected([pricedModel("gpt-5-5")], CREDIT_BALANCE_INSUFFICIENT, "entitlement"),
  ]);
  assert.equal(summary.rejections, 4);
  assert.equal(summary.fallbackAttributableRejections, 2);
  assert.deepEqual(summary.rejectionsByErrorCode, {
    [CREDIT_BALANCE_INSUFFICIENT]: 1,
    [OPERATIONAL_COST_GUARDRAIL_TRIGGERED]: 1,
  });
});

test("per-model counts credit each fallback model once per decision", () => {
  const summary = summarizeFallbackPricingDecisions([
    allowed([fallbackModel("grok-4"), fallbackModel("grok-4")]),
    rejected(
      [fallbackModel("grok-4"), fallbackModel("mistral-large-3")],
      OPERATIONAL_COST_GUARDRAIL_TRIGGERED,
      "operational_guardrail"
    ),
  ]);
  assert.deepEqual(summary.byModel, [
    { modelId: "grok-4", decisions: 2, rejections: 1 },
    { modelId: "mistral-large-3", decisions: 1, rejections: 1 },
  ]);
});

test("malformed model payloads are ignored, not counted as fallback", () => {
  const summary = summarizeFallbackPricingDecisions([
    allowed([{ modelId: "grok-4", costSource: null }]),
    allowed([]),
  ]);
  assert.equal(summary.fallbackDecisions, 0);
  assert.deepEqual(summary.byModel, []);
});

const reservation = (overrides) => ({
  modelId: "grok-4",
  reservationCostSource: FALLBACK_COST_SOURCE,
  reservedCostMicroUsd: 0,
  settledCostMicroUsd: 0,
  settled: true,
  ...overrides,
});

test("the reserved-to-settled ratio uses settled reservations only", () => {
  const summary = summarizeFallbackReservations([
    reservation({ reservedCostMicroUsd: 400_000, settledCostMicroUsd: 100_000 }),
    reservation({ reservedCostMicroUsd: 200_000, settledCostMicroUsd: 100_000 }),
    // Still open: it has no settled figure, and counting its zero would
    // report an over-reservation nobody has measured.
    reservation({ reservedCostMicroUsd: 900_000, settled: false }),
  ]);
  assert.equal(summary.reservations, 3);
  assert.equal(summary.settledReservations, 2);
  assert.equal(summary.reservedCostMicroUsd, 600_000);
  assert.equal(summary.settledCostMicroUsd, 200_000);
  assert.equal(summary.reservedToSettledRatio, 3);
});

test("reservations priced from a real profile are excluded", () => {
  const summary = summarizeFallbackReservations([
    reservation({
      modelId: "gpt-5-5",
      reservationCostSource: "explicit_profile",
      reservedCostMicroUsd: 1_000_000,
      settledCostMicroUsd: 10_000,
    }),
    reservation({ reservedCostMicroUsd: 100_000, settledCostMicroUsd: 50_000 }),
  ]);
  assert.equal(summary.reservations, 1);
  assert.equal(summary.reservedToSettledRatio, 2);
  assert.deepEqual(
    summary.byModel.map((entry) => entry.modelId),
    ["grok-4"]
  );
});

test("a window with nothing settled reports no ratio", () => {
  const summary = summarizeFallbackReservations([
    reservation({ reservedCostMicroUsd: 500_000, settled: false }),
  ]);
  assert.equal(summary.reservations, 1);
  assert.equal(summary.settledReservations, 0);
  assert.equal(summary.reservedToSettledRatio, null);
  assert.equal(summary.byModel[0].reservedToSettledRatio, null);
});

test("per-model ratios are computed separately", () => {
  const summary = summarizeFallbackReservations([
    reservation({ reservedCostMicroUsd: 300_000, settledCostMicroUsd: 100_000 }),
    reservation({
      modelId: "perplexity/sonar-deep-research",
      reservedCostMicroUsd: 1_000_000,
      settledCostMicroUsd: 500_000,
    }),
  ]);
  const byModel = Object.fromEntries(
    summary.byModel.map((entry) => [entry.modelId, entry.reservedToSettledRatio])
  );
  assert.deepEqual(byModel, {
    "grok-4": 3,
    "perplexity/sonar-deep-research": 2,
  });
});
