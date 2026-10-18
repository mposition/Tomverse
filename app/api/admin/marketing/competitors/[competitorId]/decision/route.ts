export const dynamic = "force-dynamic";

import { z } from "zod";
import { runMarketingAdminMutation } from "@/lib/marketingAdminMutations";
import {
  MARKETING_COMPETITOR_ACTIONS,
  MARKETING_COMPETITOR_NO_DECISION,
  marketingCompetitorDisplayNameSchema,
  marketingCompetitorHostsSchema,
  marketingCompetitorPagesSchema,
  MarketingCompetitorRefusedError,
} from "@/lib/marketingCompetitorCore";
import { decideMarketingCompetitor } from "@/lib/marketingCompetitorStore";

type RouteContext = { params: Promise<{ competitorId: string }> };

/** The audit row of the decision the page showed; null for a proposal never decided. */
const expectedDecisionAuditLogId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).nullable();

const schema = z.discriminatedUnion("decision", [
  z
    .object({
      decision: z.literal("approved"),
      expectedDecisionAuditLogId,
      /** What the person approves, edited or as proposed: the store writes exactly this. */
      displayName: marketingCompetitorDisplayNameSchema,
      officialHosts: marketingCompetitorHostsSchema,
      /** The pages A3 reads, each on one of these hosts. */
      trackedPages: marketingCompetitorPagesSchema,
    })
    .strict(),
  z.object({ decision: z.literal("rejected"), expectedDecisionAuditLogId }).strict(),
  z.object({ decision: z.literal("retired"), expectedDecisionAuditLogId }).strict(),
]);

/**
 * POST: a person approves, rejects or retires a competitor (S3f-R3).
 *
 * An approval makes the hosts sources for market facts, so the kill switch
 * refuses it; a rejection or a retirement only takes sources away, so nothing
 * does -- a stop that a switch can refuse is not a stop. A decision made
 * against a page that showed an older decision is refused as a conflict.
 */
export async function POST(req: Request, context: RouteContext) {
  const { competitorId } = await context.params;
  return runMarketingAdminMutation({
    request: req,
    action: (body) => MARKETING_COMPETITOR_ACTIONS[body.decision],
    targetType: "MarketingCompetitor",
    targetId: competitorId,
    summary: (body) =>
      body.decision === "approved"
        ? "Approved a competitor and its official hosts for market facts."
        : body.decision === "rejected"
          ? "Rejected a proposed competitor."
          : "Retired a competitor; its hosts are no longer sources.",
    gate: (body) => (body.decision === "approved" ? "account_control" : "operator_restriction"),
    bucket: "admin-marketing-competitor-decision",
    schema,
    metadata: (body) => ({
      previousDecisionAuditLogId: body.expectedDecisionAuditLogId ?? MARKETING_COMPETITOR_NO_DECISION,
      ...(body.decision === "approved" ? { displayName: body.displayName, officialHosts: body.officialHosts, trackedPages: body.trackedPages }
        : {}),
    }),
    refusal: (error) =>
      error instanceof MarketingCompetitorRefusedError
        ? { code: error.code, status: error.status, message: error.message }
        : null,
    run: (tx, { body, auditLogId }) =>
      decideMarketingCompetitor(tx, {
        competitorId,
        decision: body.decision,
        expectedDecisionAuditLogId: body.expectedDecisionAuditLogId,
        auditLogId,
        ...(body.decision === "approved"
          ? { displayName: body.displayName, officialHosts: body.officialHosts, trackedPages: body.trackedPages }
          : {}),
      }),
  });
}
