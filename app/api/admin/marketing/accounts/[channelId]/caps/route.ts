export const dynamic = "force-dynamic";

import { z } from "zod";
import {
  MARKETING_S2B1_ACTIONS,
  changeMarketingChannelCaps,
} from "@/lib/marketingStore";
import { runMarketingAdminMutation } from "@/lib/marketingAdminMutations";
import { MARKETING_AUTOMATION_KILL_SWITCH_ENV } from "@/lib/marketingAutomationAccess";

type RouteContext = { params: Promise<{ channelId: string }> };

const schema = z
  .object({
    dailyCapOverride: z.number().int().nonnegative().nullable(),
    weeklyCapOverride: z.number().int().nonnegative().nullable(),
  })
  .strict();

/**
 * POST: the operator sets or clears a brand account's own posting caps.
 *
 * The policy has no cap (owner decision 2026-11-08), so these are the only
 * ones; null is no cap. Lowering is never gated, as with every operator
 * restriction. Raising or clearing one lets more posts out, so the store
 * refuses it while the kill switch is on (policy section 6.1).
 *
 * The audit action is still `marketing_account.lower_caps`: the name predates
 * raising and clearing, and keeping it puts every cap change, old and new,
 * under one action in the audit chain. (It also sits in the table the signed
 * webhook pipeline fingerprint reads, which a rename would make stale.)
 */
export async function POST(req: Request, context: RouteContext) {
  const { channelId } = await context.params;
  return runMarketingAdminMutation({
    request: req,
    action: MARKETING_S2B1_ACTIONS.accountLowerCaps,
    targetType: "MarketingChannel",
    targetId: channelId,
    summary: "Changed a brand account's posting caps.",
    gate: "operator_restriction",
    bucket: "admin-marketing-account-caps",
    schema,
    metadata: (body) => ({
      dailyCapOverride: body.dailyCapOverride,
      weeklyCapOverride: body.weeklyCapOverride,
    }),
    run: async (tx, { body }) => {
      const killSwitch = process.env[MARKETING_AUTOMATION_KILL_SWITCH_ENV];
      await changeMarketingChannelCaps(
        tx,
        {
          id: channelId,
          dailyCapOverride: body.dailyCapOverride,
          weeklyCapOverride: body.weeklyCapOverride,
        },
        { raiseAllowed: !(typeof killSwitch === "string" && killSwitch.trim() !== "") },
      );
      return { id: channelId };
    },
  });
}
