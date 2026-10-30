export const dynamic = "force-dynamic";

import { BoardImportError } from "@/lib/amux/boardImportCore";
import {
  AMUX_DB_BOUNDARIES,
  withAmuxDbBoundary,
  withAmuxRouteBudget,
} from "@/lib/amux/dbBoundary";
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
  resolveAmuxV22QuestionFromDmJudgment,
} from "@/lib/amux/v22OwnerQuestionDmService";

/**
 * The relay's v22 question tick (operator decision 2026-10-30): first answer
 * at most one open question whose Decision Maker proposal a person confirmed,
 * then list the open questions that still need a typed-ask card on the AMUX
 * host and the cards of questions no longer open that it should close. The
 * question text is opened from the run's encrypted result outside the read
 * transaction. Closed until `TOMVERSE_AMUX_DM_ROUTING=enabled`.
 */
const OPERATION = "decision_maker_v22_question_sync";
const refused = dmRouteRefusal("synced");

export async function POST(request: Request) {
  if (!isAmuxSyncAuthorized(request)) {
    return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  }
  if (!dmInternalRoutesEnabled()) return refused(409, "dm_routing_disabled");

  return withAmuxRouteBudget(async () => {
    try {
      const resolved = await withAmuxDbBoundary(
        AMUX_DB_BOUNDARIES.decisionMakerV22QuestionResolve,
        (tx, context) => resolveAmuxV22QuestionFromDmJudgment(tx, context.dbNow));
      const rows = await withAmuxDbBoundary(
        AMUX_DB_BOUNDARIES.decisionMakerV22QuestionRead,
        (tx) => readAmuxV22QuestionSyncRows(tx));
      const cards = await openAmuxV22QuestionCards(rows.pending);
      return amuxJsonNoStore({
        synced: true,
        resolved: resolved.resolved,
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
