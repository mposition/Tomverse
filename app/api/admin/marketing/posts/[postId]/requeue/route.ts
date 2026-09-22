export const dynamic = "force-dynamic";

import { z } from "zod";
import { runMarketingAdminMutation } from "@/lib/marketingAdminMutations";
import {
  MARKETING_S2B1_ACTIONS,
  requeueMarketingPostAfterFailure,
} from "@/lib/marketingStore";

type RouteContext = { params: Promise<{ postId: string }> };

const schema = z
  .object({
    expectedEnvelopeDigest: z.string().regex(/^[0-9a-f]{64}$/),
    expectedHistoryVersion: z.number().int().nonnegative(),
  })
  .strict();

/**
 * POST: a person re-queues a post whose publish failed.
 *
 * There is no automatic retry (policy §2). The store requires a *new* approval
 * entry dated after the failure it answers, and refuses one that reuses the
 * approval the failed attempt already had -- so a re-queue is a fresh decision
 * about a post somebody looked at, not a button that tries again.
 */
export async function POST(req: Request, context: RouteContext) {
  const { postId } = await context.params;
  return runMarketingAdminMutation({
    request: req,
    action: MARKETING_S2B1_ACTIONS.postRequeueAfterFailure,
    targetType: "MarketingPost",
    targetId: postId,
    summary: "Re-queued a failed marketing post.",
    gate: "manual_approval",
    bucket: "admin-marketing-post-requeue",
    schema,
    metadata: (body) => ({ digest: body.expectedEnvelopeDigest }),
    run: async (tx, { body, auditLogId }) => {
      await requeueMarketingPostAfterFailure(tx, {
        id: postId,
        expectedEnvelopeDigest: body.expectedEnvelopeDigest,
        expectedHistoryVersion: body.expectedHistoryVersion,
        auditLogId,
      });
      return { id: postId };
    },
  });
}
