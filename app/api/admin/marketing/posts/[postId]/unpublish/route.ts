export const dynamic = "force-dynamic";

import { z } from "zod";
import { runMarketingAdminMutation } from "@/lib/marketingAdminMutations";
import {
  MARKETING_S2B1_ACTIONS,
  unpublishMarketingPost,
} from "@/lib/marketingStore";

type RouteContext = { params: Promise<{ postId: string }> };

const schema = z
  .object({
    expectedStatus: z.enum(["published", "verified"]),
    expectedHistoryVersion: z.number().int().nonnegative(),
    expectedExternalPostId: z.string().trim().min(1).max(200),
    /** What the person looked at to say the post is gone. */
    evidenceRef: z.string().trim().min(1).max(500),
    /**
     * Both are stated by the operator and both must be true.
     *
     * The adapter that could answer the first arrives in S2d2, and nothing
     * here can confirm the second, so the route does not pretend to know
     * either: a person says the channel supports taking a post down and that
     * they have seen it gone, and the record says they said it. The store
     * refuses anything else, so the literal `true` is a statement rather than
     * a formality.
     */
    cancellationSupported: z.literal(true),
    removalConfirmed: z.literal(true),
  })
  .strict();

/**
 * POST: a person takes a published post down
 * (docs/policy/marketing-automation.md §8, design C10).
 *
 * A narrowing, so no switch refuses it -- removing something already public is
 * damage control, and the console says as much: S0's C10 recorded that on some
 * channels this cannot be done through the API at all, and on those the
 * operator does it by hand and records that here.
 */
export async function POST(req: Request, context: RouteContext) {
  const { postId } = await context.params;
  return runMarketingAdminMutation({
    request: req,
    action: MARKETING_S2B1_ACTIONS.postUnpublish,
    targetType: "MarketingPost",
    targetId: postId,
    summary: "Took a published marketing post down.",
    gate: "operator_restriction",
    bucket: "admin-marketing-post-unpublish",
    schema,
    metadata: (body) => ({
      evidenceRef: body.evidenceRef,
      expectedStatus: body.expectedStatus,
      historyVersion: body.expectedHistoryVersion,
    }),
    run: async (tx, { body, auditLogId }) => {
      await unpublishMarketingPost(tx, {
        id: postId,
        expectedStatus: body.expectedStatus,
        expectedHistoryVersion: body.expectedHistoryVersion,
        expectedExternalPostId: body.expectedExternalPostId,
        evidenceRef: body.evidenceRef,
        cancellationSupported: body.cancellationSupported,
        removalConfirmed: body.removalConfirmed,
        auditLogId,
      });
      return { id: postId };
    },
  });
}
