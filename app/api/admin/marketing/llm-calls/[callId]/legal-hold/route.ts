export const dynamic = "force-dynamic";

import { z } from "zod";
import { runMarketingAdminMutation } from "@/lib/marketingAdminMutations";
import { MARKETING_LLM_HOLD_ACTIONS, setMarketingLlmCallLegalHold } from "@/lib/marketingLlmBudgetStore";

type RouteContext = { params: Promise<{ callId: string }> };

const schema = z
  .object({
    hold: z.boolean(),
    /** The audit row of the hold decision the page showed; null if never held. */
    expectedHoldAuditLogId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).nullable(),
  })
  .strict();

/**
 * POST: a person puts a marketing LLM cost ledger row under legal hold, or
 * takes it off (docs/policy/marketing-automation.md §12.2, policy v4 §5).
 *
 * Same rule as a post's hold: setting one stops retention from deleting the
 * row, so it is a narrowing and no switch refuses it; releasing one lets the
 * row be deleted on schedule, which the kill switch refuses.
 */
export async function POST(req: Request, context: RouteContext) {
  const { callId } = await context.params;
  return runMarketingAdminMutation({
    request: req,
    action: (body) => (body.hold ? MARKETING_LLM_HOLD_ACTIONS.set : MARKETING_LLM_HOLD_ACTIONS.released),
    targetType: "MarketingLlmCall",
    targetId: callId,
    summary: (body) =>
      body.hold
        ? "Placed a marketing LLM cost ledger row under legal hold."
        : "Released a marketing LLM cost ledger row from legal hold.",
    gate: (body) => (body.hold ? "operator_restriction" : "account_control"),
    bucket: "admin-marketing-llm-call-legal-hold",
    schema,
    metadata: (body) => ({ previousHoldAuditLogId: body.expectedHoldAuditLogId ?? "none" }),
    run: async (tx, { body, auditLogId }) => {
      await setMarketingLlmCallLegalHold(tx, {
        callId,
        hold: body.hold,
        auditLogId,
        expectedHoldAuditLogId: body.expectedHoldAuditLogId,
      });
      return { id: callId, hold: body.hold };
    },
  });
}
