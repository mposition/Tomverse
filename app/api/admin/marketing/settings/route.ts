export const dynamic = "force-dynamic";

import { z } from "zod";
import {
  MARKETING_CONSOLE_SWITCH_NAMES,
  writeMarketingAutomationSwitch,
} from "@/lib/appSettings";
import { runMarketingAdminMutation } from "@/lib/marketingAdminMutations";
import { MARKETING_S2B1_ACTIONS } from "@/lib/marketingStore";

const schema = z
  .object({
    switch: z.enum(MARKETING_CONSOLE_SWITCH_NAMES),
    enabled: z.boolean(),
  })
  .strict();

const ACTION = {
  drafts: MARKETING_S2B1_ACTIONS.settingDraftsChanged,
  publish: MARKETING_S2B1_ACTIONS.settingPublishChanged,
  autonomous: MARKETING_S2B1_ACTIONS.settingAutonomousChanged,
} as const;

/**
 * PATCH: an operator turns one of the three marketing switches on or off
 * (docs/policy/marketing-automation.md §6.1).
 *
 * Gated as an account control rather than as manual approval. A switch route
 * that refused while its own switch was off would be a switch that can be
 * turned on and never off, and letting the draft switch gate a change to the
 * publish switch would put one capability in charge of another.
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
    gate: "account_control",
    bucket: "admin-marketing-switch",
    schema,
    metadata: (body) => ({ switch: body.switch, enabled: body.enabled }),
    run: async (tx, { body }) => {
      await writeMarketingAutomationSwitch(tx, body.switch, body.enabled);
      return { switch: body.switch, enabled: body.enabled };
    },
  });
}
