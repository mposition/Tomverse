export const dynamic = "force-dynamic";

import { z } from "zod";

import { runMarketingAdminMutation } from "@/lib/marketingAdminMutations";
import {
  MARKETING_ANALYSIS_ENABLED_KEY,
  MARKETING_ANALYSIS_SETTINGS_ACTION,
  MarketingAnalysisSettingsRefusedError,
} from "@/lib/marketingAnalysisCore";
import { writeMarketingAnalysisSetting } from "@/lib/marketingAnalysisStore";

/**
 * The marketing analysis and brief switch (operator decision 2026-11-01):
 * whether the generator may spend two more LLM calls a run, under the existing
 * `brief` purpose and the same monthly cap, to analyse Tomverse against the
 * tracked competitors and choose the week's brief. Default off.
 *
 * PATCH is a marketing mutation: `marketing:write`, a recent sign-in, an audit
 * row in the same transaction; the screen reads the switch from `./state`.
 * Turning it on starts spending and the kill switch refuses it; turning it off
 * is a stop and nothing refuses it.
 */

const schema = z
  .object({
    enabled: z.boolean(),
    /** The version the screen read; null when nothing was saved yet. */
    expectedVersion: z.string().max(64).nullable(),
  })
  .strict();

export async function PATCH(req: Request) {
  return runMarketingAdminMutation({
    request: req,
    action: MARKETING_ANALYSIS_SETTINGS_ACTION,
    targetType: "AppSetting",
    targetId: MARKETING_ANALYSIS_ENABLED_KEY,
    summary: (body) =>
      body.enabled
        ? "Turned on the marketing analysis and brief."
        : "Turned off the marketing analysis and brief.",
    gate: (body) => (body.enabled ? "account_control" : "operator_restriction"),
    bucket: "admin-marketing-analysis-settings",
    schema,
    metadata: (body) => ({ enabled: body.enabled }),
    refusal: (error) =>
      error instanceof MarketingAnalysisSettingsRefusedError
        ? { code: error.code, status: 409, message: error.message }
        : null,
    run: async (tx, { body }) =>
      writeMarketingAnalysisSetting(tx, { enabled: body.enabled, expectedVersion: body.expectedVersion }),
  });
}
