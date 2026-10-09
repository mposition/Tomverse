import type { Prisma } from "@prisma/client";
import type { AmuxV4AnalysisQueueCursor } from "./ideaAnalysisQueueCursorCore.ts";

/** A polling hint only. The claim transaction must independently establish
 * every invariant, including the human confirmation audit and budget. */
export function buildAmuxV4AnalysisCandidateWhere(now: Date,
  cursor: AmuxV4AnalysisQueueCursor | null): Prisma.AmuxIdeaTransferPreviewWhereInput {
  return {
    state: "confirmed", consumedAt: null, outcomeUnknownAt: null,
    confirmedAt: { not: null }, confirmedByUserId: { not: null },
    confirmationAuditLogId: { not: null },
    confirmExpiresAt: { gt: now }, expiresAt: { gt: now },
    payloadCiphertext: { not: null }, payloadPurgedAt: null,
    idea: { state: { in: ["submitted", "analyzing"] },
      analysisDeadlineAt: { gt: now },
      currentSourcePlan: { is: { state: "active" } } },
    sourcePlanRevision: { is: { state: "active" } },
    planBoundCurrentForChunk: { is: { state: "awaiting_preview" } },
    ...(cursor ? { OR: [
      { confirmedAt: { gt: cursor.confirmedAt } },
      { confirmedAt: cursor.confirmedAt, id: { gt: cursor.previewId } },
    ] } : {}),
  };
}
