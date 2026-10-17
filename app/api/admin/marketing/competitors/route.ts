export const dynamic = "force-dynamic";

import { z } from "zod";
import { runMarketingAdminMutation } from "@/lib/marketingAdminMutations";
import {
  MARKETING_COMPETITOR_ACTIONS,
  MARKETING_COMPETITOR_NO_DECISION,
  marketingCompetitorDisplayNameSchema,
  marketingCompetitorHostsSchema,
  marketingCompetitorIdSchema,
  MarketingCompetitorRefusedError,
} from "@/lib/marketingCompetitorCore";
import { createApprovedMarketingCompetitor } from "@/lib/marketingCompetitorStore";

const schema = z
  .object({
    competitorId: marketingCompetitorIdSchema,
    displayName: marketingCompetitorDisplayNameSchema,
    officialHosts: marketingCompetitorHostsSchema,
  })
  .strict();

/**
 * POST: a person adds a competitor A3 has not proposed, approved as it is
 * created (S3f-R3). Its hosts become sources for market facts, which starts
 * something, so the kill switch refuses it.
 *
 * The audit row records the name and hosts after normalisation -- the same
 * values the store writes -- because the registry's write guard compares the
 * two exactly.
 */
export async function POST(req: Request) {
  return runMarketingAdminMutation({
    request: req,
    action: MARKETING_COMPETITOR_ACTIONS.approved,
    targetType: "MarketingCompetitor",
    targetId: (body) => body.competitorId,
    summary: "Added an approved competitor to the market-intelligence registry.",
    gate: "account_control",
    bucket: "admin-marketing-competitor-create",
    schema,
    metadata: (body) => ({
      previousDecisionAuditLogId: MARKETING_COMPETITOR_NO_DECISION,
      displayName: body.displayName,
      officialHosts: body.officialHosts,
    }),
    refusal: (error) =>
      error instanceof MarketingCompetitorRefusedError
        ? { code: error.code, status: error.status, message: error.message }
        : null,
    run: (tx, { body, auditLogId }) => createApprovedMarketingCompetitor(tx, { ...body, auditLogId }),
  });
}
