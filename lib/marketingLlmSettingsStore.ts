import "server-only";

import type { PrismaClient } from "@prisma/client";

import { marketingLlmCatalogPinsIn } from "@/lib/marketingLlmModelCatalog";
import {
  MARKETING_LLM_SETTINGS_KEY,
  marketingLlmSettingsValue,
  parseMarketingLlmMonthlyCap,
  parseMarketingLlmSettings,
  type MarketingLlmPricePin,
  type MarketingLlmSettings,
} from "@/lib/marketingLlmBudgetCore";
import {
  MARKETING_LLM_SETTINGS_ACTION,
  MarketingLlmSettingsRefusedError,
} from "@/lib/marketingLlmSettingsCore";
import type { MarketingTransaction } from "@/lib/marketingStore";

/**
 * The marketing generator's model and monthly cap, set by the operator in the
 * Admin Console (operator decision 2026-10-19) instead of in the environment.
 *
 * The one writer of `MARKETING_LLM_SETTINGS_KEY`. The cost ledger reads the
 * document inside every reservation, after the audit chain lock this write's
 * audit row also takes, and refuses a model that is not the selected one. A
 * model can only be selected when the chat price catalog gives it a pin the
 * ledger accepts (lib/marketingLlmModelCatalog.ts), and the cap stays within
 * the code's ceiling.
 */

export { MARKETING_LLM_SETTINGS_ACTION, MarketingLlmSettingsRefusedError };

export type MarketingLlmSettingsRead = {
  /** Null when the stored document is not one; a screen says so and refuses to save. */
  readonly settings: MarketingLlmSettings | null;
  /** The row's last change, the compare-and-set token; null while unset. */
  readonly version: string | null;
};

export async function readMarketingLlmSettings(
  client: Pick<PrismaClient, "appSetting">,
): Promise<MarketingLlmSettingsRead> {
  const row = await client.appSetting.findUnique({
    where: { key: MARKETING_LLM_SETTINGS_KEY },
    select: { value: true, updatedAt: true },
  });
  return { settings: parseMarketingLlmSettings(row?.value), version: row ? row.updatedAt.toISOString() : null };
}

/**
 * Replaces both settings under compare-and-set: the caller names the version
 * its screen read, and a moved version is refused rather than overwritten. A
 * save that changes nothing is refused too, so every audit row is a change.
 */
export async function writeMarketingLlmSettings(
  tx: MarketingTransaction,
  input: {
    readonly model: string | null;
    readonly monthlyUsdCap: string | null;
    readonly expectedVersion: string | null;
    readonly pins?: readonly MarketingLlmPricePin[];
  },
): Promise<MarketingLlmSettingsRead> {
  // The catalog through this transaction's own connection: no second
  // connection or registry seeding while the audit chain lock is held.
  const pins = input.pins ?? (await marketingLlmCatalogPinsIn(tx));
  if (input.model !== null && !pins.some((pin) => pin.model === input.model)) {
    throw new MarketingLlmSettingsRefusedError("model_not_pinned", "That model cannot be priced within the ledger's limits");
  }
  if (input.monthlyUsdCap !== null && parseMarketingLlmMonthlyCap(input.monthlyUsdCap) === null) {
    throw new MarketingLlmSettingsRefusedError(
      "cap_invalid",
      "The monthly cap must be above zero and at most US$100, with up to six decimal places",
    );
  }
  const next = marketingLlmSettingsValue({ model: input.model, monthlyUsdCap: input.monthlyUsdCap });

  const row = await tx.appSetting.findUnique({
    where: { key: MARKETING_LLM_SETTINGS_KEY },
    select: { value: true, updatedAt: true },
  });
  const version = row ? row.updatedAt.toISOString() : null;
  if (version !== input.expectedVersion) {
    throw new MarketingLlmSettingsRefusedError("settings_conflict", "The settings changed since the screen read them");
  }
  if (row && row.value === next) {
    throw new MarketingLlmSettingsRefusedError("settings_change_is_noop", "The settings already have these values");
  }

  if (!row) {
    // No row yet, so the unique key is the condition: a second writer racing
    // to create it fails on the constraint instead of overwriting.
    await tx.appSetting.create({ data: { key: MARKETING_LLM_SETTINGS_KEY, value: next } });
  } else {
    const moved = await tx.appSetting.updateMany({
      where: { key: MARKETING_LLM_SETTINGS_KEY, updatedAt: row.updatedAt },
      data: { value: next },
    });
    if (moved.count !== 1) {
      throw new MarketingLlmSettingsRefusedError("settings_conflict", "The settings changed since the screen read them");
    }
  }
  return readMarketingLlmSettings(tx);
}
