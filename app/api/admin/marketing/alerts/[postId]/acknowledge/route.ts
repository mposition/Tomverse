export const dynamic = "force-dynamic";

import { z } from "zod";
import { runMarketingAdminMutation } from "@/lib/marketingAdminMutations";
import { MARKETING_COMMENT_ALERT_ACK_ACTION, requireOpenMarketingCommentAlert } from "@/lib/marketingStore";

type RouteContext = { params: Promise<{ postId: string }> };

const schema = z.object({}).strict();

/**
 * POST: the operator marks a comment alert as handled (policy 12.1, 8.3).
 *
 * The operator's entry in the audit chain *is* the answer: an alert is open
 * until an acknowledgement for its post is newer than it. Gated on nothing,
 * like a pause -- answering an alert is how an operator keeps an account from
 * being stopped for it, and it starts nothing. An acknowledgement of a post with
 * no open alert is refused and its entry is rolled back with it.
 */
export async function POST(req: Request, context: RouteContext) {
  const { postId } = await context.params;
  return runMarketingAdminMutation({
    request: req,
    action: MARKETING_COMMENT_ALERT_ACK_ACTION,
    targetType: "MarketingPost",
    targetId: postId,
    summary: "Marked a comment alert as handled.",
    gate: "operator_restriction",
    bucket: "admin-marketing-comment-alert-ack",
    schema,
    metadata: () => ({}),
    run: async (tx, { auditLogId }) => {
      await requireOpenMarketingCommentAlert(tx, postId, auditLogId);
      return { id: postId };
    },
  });
}
