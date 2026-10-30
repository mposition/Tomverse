export const dynamic = "force-dynamic";

import { z } from "zod";

import { readLimitedJson } from "@/lib/apiSecurity";
import { BoardImportError } from "@/lib/amux/boardImportCore";
import {
  AMUX_DB_BOUNDARIES,
  withAmuxDbBoundary,
  withAmuxRouteBudget,
} from "@/lib/amux/dbBoundary";
import { parseDmDeliveryCursor } from "@/lib/amux/decisionMakerDeliveryCore";
import {
  dmInternalRoutesEnabled,
  dmRouteErrorResponse,
  dmRouteRefusal,
} from "@/lib/amux/decisionMakerInternalRoute";
import { isAmuxSyncAuthorized } from "@/lib/amux/guard";
import { amuxJsonNoStore } from "@/lib/amux/internalRoute";
import {
  openAmuxV22QuestionCards,
  readAmuxV22QuestionSyncRows,
  runAmuxV22ResolveStep,
} from "@/lib/amux/v22OwnerQuestionDmService";

/**
 * The relay's v22 question tick (operator decision 2026-10-30): first one
 * step of the walk over confirmed Decision Maker proposals from the relay's
 * cursor (`after`), which answers an open question whose card a person
 * confirmed -- a read, then the answer under the audit chain lock and the
 * kill switch, or, when the answer cannot resume the Task, an escalation and
 * the cancel, each its own transaction within docs/policy/amux-decision-maker.md §9's 12 statements; then the open questions that still need a typed-ask card on the
 * AMUX host and the cards of questions no longer open that it should close.
 * `cursor` says where the walk goes next. The question text is opened from
 * the run's encrypted result outside the read transaction. Closed until
 * `TOMVERSE_AMUX_DM_ROUTING=enabled`.
 */
const OPERATION = "decision_maker_v22_question_sync";
const refused = dmRouteRefusal("synced");
const requestSchema = z.object({ after: z.unknown().optional() }).strict();

export async function POST(request: Request) {
  if (!isAmuxSyncAuthorized(request)) {
    return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  }
  if (!dmInternalRoutesEnabled()) return refused(409, "dm_routing_disabled");

  return withAmuxRouteBudget(async () => {
    try {
      const body = await readLimitedJson(request, 1_024, requestSchema);
      const after = parseDmDeliveryCursor(body.after);
      if (after === undefined) return refused(400, "invalid_request");
      const { resolved: outcome, cursor } = await runAmuxV22ResolveStep(after);
      const rows = await withAmuxDbBoundary(
        AMUX_DB_BOUNDARIES.decisionMakerV22QuestionRead,
        (tx) => readAmuxV22QuestionSyncRows(tx));
      const cards = await openAmuxV22QuestionCards(rows.pending);
      return amuxJsonNoStore({
        synced: true,
        resolved: outcome,
        cursor: cursor.move === "advance" ? { move: "advance",
          judged_at_ms: cursor.judgedAtMs, request_id: cursor.requestId } :
          { move: cursor.move },
        pending: cards,
        closing: rows.closing.map((row) => ({
          question_id: row.questionId, card_id: row.cardId })),
      });
    } catch (error) {
      if (error instanceof BoardImportError) return refused(error.httpStatus, error.code);
      return dmRouteErrorResponse(OPERATION, error, refused);
    }
  });
}
