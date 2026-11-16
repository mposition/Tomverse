import type { Prisma } from "@prisma/client";
import type { AmuxSessionAnalysisQueueCursor } from "./ideaSessionAnalysisQueueCursorCore.ts";

/** Only live, encrypted session ideas are polling hints. The eventual claim
 * must recheck all authority, deadline, stop and budget conditions. */
export function buildAmuxSessionAnalysisQueueWhere(now: Date,
  cursor: AmuxSessionAnalysisQueueCursor | null):
  Prisma.AmuxIdeaSessionAnalysisReservationWhereInput {
  return {
    status: "queued",
    // A running claim is still running. Every other idea is a candidate: the
    // queue service keeps the ones whose next claim is due by
    // amuxSessionNextClaimDue (ideaSessionAnalysisRetryCore.ts), which also
    // queues a failed subscription analysis again after its wait (operator,
    // 2026-11-16) and leaves a paid or owner-stopped one where it is.
    // A paid claim's unknown outcome stays with the owner; a subscription one
    // left open from before the system closed them is due (the claim writer
    // closes it at zero first).
    AND: [{ budgetClaims: { none: { OR: [
      { status: "in_flight" },
      { status: "outcome_unknown", budgetMode: { not: "max_shadow" } },
    ] } } }],
    idea: { submissionOrigin: "session", state: { in: ["submitted", "analyzing"] },
      cancelledAt: null, analysisCompletedAt: null, analysisDeadlineAt: { gt: now },
      rawCiphertext: { not: null }, rawPurgedAt: null,
      sourceProvenanceCiphertext: { not: null },
      // A refused answer waits for its decision (owner decision 2026-11-05).
      planRefusals: { none: { state: "open" } } },
    ...(cursor ? { OR: [
      { createdAt: { gt: cursor.createdAt } },
      { createdAt: cursor.createdAt, id: { gt: cursor.reservationId } },
    ] } : {}),
  };
}
