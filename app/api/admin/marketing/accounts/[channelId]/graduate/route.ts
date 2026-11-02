export const dynamic = "force-dynamic";

import { z } from "zod";
import { readMarketingCommentsMonitorHealthy } from "@/lib/marketingCommentsMonitorHealth";
import { runMarketingAdminMutation } from "@/lib/marketingAdminMutations";
import { MARKETING_GRADUATE_ACTION, graduateMarketingChannel } from "@/lib/marketingStore";

type RouteContext = { params: Promise<{ channelId: string }> };

/** Thrown to roll the confirmation back with the refusal, so an unmet graduation leaves no entry saying it happened. */
class GraduationUnmet extends Error {
  constructor(readonly unmet: readonly string[]) {
    super(`The account does not meet the graduation conditions: ${unmet.join(", ")}`);
  }
}

const schema = z.object({ expectedGraduationEpoch: z.number().int().min(0) }).strict();

/**
 * POST: the operator graduates a brand account to autonomous publishing
 * (docs/policy/marketing-automation.md O3 and section 8.2).
 *
 * This request is the "operator confirms once" of O3; the permission and the
 * recent sign-in are the wrapper's. The server decides whether the other
 * conditions hold -- the page's own reading of them is a courtesy -- and the
 * store refuses with every unmet condition named. The autonomous publishing
 * switch is not touched: it stays off until the operator turns it on.
 */
export async function POST(req: Request, context: RouteContext) {
  const { channelId } = await context.params;
  return runMarketingAdminMutation({
    request: req,
    action: MARKETING_GRADUATE_ACTION,
    targetType: "MarketingChannel",
    targetId: channelId,
    summary: "Graduated a brand account to autonomous publishing.",
    gate: "account_control",
    bucket: "admin-marketing-account-graduate",
    schema,
    metadata: (body) => ({ graduationEpoch: body.expectedGraduationEpoch }),
    run: async (tx, { body, auditLogId }) => {
      const commentsMonitorHealthy = await readMarketingCommentsMonitorHealthy();
      const result = await graduateMarketingChannel(tx, {
        id: channelId,
        auditLogId,
        expectedGraduationEpoch: body.expectedGraduationEpoch,
        commentsMonitorHealthy,
      });
      if (!result.graduated) throw new GraduationUnmet(result.unmet);
      return { id: channelId, graduationEpoch: result.snapshot.graduationEpoch };
    },
    refusal: (error) =>
      error instanceof GraduationUnmet
        ? { code: "MARKETING_GRADUATION_UNMET", status: 409, message: error.message }
        : null,
  });
}
