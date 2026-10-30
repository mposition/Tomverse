import type { PrismaClient } from "@prisma/client";

import { MARKETING_LLM_SETTINGS_KEY } from "@/lib/marketingLlmBudgetCore";

/**
 * The operator's marketing LLM settings (model and monthly cap) as the Admin
 * Console's writer stores them, for suites that reserve through the ledger.
 */
export const setMarketingLlmSettings = (
  prisma: Pick<PrismaClient, "appSetting">,
  model: string | null,
  monthlyUsdCap: string | null,
) => {
  const value = JSON.stringify({ model, monthlyUsdCap });
  return prisma.appSetting.upsert({
    where: { key: MARKETING_LLM_SETTINGS_KEY },
    update: { value },
    create: { key: MARKETING_LLM_SETTINGS_KEY, value },
  });
};

export const clearMarketingLlmSettings = (prisma: Pick<PrismaClient, "appSetting">) =>
  prisma.appSetting.deleteMany({ where: { key: MARKETING_LLM_SETTINGS_KEY } });
