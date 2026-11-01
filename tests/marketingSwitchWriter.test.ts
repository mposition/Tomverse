import assert from "node:assert/strict";
import test from "node:test";

import { MARKETING_CONFIG_GENERATION_KEY } from "../lib/appSettings.ts";
import {
  MARKETING_AUTO_PUBLISH_KEY,
  MARKETING_DRAFTS_KEY,
  MARKETING_PUBLISH_KEY,
} from "../lib/marketingAutomationAccess.ts";
import type { MarketingTransaction } from "../lib/marketingStore.ts";
import {
  MarketingSwitchRefusedError,
  writeMarketingAutomationSwitch,
} from "../lib/marketingSwitchWriter.ts";

// An in-memory AppSetting table with the four calls the writer makes.
function fakeTransaction(initial: Record<string, string>) {
  const rows = new Map(Object.entries(initial));
  const tx = {
    appSetting: {
      findMany: async ({ where }: { where: { key: { in: string[] } } }) =>
        where.key.in.filter((key) => rows.has(key)).map((key) => ({ key, value: rows.get(key) })),
      upsert: async ({ where, update }: { where: { key: string }; update: { value: string } }) => {
        rows.set(where.key, update.value);
      },
      create: async ({ data }: { data: { key: string; value: string } }) => {
        if (rows.has(data.key)) throw new Error("unique constraint");
        rows.set(data.key, data.value);
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { key: string; value: string };
        data: { value: string };
      }) => {
        if (rows.get(where.key) !== where.value) return { count: 0 };
        rows.set(where.key, data.value);
        return { count: 1 };
      },
    },
  };
  return { tx: tx as unknown as MarketingTransaction, rows };
}

const generation = (n: number) => JSON.stringify({ generation: n });

test("publishing can be switched on now that the publisher exists", async () => {
  const { tx, rows } = fakeTransaction({
    [MARKETING_DRAFTS_KEY]: "true",
    [MARKETING_CONFIG_GENERATION_KEY]: generation(3),
  });
  const result = await writeMarketingAutomationSwitch(tx, {
    name: "publish",
    enabled: true,
    expectedConfigGeneration: 3,
  });
  assert.equal(result.configGeneration, 4);
  assert.equal(rows.get(MARKETING_PUBLISH_KEY), "true");
  assert.equal(rows.get(MARKETING_CONFIG_GENERATION_KEY), generation(4));
});

test("autonomous publishing still needs drafts and publishing on first", async () => {
  const { tx, rows } = fakeTransaction({
    [MARKETING_DRAFTS_KEY]: "true",
    [MARKETING_CONFIG_GENERATION_KEY]: generation(1),
  });
  await assert.rejects(
    writeMarketingAutomationSwitch(tx, { name: "autonomous", enabled: true, expectedConfigGeneration: 1 }),
    (error: unknown) =>
      error instanceof MarketingSwitchRefusedError && error.code === "autonomous_needs_drafts_and_publish",
  );
  assert.equal(rows.has(MARKETING_AUTO_PUBLISH_KEY), false);
  assert.equal(rows.get(MARKETING_CONFIG_GENERATION_KEY), generation(1));
});

test("a stale screen is refused before anything is written", async () => {
  const { tx, rows } = fakeTransaction({ [MARKETING_CONFIG_GENERATION_KEY]: generation(5) });
  await assert.rejects(
    writeMarketingAutomationSwitch(tx, { name: "publish", enabled: true, expectedConfigGeneration: 4 }),
    (error: unknown) => error instanceof MarketingSwitchRefusedError && error.code === "switch_conflict",
  );
  assert.equal(rows.has(MARKETING_PUBLISH_KEY), false);
});
