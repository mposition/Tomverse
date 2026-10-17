import type { Prisma } from "@prisma/client";
import type { AmuxSessionAnalysisQueueCursor } from "./ideaSessionAnalysisQueueCursorCore.ts";

/** Only live, encrypted session ideas are polling hints. The eventual claim
 * must recheck all authority, deadline, stop and budget conditions. */
export function buildAmuxSessionAnalysisQueueWhere(now: Date,
  cursor: AmuxSessionAnalysisQueueCursor | null):
  Prisma.AmuxIdeaSessionAnalysisReservationWhereInput {
  return {
    status: "queued",
    // Only a verified prior chunk can progress automatically. A failed or
    // owner-resolved unknown claim stays terminal; no automatic replay occurs.
    AND: [{ OR: [
      { budgetClaims: { none: {} }, idea: { state: "submitted" } },
      { budgetClaims: { some: { status: "succeeded" },
        every: { status: "succeeded" } }, idea: { state: "analyzing" } },
    ] }],
    idea: { submissionOrigin: "session", state: { in: ["submitted", "analyzing"] },
      cancelledAt: null, analysisCompletedAt: null, analysisDeadlineAt: { gt: now },
      rawCiphertext: { not: null }, rawPurgedAt: null,
      sourceProvenanceCiphertext: { not: null } },
    ...(cursor ? { OR: [
      { createdAt: { gt: cursor.createdAt } },
      { createdAt: cursor.createdAt, id: { gt: cursor.reservationId } },
    ] } : {}),
  };
}
