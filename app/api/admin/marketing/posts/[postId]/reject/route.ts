export const dynamic = "force-dynamic";

import { z } from "zod";
import { runMarketingAdminMutation } from "@/lib/marketingAdminMutations";
import {
  MARKETING_S2B1_ACTIONS,
  rejectMarketingPost,
} from "@/lib/marketingStore";

type RouteContext = { params: Promise<{ postId: string }> };

const schema = z
  .object({
    expectedEnvelopeDigest: z.string().regex(/^[0-9a-f]{64}$/),
    expectedHistoryVersion: z.number().int().nonnegative(),
  })
  .strict();

/**
 * POST: a person rejects a draft.
 *
 * Bound to the same digest and history version as an approval would be: a
 * rejection of words that have since changed is a rejection of something else.
 */
export async function POST(req: Request, context: RouteContext) {
  const { postId } = await context.params;
  return runMarketingAdminMutation({
    request: req,
    action: MARKETING_S2B1_ACTIONS.postReject,
    targetType: "MarketingPost",
    targetId: postId,
    summary: "Rejected a marketing draft.",
    gate: "manual_approval",
    bucket: "admin-marketing-post-reject",
    schema,
    metadata: (body) => ({ digest: body.expectedEnvelopeDigest }),
    run: async (tx, { body, auditLogId }) => {
      await rejectMarketingPost(tx, {
        id: postId,
        expectedEnvelopeDigest: body.expectedEnvelopeDigest,
        expectedHistoryVersion: body.expectedHistoryVersion,
        auditLogId,
      });
      return { id: postId };
    },
  });
}
