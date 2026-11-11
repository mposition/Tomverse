import "server-only";

import { prisma } from "@/lib/prisma";
import { readDecisionMakerCardDetailForAdmin } from "@/lib/amux/decisionMakerAdminRead";
import { dmInternalRoutesEnabled } from "@/lib/amux/decisionMakerInternalRoute";
import { readDecisionMakerSwitches } from "@/lib/amux/decisionMakerSwitchStore";
import { AMUX_DB_BOUNDARIES, withAmuxDbBoundary } from "@/lib/amux/dbBoundary";
import {
  amuxV22QuestionDmNotSentReason,
  amuxV22QuestionDmOfDetail,
  type AmuxV22QuestionDm,
} from "./v22OwnerQuestionDmCore.ts";
import { amuxV22Provider } from "./v22WorkerClaimCore.ts";

/**
 * Where one open v22 worker question stands with the Decision Maker, for the
 * card that shows it (lib/amux/v22OwnerQuestionDmCore.ts names the states).
 * Reads only. A question with no local card says why it is not with the
 * Decision Maker: the routing switch, the kill switch, a run without a
 * provider, or the relay's next tick. One with a card reads the card's newest
 * request through the Decision Maker's own stores, in the same boundary and
 * statements as Admin's request detail. A read that fails is `unavailable`,
 * never a state it did not see.
 */
export async function readAmuxV22QuestionDm(questionId: string): Promise<AmuxV22QuestionDm> {
  try {
    const row = await prisma.amuxV22TaskQuestion.findUnique({
      where: { id: questionId },
      select: { localCardId: true, attempt: { select: { v22Assignment: { select: { provider: true } } } } },
    });
    if (!row) return { state: "unavailable" };
    const cardId = row.localCardId;
    if (cardId === null) {
      const provider = row.attempt.v22Assignment?.provider ?? null;
      const routingEnabled = dmInternalRoutesEnabled();
      const switches = routingEnabled ? await readDecisionMakerSwitches(prisma) : null;
      return {
        state: "not_sent",
        reason: amuxV22QuestionDmNotSentReason({
          routingEnabled,
          killSwitch: switches?.killSwitch ?? null,
          hasProvider: provider !== null && amuxV22Provider(provider) !== null,
        }),
      };
    }
    return await readAmuxDmLocalCardState(cardId);
  } catch {
    console.warn(JSON.stringify({ subsystem: "amux", event: "v22_question_dm_read_failed" }));
    return { state: "unavailable" };
  }
}

/**
 * Where one local Decision Maker card stands -- a worker question's, or a
 * result review's -- read through the Decision Maker's own stores. Reads only;
 * a failed read is `unavailable`.
 */
export async function readAmuxDmLocalCardState(cardId: string): Promise<AmuxV22QuestionDm> {
  try {
    const detail = await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerRequestDetailRead,
      (tx) => readDecisionMakerCardDetailForAdmin(tx, cardId));
    return amuxV22QuestionDmOfDetail(detail);
  } catch {
    console.warn(JSON.stringify({ subsystem: "amux", event: "dm_local_card_read_failed" }));
    return { state: "unavailable" };
  }
}
