export const dynamic = "force-dynamic";

import { z } from "zod";
import { runMarketingAdminMutation } from "@/lib/marketingAdminMutations";
import {
  MARKETING_S2B1_ACTIONS,
  releaseMarketingPostLegalHold,
  setMarketingPostLegalHold,
} from "@/lib/marketingStore";

type RouteContext = { params: Promise<{ postId: string }> };

const schema = z
  .object({
    hold: z.boolean(),
    expectedHistoryVersion: z.number().int().nonnegative(),
  })
  .strict();

/**
 * POST: a person puts a post under legal hold, or takes it off
 * (docs/policy/marketing-automation.md §12.2, design F10).
 *
 * Two audit actions, because they are opposite decisions. Setting a hold stops
 * retention from touching the post, so it is a narrowing and no switch refuses
 * it. Releasing one lets the content be purged on schedule, which is not
 * something to do while the kill switch is on.
 *
 * The hold is on the post, not the account: the retention trigger reads
 * `MarketingPost.legalHold`, and the design's phrase about report-level holds
 * is superseded by the policy and the S1 schema, which give the column to
 * posts alone.
 */
export async function POST(req: Request, context: RouteContext) {
  const { postId } = await context.params;
  return runMarketingAdminMutation({
    request: req,
    action: (body) =>
      body.hold
        ? MARKETING_S2B1_ACTIONS.postLegalHoldSet
        : MARKETING_S2B1_ACTIONS.postLegalHoldReleased,
    targetType: "MarketingPost",
    targetId: postId,
    summary: (body) =>
      body.hold
        ? "Placed a marketing post under legal hold."
        : "Released a marketing post from legal hold.",
    gate: (body) => (body.hold ? "operator_restriction" : "account_control"),
    bucket: "admin-marketing-post-legal-hold",
    schema,
    metadata: (body) => ({ historyVersion: body.expectedHistoryVersion }),
    run: async (tx, { body, auditLogId }) => {
      const input = {
        id: postId,
        expectedHistoryVersion: body.expectedHistoryVersion,
        auditLogId,
      };
      if (body.hold) await setMarketingPostLegalHold(tx, input);
      else await releaseMarketingPostLegalHold(tx, input);
      return { id: postId, hold: body.hold };
    },
  });
}
