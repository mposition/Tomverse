export const dynamic = "force-dynamic";

import { z } from "zod";

import { readLimitedJson } from "@/lib/apiSecurity";
import {
  AMUX_DB_BOUNDARIES,
  withAmuxDbBoundary,
  withAmuxRouteBudget,
} from "@/lib/amux/dbBoundary";
import {
  dmInternalRoutesEnabled,
  dmReturnedRefusalStatus,
  dmRouteErrorResponse,
  dmRouteRefusal,
} from "@/lib/amux/decisionMakerInternalRoute";
import { closeDecisionMakerRequestOnDirectAnswer } from "@/lib/amux/decisionMakerRequestStore";
import { isAmuxSyncAuthorized } from "@/lib/amux/guard";
import { amuxJsonNoStore } from "@/lib/amux/internalRoute";

/**
 * AMUX Decision Maker: the operator answered a question directly
 * (docs/policy/amux-decision-maker.md §2-7: "운영자의 직접 답이 먼저면 요청은
 * 닫힌다"), stage S2-2b4. The bridge found the local AMUX's answer record of
 * the question revision naming the operator and reports the question; the
 * request store's `closeDecisionMakerRequestOnDirectAnswer()` closes that
 * question's request once, whatever it was waiting for, so a proposal nobody
 * confirmed can never be confirmed and delivered after the operator answered.
 * This route only authenticates, reads the body and runs that one transaction
 * in the route budget and its DB boundary.
 *
 * No request for the question (404 `unknown_request`), one routed to the
 * operator (409 `not_routed_to_dm`) and one already closed (409 `closed`)
 * write nothing, so a report sent again is a read. Allowed under the kill
 * switch (§6's table: the operator's direct answer). It carries no answer text:
 * the card and the question revision only.
 *
 * Closed until the operator sets `TOMVERSE_AMUX_DM_ROUTING=enabled`.
 */

const MAX_BODY_BYTES = 1_024;

const requestSchema = z
  .object({
    card_id: z.unknown(),
    question_revision: z.unknown(),
  })
  .strict();

const OPERATION = "decision_maker_direct_answer_close";

const refused = dmRouteRefusal("recorded");

export async function POST(request: Request) {
  if (!isAmuxSyncAuthorized(request)) {
    return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  }
  if (!dmInternalRoutesEnabled()) return refused(409, "dm_routing_disabled");

  return withAmuxRouteBudget(async () => {
    try {
      const body = await readLimitedJson(request, MAX_BODY_BYTES, requestSchema);
      const closed = await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerDirectAnswerClose, (tx) =>
        closeDecisionMakerRequestOnDirectAnswer(tx, { cardId: body.card_id, questionRevision: body.question_revision }),
      );
      if (!closed.recorded) return refused(dmReturnedRefusalStatus(closed.reason), closed.reason);
      return amuxJsonNoStore({
        recorded: true,
        event_id: closed.event.eventId,
        created_at: closed.event.createdAt,
      });
    } catch (error) {
      return dmRouteErrorResponse(OPERATION, error, refused);
    }
  });
}
