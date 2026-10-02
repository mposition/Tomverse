import "server-only";

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  encodeAmuxV4AnalysisQueueCursor,
  type AmuxV4AnalysisQueueCursor,
} from "./ideaAnalysisQueueCursorCore.ts";

const PAGE_SIZE = 32;

/** Candidate metadata only. Each claim must independently lock the idea,
 * chunk, receipt, owner confirmation audit, model catalog and budget before
 * one byte of the confirmed payload can leave the app. */
export async function listAmuxV4AnalysisCandidates(
  cursor: AmuxV4AnalysisQueueCursor | null,
): Promise<{
  candidates: Array<{
    previewId: string; ideaId: string; chunkIndex: number;
    attempt: number; modelId: string; expiresAt: string;
  }>;
  hasMore: boolean;
  nextCursor: string | null;
}> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT set_config('statement_timeout', '2000', true) AS statement_limit,
             set_config('idle_in_transaction_session_timeout', '3000', true) AS idle_limit
    `;
    const clock = await tx.$queryRaw<Array<{ now: Date }>>`
      SELECT clock_timestamp() AS "now"
    `;
    const now = clock[0]?.now;
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw new Error("AMUX v4 analysis queue clock unavailable");
    }
    const where: Prisma.AmuxIdeaTransferPreviewWhereInput = {
      state: "confirmed", consumedAt: null, outcomeUnknownAt: null,
      confirmedAt: { not: null }, confirmExpiresAt: { gt: now },
      expiresAt: { gt: now }, payloadCiphertext: { not: null },
      payloadPurgedAt: null,
      idea: { state: "submitted", analysisDeadlineAt: { gt: now } },
      currentForChunk: { is: { state: "awaiting_preview" } },
      ...(cursor ? { OR: [
        { confirmedAt: { gt: cursor.confirmedAt } },
        { confirmedAt: cursor.confirmedAt, id: { gt: cursor.previewId } },
      ] } : {}),
    };
    const rows = await tx.amuxIdeaTransferPreview.findMany({
      where,
      orderBy: [{ confirmedAt: "asc" }, { id: "asc" }],
      take: PAGE_SIZE + 1,
      select: { id: true, ideaId: true, chunkIndex: true,
        attempt: true, modelId: true, confirmedAt: true, expiresAt: true },
    });
    const candidates = rows.slice(0, PAGE_SIZE);
    const last = candidates.at(-1);
    if (last && !(last.confirmedAt instanceof Date)) {
      throw new Error("AMUX v4 analysis queue position unavailable");
    }
    return {
      candidates: candidates.map((row) => ({
        previewId: row.id, ideaId: row.ideaId, chunkIndex: row.chunkIndex,
        attempt: row.attempt, modelId: row.modelId,
        expiresAt: row.expiresAt.toISOString(),
      })),
      hasMore: rows.length > PAGE_SIZE,
      nextCursor: rows.length > PAGE_SIZE && last && last.confirmedAt
        ? encodeAmuxV4AnalysisQueueCursor({ confirmedAt: last.confirmedAt,
          previewId: last.id }) : null,
    };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    maxWait: 2_000, timeout: 5_000 });
}
