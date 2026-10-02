export const dynamic = "force-dynamic";

import { z } from "zod";

import { MARKETING_WEBHOOK_SHADOW_KEY } from "@/lib/marketingAutomationAccess";
import { runMarketingAdminMutation } from "@/lib/marketingAdminMutations";
import { MARKETING_S2E_ACTIONS } from "@/lib/marketingStore";
import { MarketingWebhookSettingRefusedError } from "@/lib/marketingWebhookCore";
import { writeMarketingWebhookShadowSwitch } from "@/lib/marketingWebhookSettings";

const schema = z
  .object({
    enabled: z.boolean(),
    /** What the screen read, so a change made meanwhile is refused, not overwritten. */
    expectedEnabled: z.boolean(),
  })
  .strict();

const REFUSAL_STATUS: Record<string, number> = {
  environment_not_staging: 409,
  shadow_switch_conflict: 409,
  shadow_switch_noop: 409,
  shadow_switch_unreadable: 500,
};

/**
 * PATCH: an operator turns the staging webhook shadow on or off
 * (docs/policy/marketing-automation.md; S2e `marketing_webhook.shadow_changed`).
 *
 * Staging exactly: production and an unknown environment refuse, before
 * anything is read. Turning it off narrows what happens and is never gated;
 * turning it on starts a recording surface and is stopped by the kill switch.
 */
export async function PATCH(req: Request) {
  return runMarketingAdminMutation({
    request: req,
    action: MARKETING_S2E_ACTIONS.shadowChanged,
    targetType: "AppSetting",
    targetId: MARKETING_WEBHOOK_SHADOW_KEY,
    summary: (body) =>
      body.enabled ? "Turned the staging webhook shadow on." : "Turned the staging webhook shadow off.",
    gate: (body) => (body.enabled ? "account_control" : "operator_restriction"),
    bucket: "admin-marketing-webhook-shadow",
    schema,
    metadata: (body) => ({ enabled: body.enabled, expectedEnabled: body.expectedEnabled }),
    refusal: (error) =>
      error instanceof MarketingWebhookSettingRefusedError
        ? { code: error.code, status: REFUSAL_STATUS[error.code] ?? 409, message: error.message }
        : null,
    run: async (tx, { body }) =>
      writeMarketingWebhookShadowSwitch(tx, {
        enabled: body.enabled,
        expectedEnabled: body.expectedEnabled,
      }),
  });
}
