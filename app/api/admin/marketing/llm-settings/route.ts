export const dynamic = "force-dynamic";

import { z } from "zod";
import { MARKETING_LLM_SETTINGS_KEY } from "@/lib/marketingLlmBudgetCore";
import { MARKETING_LLM_SETTINGS_ACTION, MarketingLlmSettingsRefusedError } from "@/lib/marketingLlmSettingsCore";
import { writeMarketingLlmSettings } from "@/lib/marketingLlmSettingsStore";
import { runMarketingAdminMutation } from "@/lib/marketingAdminMutations";

const schema = z
  .object({
    model: z.string().min(1).max(128).nullable(),
    monthlyUsdCap: z.string().min(1).max(16).nullable(),
    /** The version the screen read; null when nothing was saved yet. */
    expectedVersion: z.string().max(64).nullable(),
  })
  .strict();

const REFUSAL_STATUS: Record<string, number> = {
  model_not_pinned: 422,
  cap_invalid: 422,
  settings_conflict: 409,
  settings_change_is_noop: 409,
};

/**
 * PATCH: the operator selects the marketing generator's model and its monthly
 * LLM cap (operator decision 2026-10-19: managed in the Admin Console rather
 * than in Railway variables).
 *
 * Gated like any control that can start spending: the kill switch refuses it.
 * The kill switch already stops every reservation, so lowering the cap during
 * one is never needed to stop spend.
 */
export async function PATCH(req: Request) {
  return runMarketingAdminMutation({
    request: req,
    action: MARKETING_LLM_SETTINGS_ACTION,
    targetType: "AppSetting",
    targetId: MARKETING_LLM_SETTINGS_KEY,
    summary: "Changed the marketing generator's model and monthly LLM cap.",
    gate: "account_control",
    bucket: "admin-marketing-llm-settings",
    schema,
    metadata: (body) => ({ model: body.model, monthlyUsdCap: body.monthlyUsdCap }),
    refusal: (error) =>
      error instanceof MarketingLlmSettingsRefusedError
        ? { code: error.code, status: REFUSAL_STATUS[error.code] ?? 409, message: error.message }
        : null,
    run: async (tx, { body }) => {
      const saved = await writeMarketingLlmSettings(tx, {
        model: body.model,
        monthlyUsdCap: body.monthlyUsdCap,
        expectedVersion: body.expectedVersion,
      });
      return { settings: saved.settings, version: saved.version };
    },
  });
}
