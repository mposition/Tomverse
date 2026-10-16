import "server-only";

import type { Prisma } from "@prisma/client";

import { AMUX_V4_ANALYSIS_NAMESPACE } from "./ideaAnalysisBudgetCore.ts";

const ID = /^[A-Za-z0-9:_-]{1,128}$/;

export class AmuxIdeaAnalysisWorkerStopReadError extends Error {
  constructor(readonly code: "not_found" | "integrity_unavailable") {
    super(code);
    this.name = "AmuxIdeaAnalysisWorkerStopReadError";
  }
}

type StopSnapshot = {
  namespace: string;
  holdStatus: string;
  dispatchedAt: Date | null;
  previewId: string;
  previewState: string;
  ideaState: string;
  cancelledAt: Date | null;
  analysisDeadlineAt: Date;
  chunkState: string;
  currentPreviewId: string | null;
  leaseGeneration: number;
  now: Date;
};

/** One database snapshot for a running child. An uncertain read never grants
 * permission to keep running; the caller kills the process group on any
 * non-200 reply. This exposes no idea, prompt, path, model or cost content. */
export async function readAmuxIdeaAnalysisWorkerStopState(
  tx: Prisma.TransactionClient, holdId: string,
): Promise<{ holdId: string; stop: boolean }> {
  if (!ID.test(holdId)) throw new AmuxIdeaAnalysisWorkerStopReadError("not_found");
  const rows = await tx.$queryRaw<StopSnapshot[]>`
    SELECT h."namespace", h."status" AS "holdStatus",
           h."dispatchedAt", p."id" AS "previewId",
           p."state" AS "previewState", i."state" AS "ideaState",
           i."cancelledAt", i."analysisDeadlineAt",
           c."state" AS "chunkState", c."currentPreviewId",
           c."leaseGeneration",
           (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
    FROM "AmuxIdeaAnalysisBudgetHold" h
    JOIN "AmuxIdeaTransferPreview" p ON p."id" = h."previewId"
    JOIN "AmuxIdeaSubmission" i ON i."id" = p."ideaId"
    JOIN "AmuxIdeaAnalysisChunk" c
      ON c."ideaId" = p."ideaId" AND c."chunkIndex" = p."chunkIndex"
    WHERE h."id" = ${holdId}
  `;
  if (rows.length !== 1) throw new AmuxIdeaAnalysisWorkerStopReadError("not_found");
  const row = rows[0]!;
  if (row.namespace !== AMUX_V4_ANALYSIS_NAMESPACE ||
      !(row.analysisDeadlineAt instanceof Date) ||
      !(row.now instanceof Date) || !Number.isFinite(row.now.getTime())) {
    throw new AmuxIdeaAnalysisWorkerStopReadError("integrity_unavailable");
  }
  const continueRunning = row.holdStatus === "in_flight" &&
    row.dispatchedAt instanceof Date &&
    row.previewState === "in_flight" &&
    row.ideaState === "analyzing" && row.cancelledAt === null &&
    row.analysisDeadlineAt > row.now && row.chunkState === "in_flight" &&
    row.currentPreviewId === row.previewId && row.leaseGeneration === 1;
  return { holdId, stop: !continueRunning };
}
