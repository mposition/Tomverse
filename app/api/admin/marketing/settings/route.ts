export const dynamic = "force-dynamic";

import { z } from "zod";
import {
  MARKETING_CONSOLE_SWITCH_NAMES,
  MarketingSwitchRefusedError,
  writeMarketingAutomationSwitch,
} from "@/lib/appSettings";
import { runMarketingAdminMutation } from "@/lib/marketingAdminMutations";
import { MARKETING_S2B1_ACTIONS } from "@/lib/marketingStore";

const schema = z
  .object({
    switch: z.enum(MARKETING_CONSOLE_SWITCH_NAMES),
    enabled: z.boolean(),
    /**
     * What the screen believed the switch was.
     *
     * Compare-and-set rather than last-writer-wins: two consoles open on this
     * page would otherwise have the later save silently undo the earlier one,
     * with both audit entries reading "changed".
     */
    expectedEnabled: z.boolean(),
  })
  .strict();

const ACTION = {
  drafts: MARKETING_S2B1_ACTIONS.settingDraftsChanged,
  publish: MARKETING_S2B1_ACTIONS.settingPublishChanged,
  autonomous: MARKETING_S2B1_ACTIONS.settingAutonomousChanged,
} as const;

const REFUSAL_STATUS: Record<string, number> = {
  switch_conflict: 409,
  switch_change_is_noop: 409,
  publisher_capability_unavailable: 409,
  autonomous_needs_drafts_and_publish: 409,
  config_generation_unreadable: 500,
};

/**
 * PATCH: an operator turns one of the three marketing switches on or off
 * (docs/policy/marketing-automation.md §6.1).
 *
 * Turning one *off* is an operator narrowing what can happen, so the kill
 * switch does not refuse it -- a switch that can be turned on and never off is
 * not a control. Turning one *on* starts a publishing surface, so it is gated
 * like the rest of them.
 *
 * Each switch has its own audit action, so the record says which capability
 * changed rather than that settings were touched. The webhook shadow switch
 * and the apply scope are not here: they carry evidence this slice cannot
 * check, and a writer for them would be a way to skip it.
 */
export async function PATCH(req: Request) {
  return runMarketingAdminMutation({
    request: req,
    action: (body) => ACTION[body.switch],
    targetType: "AppSetting",
    targetId: (body) => body.switch,
    summary: "Changed a marketing automation switch.",
    gate: (body) => (body.enabled ? "account_control" : "operator_restriction"),
    bucket: "admin-marketing-switch",
    schema,
    metadata: (body) => ({ switch: body.switch, enabled: body.enabled }),
    refusal: (error) =>
      error instanceof MarketingSwitchRefusedError
        ? {
            code: error.code,
            status: REFUSAL_STATUS[error.code] ?? 409,
            message: error.message,
          }
        : null,
    run: async (tx, { body }) => {
      const { configGeneration } = await writeMarketingAutomationSwitch(tx, {
        name: body.switch,
        enabled: body.enabled,
        expectedEnabled: body.expectedEnabled,
      });
      return { switch: body.switch, enabled: body.enabled, configGeneration };
    },
  });
}
