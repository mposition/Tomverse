import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";

import {
  MARKETING_LLM_SETTINGS_KEY,
  marketingLlmAdapterConfigDigest,
  type MarketingLlmPricePin,
} from "@/lib/marketingLlmBudgetCore";
import { readMarketingConsoleOverview } from "@/lib/marketingConsoleOverview";
import {
  dispatchMarketingLlmCall,
  reserveMarketingLlmCall,
  settleMarketingLlmCall,
} from "@/lib/marketingLlmBudgetStore";
import { prisma } from "@/lib/prisma";
import { resetTestFixture } from "./resetTestFixture";

const reset = () =>
  resetTestFixture(
    prisma,
    `TRUNCATE TABLE "MarketingLlmCall", "MarketingPost", "MarketingReport", "MarketingChannel", "MarketingCompetitor", "AdminAuditLog" RESTART IDENTITY CASCADE`,
  );
beforeEach(reset);
after(async () => {
  await reset();
  await prisma.appSetting.deleteMany({ where: { key: MARKETING_LLM_SETTINGS_KEY } });
  await prisma.$disconnect();
});

test("an empty marketing record reads as zeros and 'never ran', not as unreadable", async () => {
  const { readAt, environment, ...overview } = await readMarketingConsoleOverview();
  assert.ok(Date.parse(readAt) > 0);
  assert.equal(typeof environment, "string");
  assert.deepEqual(overview, {
    pending: { count: 0, oldestAt: null },
    llm: { calls: 0, countedMicroUsd: 0, tokenMicroUsd: 0 },
    lastRun: { at: null, calls: 0, reportAt: null, factsKept: null, factsDropped: null },
    accounts: { total: 0, byStatus: {} },
    competitors: { approved: 0 },
  });
});

test("the month's counted spend is settled calls at their cost and open calls at their reservation", async () => {
  const day = 24 * 60 * 60 * 1000;
  const verifiedAt = Math.floor(Date.now() / day) * day - day;
  // 128,000 x 0.8 + 4,096 x 3.2 -> 115,508 micro-USD per reservation.
  const pin: MarketingLlmPricePin = {
    model: "fixture-model-2026-10-01",
    tokenizerFamily: "o200k",
    projectId: "proj_fixture",
    region: "us",
    tiers: ["default"],
    contextWindowTokens: 128_000,
    worstInputMicroUsdPerMillion: 800_000,
    worstOutputMicroUsdPerMillion: 3_200_000,
    maxOutputTokens: 4_096,
    priceVersion: "fixture-v1",
    verifiedAt: new Date(verifiedAt).toISOString(),
    expiresAt: new Date(verifiedAt + 90 * day).toISOString(),
    source: "https://example.invalid/pricing",
  };
  await prisma.appSetting.upsert({
    where: { key: MARKETING_LLM_SETTINGS_KEY },
    update: { value: JSON.stringify({ model: pin.model, monthlyUsdCap: "1" }) },
    create: { key: MARKETING_LLM_SETTINGS_KEY, value: JSON.stringify({ model: pin.model, monthlyUsdCap: "1" }) },
  });
  const env = { killSwitchOn: false, pins: [pin] };
  const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const deadlineAt = () => new Date(Date.now() + 60_000);
  const reserve = async (n: number) => {
    const outcome = await prisma.$transaction((tx) =>
      reserveMarketingLlmCall(
        tx,
        { payload: { requestKey: uuid(n), generatorRunId: "run-1", purpose: "draft", model: pin.model, adapterProfile: "text-only-v1" }, deadlineAt: deadlineAt() },
        env,
      ),
    );
    assert.equal(outcome.status, "ok");
    return outcome.status === "ok" ? outcome.value.callId : "";
  };
  const settledId = await reserve(1);
  const stored = await prisma.marketingLlmCall.findUniqueOrThrow({ where: { id: settledId } });
  const adapterConfigDigest = marketingLlmAdapterConfigDigest(
    stored.configSnapshot as Parameters<typeof marketingLlmAdapterConfigDigest>[0],
  );
  await prisma.$transaction((tx) =>
    dispatchMarketingLlmCall(tx, { callId: settledId, requestKey: uuid(1), dispatchIntentId: uuid(101), adapterConfigDigest, deadlineAt: deadlineAt() }, env),
  );
  const settled = await prisma.$transaction((tx) =>
    settleMarketingLlmCall(
      tx,
      {
        callId: settledId,
        dispatchIntentId: uuid(101),
        observation: { observationId: uuid(201), reportedModel: pin.model, reportedServiceTier: "default", reportedInputTokens: 1_200, reportedOutputTokens: 300 },
        deadlineAt: deadlineAt(),
      },
      env,
    ),
  );
  assert.equal(settled.status, "ok");
  await reserve(2);

  // 1,200 x 0.8 + 300 x 3.2 -> 1,920 for the settled call, 115,508 for the open one.
  const { llm } = await readMarketingConsoleOverview();
  assert.deepEqual(llm, { calls: 2, countedMicroUsd: 1_920 + 115_508, tokenMicroUsd: 1_920 });
});
