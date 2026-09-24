export const dynamic = "force-dynamic";

import { z } from "zod";
import {
  MARKETING_S2B1_ACTIONS,
  reconnectMarketingChannel,
} from "@/lib/marketingStore";
import { runMarketingAdminMutation } from "@/lib/marketingAdminMutations";

type RouteContext = { params: Promise<{ channelId: string }> };

const schema = z
  .object({ expectedConnectionGeneration: z.number().int().positive() })
  .strict();

/**
 * POST: the operator reconnects a disconnected brand account.
 *
 * It comes back in `approval_mode` with the connection generation moved by
 * exactly one, never straight into autonomy: a reconnection is a new set of
 * scopes until somebody graduates it again (policy section 8.2).
 */
export async function POST(req: Request, context: RouteContext) {
  const { channelId } = await context.params;
  return runMarketingAdminMutation({
    request: req,
    action: MARKETING_S2B1_ACTIONS.accountReconnect,
    targetType: "MarketingChannel",
    targetId: channelId,
    summary: "Reconnected a brand account.",
    gate: "account_control",
    bucket: "admin-marketing-account-reconnect",
    schema,
    metadata: (body) => ({ expectedConnectionGeneration: body.expectedConnectionGeneration }),
    run: async (tx, { body }) => {
      await reconnectMarketingChannel(tx, {
        id: channelId,
        expectedConnectionGeneration: body.expectedConnectionGeneration,
      });
      return { id: channelId };
    },
  });
}
