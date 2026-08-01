import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import { prisma } from "@/lib/prisma";
import { getFallbackPricingReport } from "@/lib/fallbackPricingMetrics";
import { FALLBACK_COST_SOURCE } from "@/lib/fallbackPricingMetricsCore";
import {
  OPERATIONAL_COST_GUARDRAIL_TRIGGERED,
  CREDIT_BALANCE_INSUFFICIENT,
} from "@/lib/chatCostSafetyCore";
import { PENDING_VERIFIED_PRICE_REGISTER } from "@/lib/modelPricing";

// The share and the reserved/settled ratio are read out of two JSON columns
// (`ChatLimitDecisionEvent.models`, `ChatCreditReservation.pricingSnapshot`).
// A JSON read that quietly returns nothing looks exactly like "no model is on
// the fallback", which is the one answer this report must never invent, so the
// aggregation is exercised against a real database rather than a stub.

const resetData = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "ChatLimitDecisionEvent",
      "ChatCreditReservation",
      "User"
    RESTART IDENTITY CASCADE
  `);

beforeEach(resetData);
after(async () => {
  await resetData();
  await prisma.$disconnect();
});

const decision = ({
  decision,
  errorCode = null,
  limitLayer = null,
  models,
  createdAt = new Date(),
}: {
  decision: "allowed" | "rejected";
  errorCode?: string | null;
  limitLayer?: string | null;
  models: { modelId: string; costSource: string }[];
  createdAt?: Date;
}) =>
  prisma.chatLimitDecisionEvent.create({
    data: {
      traceId: randomUUID(),
      subjectKey: `user:${randomUUID()}`,
      plan: "Pro",
      phase: "chat_reservation",
      decision,
      errorCode,
      limitLayer,
      modelIds: models.map((model) => model.modelId),
      enabledTools: [],
      models: models.map((model) => ({
        ...model,
        provider: "xai",
        estimatedInputTokens: 1_000,
        estimatedOutputTokens: 4_096,
        estimatedCostMicroUsd: 260_760,
        inputUsdPerMillionTokens: 15,
        outputUsdPerMillionTokens: 60,
        pricingVersion: "fallback-2026-08",
        longContextThresholdTokens: null,
      })),
      timeZone: "Australia/Brisbane",
      createdAt,
    },
  });

const reservation = ({
  modelId,
  reservationCostSource,
  reservedCostMicroUsd,
  settledCostMicroUsd,
  settled = true,
  createdAt = new Date(),
}: {
  modelId: string;
  reservationCostSource: string | null;
  reservedCostMicroUsd: number;
  settledCostMicroUsd: number;
  settled?: boolean;
  createdAt?: Date;
}) =>
  prisma.chatCreditReservation.create({
    data: {
      id: randomUUID(),
      subjectKey: `user:${randomUUID()}`,
      traceId: randomUUID(),
      source: "chat",
      provider: "xai",
      modelId,
      status: settled ? "settled" : "reserved",
      idempotencyKey: randomUUID(),
      reservationPayload: { modelId },
      reservedCredits: 1,
      reservedCostMicroUsd: BigInt(reservedCostMicroUsd),
      planReservedCredits: 1,
      addOnReservedCredits: 0,
      settledCredits: settled ? 1 : 0,
      settledCostMicroUsd: BigInt(settled ? settledCostMicroUsd : 0),
      pricingSnapshot:
        reservationCostSource === null
          ? undefined
          : { reservationCostSource, pricingVersion: "fallback-2026-08" },
      expiresAt: new Date(Date.now() + 300_000),
      settledAt: settled ? new Date() : null,
      createdAt,
    },
  });

test("the report reads the fallback share out of the decision events", async () => {
  await decision({
    decision: "allowed",
    models: [{ modelId: "grok-4", costSource: FALLBACK_COST_SOURCE }],
  });
  await decision({
    decision: "allowed",
    models: [{ modelId: "gpt-5-5", costSource: "registry" }],
  });

  const report = await getFallbackPricingReport();
  assert.equal(report.decisions.unavailable, false);
  assert.equal(report.decisions.decisions, 2);
  assert.equal(report.decisions.fallbackDecisions, 1);
  assert.equal(report.decisions.fallbackShare, 0.5);
  assert.deepEqual(report.decisions.byModel, [
    { modelId: "grok-4", decisions: 1, rejections: 0 },
  ]);
});

test("refusals involving a fallback price are counted by code", async () => {
  await decision({
    decision: "rejected",
    errorCode: OPERATIONAL_COST_GUARDRAIL_TRIGGERED,
    limitLayer: "operational_guardrail",
    models: [{ modelId: "grok-4", costSource: FALLBACK_COST_SOURCE }],
  });
  await decision({
    decision: "rejected",
    errorCode: CREDIT_BALANCE_INSUFFICIENT,
    limitLayer: "entitlement",
    models: [{ modelId: "qwen3.7-max", costSource: FALLBACK_COST_SOURCE }],
  });
  await decision({
    decision: "rejected",
    errorCode: CREDIT_BALANCE_INSUFFICIENT,
    limitLayer: "entitlement",
    models: [{ modelId: "gpt-5-5", costSource: "registry" }],
  });

  const report = await getFallbackPricingReport();
  assert.equal(report.decisions.rejections, 3);
  assert.equal(report.decisions.fallbackAttributableRejections, 2);
  assert.deepEqual(report.decisions.rejectionsByErrorCode, {
    [OPERATIONAL_COST_GUARDRAIL_TRIGGERED]: 1,
    [CREDIT_BALANCE_INSUFFICIENT]: 1,
  });
});

test("the reserved/settled ratio comes from the reservation snapshots", async () => {
  await reservation({
    modelId: "grok-4",
    reservationCostSource: FALLBACK_COST_SOURCE,
    reservedCostMicroUsd: 900_000,
    settledCostMicroUsd: 300_000,
  });
  await reservation({
    modelId: "grok-4",
    reservationCostSource: FALLBACK_COST_SOURCE,
    reservedCostMicroUsd: 300_000,
    settledCostMicroUsd: 0,
    settled: false,
  });
  // A registry-priced reservation measures output-length estimation, not the
  // fallback, so it must not move this ratio.
  await reservation({
    modelId: "gpt-5-5",
    reservationCostSource: "registry",
    reservedCostMicroUsd: 5_000_000,
    settledCostMicroUsd: 100_000,
  });
  // Older rows predate the snapshot field entirely.
  await reservation({
    modelId: "grok-4-5",
    reservationCostSource: null,
    reservedCostMicroUsd: 4_000_000,
    settledCostMicroUsd: 1_000,
  });

  const report = await getFallbackPricingReport();
  assert.equal(report.reservations.unavailable, false);
  assert.equal(report.reservations.reservations, 2);
  assert.equal(report.reservations.settledReservations, 1);
  assert.equal(report.reservations.reservedToSettledRatio, 3);
  assert.deepEqual(
    report.reservations.byModel.map((entry) => entry.modelId),
    ["grok-4"]
  );
});

test("rows outside the window are excluded", async () => {
  const old = new Date(Date.now() - 10 * 86_400_000);
  await decision({
    decision: "allowed",
    models: [{ modelId: "grok-4", costSource: FALLBACK_COST_SOURCE }],
    createdAt: old,
  });
  await reservation({
    modelId: "grok-4",
    reservationCostSource: FALLBACK_COST_SOURCE,
    reservedCostMicroUsd: 900_000,
    settledCostMicroUsd: 300_000,
    createdAt: old,
  });

  const week = await getFallbackPricingReport({ windowDays: 7 });
  assert.equal(week.decisions.decisions, 0);
  assert.equal(week.decisions.fallbackShare, null);
  assert.equal(week.reservations.reservations, 0);

  const month = await getFallbackPricingReport({ windowDays: 30 });
  assert.equal(month.decisions.fallbackDecisions, 1);
  assert.equal(month.reservations.reservations, 1);
});

test("a fallback-priced model nobody registered is reported as drift", async () => {
  await decision({
    decision: "allowed",
    models: [
      { modelId: "grok-4", costSource: FALLBACK_COST_SOURCE },
      { modelId: "brand-new-premium-model", costSource: FALLBACK_COST_SOURCE },
    ],
  });

  const report = await getFallbackPricingReport();
  assert.deepEqual(report.unregisteredFallbackModels, [
    "brand-new-premium-model",
  ]);
  assert.equal(
    report.register.length,
    PENDING_VERIFIED_PRICE_REGISTER.length
  );
  for (const entry of report.register) {
    assert.equal(typeof entry.daysUntilExpiry, "number");
  }
});

test("the window is clamped rather than trusted", async () => {
  assert.equal((await getFallbackPricingReport({ windowDays: 0 })).windowDays, 1);
  assert.equal(
    (await getFallbackPricingReport({ windowDays: 10_000 })).windowDays,
    90
  );
  assert.equal(
    (await getFallbackPricingReport({ windowDays: Number.NaN })).windowDays,
    7
  );
});
