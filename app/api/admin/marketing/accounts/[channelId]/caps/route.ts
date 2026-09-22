export const dynamic = "force-dynamic";

import { z } from "zod";
import {
  MARKETING_S2B1_ACTIONS,
  lowerMarketingChannelCaps,
} from "@/lib/marketingStore";
import { runMarketingAdminMutation } from "@/lib/marketingAdminMutations";

type RouteContext = { params: Promise<{ channelId: string }> };

const schema = z
  .object({
    dailyCapOverride: z.number().int().nonnegative().nullable(),
    weeklyCapOverride: z.number().int().nonnegative().nullable(),
  })
  .strict();

/**
 * POST: the operator lowers a brand account's posting caps.
 *
 * Lowering only, which is what the action is named. There is no route that
 * raises one -- the plan's inventory has none -- so raising a cap back is not
 * something this slice can do, and an operator should know that before they
 * lower one (policy section 7.4).
 */
export async function POST(req: Request, context: RouteContext) {
  const { channelId } = await context.params;
  return runMarketingAdminMutation({
    request: req,
    action: MARKETING_S2B1_ACTIONS.accountLowerCaps,
    targetType: "MarketingChannel",
    targetId: channelId,
    summary: "Lowered a brand account's posting caps.",
    gate: "account_control",
    bucket: "admin-marketing-account-caps",
    schema,
    metadata: (body) => ({
      dailyCapOverride: body.dailyCapOverride,
      weeklyCapOverride: body.weeklyCapOverride,
    }),
    run: async (tx, { body }) => {
      await lowerMarketingChannelCaps(tx, {
        id: channelId,
        dailyCapOverride: body.dailyCapOverride,
        weeklyCapOverride: body.weeklyCapOverride,
      });
      return { id: channelId };
    },
  });
}
