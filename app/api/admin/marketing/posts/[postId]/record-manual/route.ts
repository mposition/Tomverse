export const dynamic = "force-dynamic";

import { z } from "zod";
import { runMarketingAdminMutation } from "@/lib/marketingAdminMutations";
import {
  MARKETING_MANUAL_PUBLISH_EVIDENCE_MAX,
  MARKETING_MANUAL_PUBLISH_URL_MAX,
  MARKETING_POST_RECORD_MANUAL_ACTION,
  MarketingManualPostRefusedError,
  marketingRecordManualPublishAuditMetadata,
  recordManualMarketingPostPublication,
} from "@/lib/marketingStore";

type RouteContext = { params: Promise<{ postId: string }> };

const schema = z
  .object({
    expectedEnvelopeDigest: z.string().regex(/^[0-9a-f]{64}$/),
    expectedHistoryVersion: z.number().int().nonnegative(),
    /** Where the post is public. The store checks it is https; the column does too. */
    externalUrl: z.string().trim().min(1).max(MARKETING_MANUAL_PUBLISH_URL_MAX),
    /** What the person looked at to say the post is up. */
    evidenceRef: z.string().trim().min(1).max(MARKETING_MANUAL_PUBLISH_EVIDENCE_MAX),
  })
  .strict();

/**
 * POST: a person records that they posted an approved post by hand
 * (operator decision 2026-11-04).
 *
 * For an account whose provider is `manual`, which the publisher never carries.
 * The same gate as the other decisions about a post -- the draft switch and the
 * kill switch -- because it writes the ledger's publication record, even though
 * what it records has already happened.
 */
export async function POST(req: Request, context: RouteContext) {
  const { postId } = await context.params;
  return runMarketingAdminMutation({
    request: req,
    action: MARKETING_POST_RECORD_MANUAL_ACTION,
    targetType: "MarketingPost",
    targetId: postId,
    summary: "Recorded a marketing post as posted by hand.",
    gate: "manual_approval",
    bucket: "admin-marketing-post-record-manual",
    schema,
    metadata: (body) => marketingRecordManualPublishAuditMetadata(body),
    refusal: (error) =>
      error instanceof MarketingManualPostRefusedError
        ? { code: error.code, status: error.status, message: error.message }
        : null,
    run: async (tx, { body, auditLogId }) => {
      const recorded = await recordManualMarketingPostPublication(tx, {
        id: postId,
        expectedEnvelopeDigest: body.expectedEnvelopeDigest,
        expectedHistoryVersion: body.expectedHistoryVersion,
        externalUrl: body.externalUrl,
        evidenceRef: body.evidenceRef,
        auditLogId,
      });
      return { id: postId, slotDate: recorded.slotDate, warnings: recorded.warnings };
    },
  });
}
