import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";

import { MARKETING_LLM_SETTINGS_KEY, type MarketingLlmPricePin } from "@/lib/marketingLlmBudgetCore";
import {
  MarketingLlmSettingsRefusedError,
  readMarketingLlmSettings,
  writeMarketingLlmSettings,
} from "@/lib/marketingLlmSettingsStore";
import { runMarketingTransaction, type MarketingTransaction } from "@/lib/marketingStore";
import { prisma } from "@/lib/prisma";
import { clearMarketingLlmSettings } from "./marketingLlmSettingsFixture";

beforeEach(() => clearMarketingLlmSettings(prisma));
after(async () => {
  await clearMarketingLlmSettings(prisma);
  await prisma.$disconnect();
});

const PIN = { model: "fixture-model-2026-10-01" } as MarketingLlmPricePin;
const pins = [PIN];
const tx = <T>(fn: (client: MarketingTransaction) => Promise<T>) => runMarketingTransaction(prisma, fn);
const write = (input: { model: string | null; monthlyUsdCap: string | null; expectedVersion: string | null }) =>
  tx((client) => writeMarketingLlmSettings(client, { ...input, pins }));
const refusal = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof MarketingLlmSettingsRefusedError, String(error));
    return error.code;
  }
  assert.fail("expected a refusal");
};

test("a first save creates the document, and later saves compare against the version read", async () => {
  assert.deepEqual(await readMarketingLlmSettings(prisma), {
    settings: { model: null, monthlyUsdCap: null },
    version: null,
  });
  const first = await write({ model: PIN.model, monthlyUsdCap: "10", expectedVersion: null });
  assert.deepEqual(first.settings, { model: PIN.model, monthlyUsdCap: "10" });
  assert.ok(first.version);

  // A screen that read before the first save is behind.
  assert.equal(await refusal(write({ model: null, monthlyUsdCap: "5", expectedVersion: null })), "settings_conflict");
  // The same values again are no change.
  assert.equal(
    await refusal(write({ model: PIN.model, monthlyUsdCap: "10", expectedVersion: first.version })),
    "settings_change_is_noop",
  );

  const lowered = await write({ model: PIN.model, monthlyUsdCap: "2.5", expectedVersion: first.version });
  assert.deepEqual(lowered.settings, { model: PIN.model, monthlyUsdCap: "2.5" });
  assert.notEqual(lowered.version, first.version);
  // The older version is now stale.
  assert.equal(await refusal(write({ model: null, monthlyUsdCap: null, expectedVersion: first.version })), "settings_conflict");

  const cleared = await write({ model: null, monthlyUsdCap: null, expectedVersion: lowered.version });
  assert.deepEqual(cleared.settings, { model: null, monthlyUsdCap: null });
});

test("only a pinned model and a cap within the ceiling can be saved, and a refusal writes nothing", async () => {
  assert.equal(await refusal(write({ model: "unpinned", monthlyUsdCap: "1", expectedVersion: null })), "model_not_pinned");
  for (const cap of ["0", "101", "-1", "1.1234567", "ten"]) {
    assert.equal(await refusal(write({ model: PIN.model, monthlyUsdCap: cap, expectedVersion: null })), "cap_invalid", cap);
  }
  assert.equal(await prisma.appSetting.count({ where: { key: MARKETING_LLM_SETTINGS_KEY } }), 0);
});

test("an unreadable stored document reads as null and can be replaced from its version", async () => {
  await prisma.appSetting.create({ data: { key: MARKETING_LLM_SETTINGS_KEY, value: "{" } });
  const read = await readMarketingLlmSettings(prisma);
  assert.equal(read.settings, null);
  assert.ok(read.version);
  const saved = await write({ model: PIN.model, monthlyUsdCap: "1", expectedVersion: read.version });
  assert.deepEqual(saved.settings, { model: PIN.model, monthlyUsdCap: "1" });
});
