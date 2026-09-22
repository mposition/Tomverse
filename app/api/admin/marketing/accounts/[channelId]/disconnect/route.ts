export const dynamic = "force-dynamic";

import { z } from "zod";
import { MARKETING_CHANNEL_STATUSES } from "@/lib/marketingAutomationSchema";
import {
  MARKETING_S2B1_ACTIONS,
  disconnectMarketingChannel,
} from "@/lib/marketingStore";
import { runMarketingAdminMutation } from "@/lib/marketingAdminMutations";

type RouteContext = { params: Promise<{ channelId: string }> };

const schema = z
  .object({
    expectedStatus: z.enum(MARKETING_CHANNEL_STATUSES),
    expectedConnectionGeneration: z.number().int().positive(),
  })
  .strict();

/**
 * POST: the operator disconnects a brand account.
 *
 * Reachable from every connected state, and the trigger clears the pause,
 * graduation and approval-start fields with it -- a disconnected account is not
 * a paused one that might resume on its own.
 */
export async function POST(req: Request, context: RouteContext) {
  const { channelId } = await context.params;
  return runMarketingAdminMutation({
    request: req,
    action: MARKETING_S2B1_ACTIONS.accountDisconnect,
    targetType: "MarketingChannel",
    targetId: channelId,
    summary: "Disconnected a brand account.",
    gate: "operator_restriction",
    bucket: "admin-marketing-account-disconnect",
    schema,
    metadata: (body) => ({ expectedStatus: body.expectedStatus }),
    run: async (tx, { body }) => {
      await disconnectMarketingChannel(tx, {
        id: channelId,
        expectedStatus: body.expectedStatus,
        expectedConnectionGeneration: body.expectedConnectionGeneration,
      });
      return { id: channelId };
    },
  });
}
