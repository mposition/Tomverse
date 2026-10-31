export const dynamic = "force-dynamic";

import { z } from "zod";
import { runMarketingAdminMutation } from "@/lib/marketingAdminMutations";
import {
  MARKETING_ASSET_ACTIONS,
  MARKETING_ASSET_NO_DECISION,
  MarketingAssetRefusedError,
} from "@/lib/marketingAssetCore";
import { decideMarketingAsset } from "@/lib/marketingAssetStore";

type RouteContext = { params: Promise<{ assetId: string }> };

/** The audit row of the decision the page showed; null for a submission never decided. */
const expectedDecisionAuditLogId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).nullable();

const schema = z.discriminatedUnion("decision", [
  z
    .object({
      decision: z.literal("approved"),
      expectedDecisionAuditLogId,
      /** The bytes the person looked at: the write guard approves only these. */
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
    })
    .strict(),
  z.object({ decision: z.literal("retired"), expectedDecisionAuditLogId }).strict(),
]);

/**
 * POST: a person approves or retires an image or video the media CLI
 * submitted (operator decision 2026-10-31).
 *
 * An approval puts the asset in the registry the Guard and the publisher read,
 * so the kill switch refuses it; a retirement only takes an asset away, so
 * nothing does. A decision made against a page that showed an older decision,
 * or other bytes, is refused.
 */
export async function POST(req: Request, context: RouteContext) {
  const { assetId } = await context.params;
  return runMarketingAdminMutation({
    request: req,
    action: (body) => MARKETING_ASSET_ACTIONS[body.decision],
    targetType: "MarketingAsset",
    targetId: assetId,
    summary: (body) =>
      body.decision === "approved"
        ? "Approved an image or video for marketing posts."
        : "Retired a marketing image or video; posts no longer carry it.",
    gate: (body) => (body.decision === "approved" ? "account_control" : "operator_restriction"),
    bucket: "admin-marketing-asset-decision",
    schema,
    metadata: (body) => ({
      previousDecisionAuditLogId: body.expectedDecisionAuditLogId ?? MARKETING_ASSET_NO_DECISION,
      ...(body.decision === "approved" ? { sha256: body.sha256 } : {}),
    }),
    refusal: (error) =>
      error instanceof MarketingAssetRefusedError
        ? { code: error.code, status: error.status, message: error.message }
        : null,
    run: (tx, { body, auditLogId }) =>
      decideMarketingAsset(tx, {
        assetId,
        decision: body.decision,
        expectedDecisionAuditLogId: body.expectedDecisionAuditLogId,
        auditLogId,
      }),
  });
}
