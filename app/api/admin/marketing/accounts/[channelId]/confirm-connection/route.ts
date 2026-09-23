export const dynamic = "force-dynamic";

import { z } from "zod";
import {
  MARKETING_S2B1_ACTIONS,
  confirmMarketingChannelConnection,
} from "@/lib/marketingStore";
import { runMarketingAdminMutation } from "@/lib/marketingAdminMutations";

type RouteContext = { params: Promise<{ channelId: string }> };

const schema = z
  .object({ expectedConnectionGeneration: z.number().int().positive() })
  .strict();

/**
 * POST: the operator confirms the adapter is connected for this account.
 *
 * `connect_pending` to `approval_mode`, which the transition trigger permits
 * and nothing else does. The generation the console displayed is sent back and
 * pinned, so a reconnection in between is a refusal rather than a confirmation
 * of a connection nobody looked at.
 */
export async function POST(req: Request, context: RouteContext) {
  const { channelId } = await context.params;
  return runMarketingAdminMutation({
    request: req,
    action: MARKETING_S2B1_ACTIONS.accountConnectionConfirmed,
    targetType: "MarketingChannel",
    targetId: channelId,
    summary: "Confirmed a brand account's adapter connection.",
    gate: "account_control",
    bucket: "admin-marketing-account-confirm",
    schema,
    metadata: (body) => ({ expectedConnectionGeneration: body.expectedConnectionGeneration }),
    run: async (tx, { body }) => {
      await confirmMarketingChannelConnection(tx, {
        id: channelId,
        expectedConnectionGeneration: body.expectedConnectionGeneration,
      });
      return { id: channelId };
    },
  });
}
