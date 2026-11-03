export const dynamic = "force-dynamic";

import { z } from "zod";

import { readLimitedJson } from "@/lib/apiSecurity";
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
import { recordAmuxV22QuestionLocalCard } from
  "@/lib/amux/v22OwnerQuestionDmService";

/**
 * Names the typed-ask card the relay filed for a v22 question, once. The same
 * card again is a read; another card for the same question is refused.
 * Closed until `TOMVERSE_AMUX_DM_ROUTING=enabled`.
 */
const OPERATION = "decision_maker_v22_question_card";
const refused = dmRouteRefusal("recorded");
const requestSchema = z.object({
  question_id: z.string().uuid(),
  card_id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
}).strict();

export async function POST(request: Request) {
  if (!isAmuxSyncAuthorized(request)) {
    return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  }
  if (!dmInternalRoutesEnabled()) return refused(409, "dm_routing_disabled");

  return withAmuxRouteBudget(async () => {
    try {
      const body = await readLimitedJson(request, 1_024, requestSchema);
      const result = await withAmuxDbBoundary(
        AMUX_DB_BOUNDARIES.decisionMakerV22QuestionWrite,
        (tx) => recordAmuxV22QuestionLocalCard(tx, {
          questionId: body.question_id, cardId: body.card_id }));
      return amuxJsonNoStore(result);
    } catch (error) {
      if (error instanceof BoardImportError) return refused(error.httpStatus, error.code);
      return dmRouteErrorResponse(OPERATION, error, refused);
    }
  });
}
