export const dynamic = "force-dynamic";

import { z } from "zod";
import { runMarketingAdminMutation } from "@/lib/marketingAdminMutations";
import {
  MARKETING_S2B1_ACTIONS,
  scheduleMarketingPost,
} from "@/lib/marketingStore";

type RouteContext = { params: Promise<{ postId: string }> };

const schema = z
  .object({
    expectedEnvelopeDigest: z.string().regex(/^[0-9a-f]{64}$/),
    expectedHistoryVersion: z.number().int().nonnegative(),
    scheduledAt: z.coerce.date(),
  })
  .strict();

/**
 * POST: a person gives an approved post its slot.
 *
 * Approval and scheduling are separate decisions: approving says the words are
 * right, scheduling says when they go, and a post can sit approved without one.
 */
export async function POST(req: Request, context: RouteContext) {
  const { postId } = await context.params;
  return runMarketingAdminMutation({
    request: req,
    action: MARKETING_S2B1_ACTIONS.postSchedule,
    targetType: "MarketingPost",
    targetId: postId,
    summary: "Scheduled an approved marketing post.",
    gate: "manual_approval",
    bucket: "admin-marketing-post-schedule",
    schema,
    metadata: (body) => ({ digest: body.expectedEnvelopeDigest }),
    run: async (tx, { body, auditLogId }) => {
      await scheduleMarketingPost(tx, {
        id: postId,
        expectedEnvelopeDigest: body.expectedEnvelopeDigest,
        expectedHistoryVersion: body.expectedHistoryVersion,
        scheduledAt: body.scheduledAt,
        auditLogId,
      });
      return { id: postId };
    },
  });
}
