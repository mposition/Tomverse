export const dynamic = "force-dynamic";

import { z } from "zod";
import { runMarketingAdminMutation } from "@/lib/marketingAdminMutations";
import {
  MARKETING_S2B1_ACTIONS,
  approveMarketingPost,
} from "@/lib/marketingStore";

type RouteContext = { params: Promise<{ postId: string }> };

const schema = z
  .object({
    expectedEnvelopeDigest: z.string().regex(/^[0-9a-f]{64}$/),
    expectedHistoryVersion: z.number().int().nonnegative(),
    approvalExpiresAt: z.coerce.date(),
  })
  .strict();

/**
 * POST: a person approves a draft (docs/policy/marketing-automation.md §6, F1).
 *
 * The digest the console displayed is sent back and pinned: an approval is
 * about the words the approver read, so a draft edited in between is a refusal
 * rather than an approval of something nobody saw.
 *
 * The expiry is the caller's, and the store refuses one that is not after the
 * moment the audit entry records -- an approval that expired before it was
 * made is not an approval.
 */
export async function POST(req: Request, context: RouteContext) {
  const { postId } = await context.params;
  return runMarketingAdminMutation({
    request: req,
    action: MARKETING_S2B1_ACTIONS.postApprove,
    targetType: "MarketingPost",
    targetId: postId,
    summary: "Approved a marketing draft.",
    gate: "manual_approval",
    bucket: "admin-marketing-post-approve",
    schema,
    metadata: (body) => ({ digest: body.expectedEnvelopeDigest }),
    run: async (tx, { body, auditLogId }) => {
      await approveMarketingPost(tx, {
        id: postId,
        expectedEnvelopeDigest: body.expectedEnvelopeDigest,
        expectedHistoryVersion: body.expectedHistoryVersion,
        approvalAuditLogId: auditLogId,
        approvalExpiresAt: body.approvalExpiresAt,
      });
      return { id: postId };
    },
  });
}
