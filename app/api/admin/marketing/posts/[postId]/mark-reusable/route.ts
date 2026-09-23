export const dynamic = "force-dynamic";

import { z } from "zod";
import { runMarketingAdminMutation } from "@/lib/marketingAdminMutations";
import {
  MARKETING_S2B1_ACTIONS,
  markMarketingPostReusable,
} from "@/lib/marketingStore";

type RouteContext = { params: Promise<{ postId: string }> };

const schema = z
  .object({
    expectedEnvelopeDigest: z.string().regex(/^[0-9a-f]{64}$/),
    expectedHistoryVersion: z.number().int().nonnegative(),
  })
  .strict();

/**
 * POST: a person marks approved content reusable as a template.
 *
 * This is the only route that can make the Guard's third verdict reachable: a
 * draft may go out without a person only through a template a person marked,
 * so without this the autonomy path is unreachable however the Guard decides.
 *
 * The audit entry carries the digest and the history version it was marked at,
 * which is what `loadApprovedTemplate` reads back to check the content has not
 * moved since.
 */
export async function POST(req: Request, context: RouteContext) {
  const { postId } = await context.params;
  return runMarketingAdminMutation({
    request: req,
    action: MARKETING_S2B1_ACTIONS.postMarkReusable,
    targetType: "MarketingPost",
    targetId: postId,
    summary: "Marked a published post reusable as a template.",
    gate: "manual_approval",
    bucket: "admin-marketing-post-mark-reusable",
    schema,
    metadata: (body) => ({
      digest: body.expectedEnvelopeDigest,
      historyVersion: body.expectedHistoryVersion,
    }),
    run: async (tx, { body, auditLogId }) => {
      await markMarketingPostReusable(tx, {
        id: postId,
        expectedEnvelopeDigest: body.expectedEnvelopeDigest,
        expectedHistoryVersion: body.expectedHistoryVersion,
        auditLogId,
      });
      return { id: postId };
    },
  });
}
