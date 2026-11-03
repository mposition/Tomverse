export const dynamic = "force-dynamic";

import { z } from "zod";
import { runMarketingAdminMutation } from "@/lib/marketingAdminMutations";
import {
  MARKETING_POST_WITHDRAW_APPROVAL_ACTION,
  MarketingPostWithdrawRefusedError,
  marketingWithdrawApprovalAuditMetadata,
  withdrawMarketingPostApproval,
} from "@/lib/marketingStore";

type RouteContext = { params: Promise<{ postId: string }> };

const schema = z
  .object({
    expectedEnvelopeDigest: z.string().regex(/^[0-9a-f]{64}$/),
    expectedHistoryVersion: z.number().int().nonnegative(),
  })
  .strict();

/**
 * POST: a person takes back an approval before the post has gone anywhere
 * (operator decision 2026-11-03).
 *
 * A narrowing: the post stops being able to go out, so no switch refuses it.
 * The store refuses a post the publisher has already taken.
 */
export async function POST(req: Request, context: RouteContext) {
  const { postId } = await context.params;
  return runMarketingAdminMutation({
    request: req,
    action: MARKETING_POST_WITHDRAW_APPROVAL_ACTION,
    targetType: "MarketingPost",
    targetId: postId,
    summary: "Withdrew the approval of a marketing post.",
    gate: "operator_restriction",
    bucket: "admin-marketing-post-withdraw",
    schema,
    metadata: (body) => marketingWithdrawApprovalAuditMetadata(body),
    refusal: (error) =>
      error instanceof MarketingPostWithdrawRefusedError
        ? { code: error.code, status: error.status, message: error.message }
        : null,
    run: async (tx, { body, auditLogId }) => {
      await withdrawMarketingPostApproval(tx, {
        id: postId,
        expectedEnvelopeDigest: body.expectedEnvelopeDigest,
        expectedHistoryVersion: body.expectedHistoryVersion,
        auditLogId,
      });
      return { id: postId };
    },
  });
}
