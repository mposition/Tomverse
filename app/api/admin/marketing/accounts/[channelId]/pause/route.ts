export const dynamic = "force-dynamic";

import { z } from "zod";
import { MARKETING_PAUSABLE_MODES } from "@/lib/marketingAutomationSchema";
import {
  MARKETING_PAUSE_REASON_CODES,
  MARKETING_S2B1_ACTIONS,
  pauseMarketingChannel,
} from "@/lib/marketingStore";
import { runMarketingAdminMutation } from "@/lib/marketingAdminMutations";

type RouteContext = { params: Promise<{ channelId: string }> };

const schema = z
  .object({
    expectedStatus: z.enum(MARKETING_PAUSABLE_MODES),
    reasonCode: z.enum(MARKETING_PAUSE_REASON_CODES),
  })
  .strict();

/**
 * POST: the operator stops a brand account.
 *
 * Gated on nothing. This is the control an operator reaches for when something
 * is going wrong, and a stop a feature switch can refuse is not a stop. The
 * mode it was paused from is recorded, because that is what a resume into
 * autonomous mode has to match.
 */
export async function POST(req: Request, context: RouteContext) {
  const { channelId } = await context.params;
  return runMarketingAdminMutation({
    request: req,
    action: MARKETING_S2B1_ACTIONS.accountPause,
    targetType: "MarketingChannel",
    targetId: channelId,
    summary: "Paused a brand account.",
    gate: "operator_restriction",
    bucket: "admin-marketing-account-pause",
    schema,
    metadata: (body) => ({ reasonCode: body.reasonCode, pausedFromMode: body.expectedStatus }),
    run: async (tx, { body }) => {
      await pauseMarketingChannel(tx, {
        id: channelId,
        expectedStatus: body.expectedStatus,
        reasonCode: body.reasonCode,
      });
      return { id: channelId };
    },
  });
}
