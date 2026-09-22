export const dynamic = "force-dynamic";

import { z } from "zod";
import { MARKETING_RESUME_REASON_CODES } from "@/lib/marketingAutomationSchema";
import { runMarketingAdminMutation } from "@/lib/marketingAdminMutations";
import {
  MARKETING_S2B1_ACTIONS,
  resumeMarketingChannelToApproval,
  resumeMarketingChannelToAutonomous,
} from "@/lib/marketingStore";

type RouteContext = { params: Promise<{ channelId: string }> };

const schema = z
  .discriminatedUnion("mode", [
    z.object({ mode: z.literal("approval") }).strict(),
    z
      .object({
        mode: z.literal("autonomous"),
        reasonCode: z.enum(MARKETING_RESUME_REASON_CODES),
      })
      .strict(),
  ]);

/**
 * POST: the operator resumes a paused brand account
 * (docs/policy/marketing-automation.md §8.2).
 *
 * Two actions, not one with a flag. Returning to approval mode is the default
 * and needs no reason; returning to autonomous mode is a decision, and the
 * store will not make it without a closed reason code and a chain-valid entry
 * naming this account, written after the pause it answers. They are different
 * audit actions because they are different decisions, and a record that called
 * both "resume" could not tell them apart afterwards.
 *
 * Resuming into approval mode also expires, in this same transaction and each
 * with its own system audit row, the posts whose approval window closed or
 * whose scheduled time passed while the account was stopped (policy 8.2).
 * Nothing goes out the moment an account comes back because its slot arrived
 * while it was off.
 */
export async function POST(req: Request, context: RouteContext) {
  const { channelId } = await context.params;
  return runMarketingAdminMutation({
    request: req,
    action: (body) =>
      body.mode === "autonomous"
        ? MARKETING_S2B1_ACTIONS.accountResumeAutonomous
        : MARKETING_S2B1_ACTIONS.accountResumeApproval,
    targetType: "MarketingChannel",
    targetId: channelId,
    summary: (body) =>
      body.mode === "autonomous"
        ? "Resumed a brand account into autonomous mode."
        : "Resumed a brand account into approval mode.",
    gate: "account_control",
    bucket: "admin-marketing-account-resume",
    schema,
    metadata: (body) =>
      body.mode === "autonomous"
        ? { reasonCode: body.reasonCode, mode: body.mode }
        : { mode: body.mode },
    run: async (tx, { body, auditLogId }) => {
      if (body.mode === "autonomous") {
        await resumeMarketingChannelToAutonomous(tx, {
          id: channelId,
          auditLogId,
          reasonCode: body.reasonCode,
        });
        return { id: channelId, mode: body.mode, expiredPostIds: [] as string[] };
      }
      const { expiredPostIds } = await resumeMarketingChannelToApproval(tx, {
        id: channelId,
      });
      return { id: channelId, mode: body.mode, expiredPostIds };
    },
  });
}
