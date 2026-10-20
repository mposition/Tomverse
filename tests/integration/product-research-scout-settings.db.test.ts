import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";

import { prisma } from "@/lib/prisma";
import {
  SCOUT_DAILY_CALL_CAP_SETTING_KEY,
  SCOUT_MODEL_SETTING_KEY,
  readScoutSettings,
  startScoutCall,
  writeScoutSettings,
} from "@/lib/productResearchScoutSettings";
import { resetTestFixture } from "./resetTestFixture";

/**
 * The Scout's spending stop (docs/policy/product-research-agent.md §11, §13):
 * a call is reserved against the model and the daily cap as they are when the
 * reservation holds the ledger lock, not as the route read them earlier, so
 * an owner who turns the model off or lowers the cap stops every call after
 * the change.
 */
const reset = async () => {
  await resetTestFixture(prisma, `TRUNCATE TABLE "ProductResearchScoutLlmCall" RESTART IDENTITY CASCADE`);
  await prisma.appSetting.deleteMany({ where: { key: { in: [SCOUT_MODEL_SETTING_KEY, SCOUT_DAILY_CALL_CAP_SETTING_KEY] } } });
};
const noAudit = async () => {};

beforeEach(reset);
after(async () => {
  await reset();
  await prisma.$disconnect();
});

test("lowering the cap stops the next reservation, though the caller read the old cap", async () => {
  await writeScoutSettings({ modelId: "fixture-model", dailyCallCap: 2 }, noAudit);
  const before = await readScoutSettings();
  assert.equal(before.dailyCallCap, 2);
  assert.ok("id" in (await startScoutCall({ subject: "home.en", modelId: "fixture-model" })));

  await writeScoutSettings({ modelId: "fixture-model", dailyCallCap: 1 }, noAudit);
  assert.deepEqual(await startScoutCall({ subject: "faq.en", modelId: "fixture-model" }), { refused: "daily_cap_reached" });
  await writeScoutSettings({ modelId: "fixture-model", dailyCallCap: 0 }, noAudit);
  assert.deepEqual(await startScoutCall({ subject: "faq.en", modelId: "fixture-model" }), { refused: "daily_cap_reached" });
  assert.equal(await prisma.productResearchScoutLlmCall.count(), 1);
});

test("turning the model off, or choosing another, refuses a reservation for the old one", async () => {
  await writeScoutSettings({ modelId: "fixture-model", dailyCallCap: 10 }, noAudit);
  await writeScoutSettings({ modelId: null, dailyCallCap: 10 }, noAudit);
  assert.deepEqual(await startScoutCall({ subject: "home.en", modelId: "fixture-model" }), { refused: "model_off" });

  await writeScoutSettings({ modelId: "other-model", dailyCallCap: 10 }, noAudit);
  assert.deepEqual(await startScoutCall({ subject: "home.en", modelId: "fixture-model" }), { refused: "model_off" });
  assert.ok("id" in (await startScoutCall({ subject: "home.en", modelId: "other-model" })));
  assert.equal(await prisma.productResearchScoutLlmCall.count(), 1);
});

test("the cap still holds when reservations race for the last slot", async () => {
  await writeScoutSettings({ modelId: "fixture-model", dailyCallCap: 3 }, noAudit);
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, index) => startScoutCall({ subject: `page-${index}`, modelId: "fixture-model" })),
  );
  assert.equal(results.filter((result) => "id" in result).length, 3);
  assert.equal(results.filter((result) => "refused" in result && result.refused === "daily_cap_reached").length, 5);
  assert.equal(await prisma.productResearchScoutLlmCall.count(), 3);
});
