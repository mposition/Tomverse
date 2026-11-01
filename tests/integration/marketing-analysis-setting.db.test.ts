import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";

import {
  MARKETING_ANALYSIS_ENABLED_KEY,
  MarketingAnalysisSettingsRefusedError,
} from "@/lib/marketingAnalysisCore";
import { readMarketingAnalysisSetting, writeMarketingAnalysisSetting } from "@/lib/marketingAnalysisStore";
import { runMarketingTransaction } from "@/lib/marketingStore";
import { prisma } from "@/lib/prisma";

// The analysis and brief switch's one writer (operator decision 2026-11-01):
// default off, compare-and-set against the version a screen read, and no
// audit row for a save that changes nothing (the route writes the audit row
// in the same transaction, and a refusal here rolls it back).

const clear = () => prisma.appSetting.deleteMany({ where: { key: MARKETING_ANALYSIS_ENABLED_KEY } });
beforeEach(clear);
after(async () => {
  await clear();
  await prisma.$disconnect();
});

const write = (enabled: boolean, expectedVersion: string | null) =>
  runMarketingTransaction(prisma, (tx) => writeMarketingAnalysisSetting(tx, { enabled, expectedVersion }));

const refusal = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof MarketingAnalysisSettingsRefusedError, String(error));
    return error.code;
  }
  assert.fail("expected a refusal");
};

test("the switch is off until a first save turns it on, and every later save names the version it read", async () => {
  assert.deepEqual(await readMarketingAnalysisSetting(prisma), { enabled: false, version: null });
  // Off is already off: no row is written for nothing.
  assert.equal(await refusal(write(false, null)), "settings_change_is_noop");
  assert.equal(await prisma.appSetting.count({ where: { key: MARKETING_ANALYSIS_ENABLED_KEY } }), 0);

  const on = await write(true, null);
  assert.equal(on.enabled, true);
  assert.ok(on.version);
  assert.equal(
    (await prisma.appSetting.findUniqueOrThrow({ where: { key: MARKETING_ANALYSIS_ENABLED_KEY } })).value,
    "true",
  );

  // A screen that read before the first save is behind, and the same position is no change.
  assert.equal(await refusal(write(false, null)), "settings_conflict");
  assert.equal(await refusal(write(true, on.version)), "settings_change_is_noop");

  const off = await write(false, on.version);
  assert.deepEqual({ enabled: off.enabled, moved: off.version !== on.version }, { enabled: false, moved: true });
  // The version it was turned off from is now stale.
  assert.equal(await refusal(write(true, on.version)), "settings_conflict");
});
