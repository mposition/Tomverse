import "server-only";

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { encodeAmuxSessionAnalysisQueueCursor,
  type AmuxSessionAnalysisQueueCursor } from "./ideaSessionAnalysisQueueCursorCore.ts";
import { buildAmuxSessionAnalysisQueueWhere } from "./ideaSessionAnalysisQueueWhereCore.ts";

const PAGE_SIZE = 32;

/** Content-free queue hints; neither a claim nor permission to launch CLI. */
export async function listAmuxSessionAnalysisCandidates(
  cursor: AmuxSessionAnalysisQueueCursor | null,
): Promise<{ candidates: Array<{ reservationId: string; ideaId: string;
  modelId: string; expiresAt: string; nextInvocationOrdinal: number }>;
  hasMore: boolean; nextCursor: string | null }> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT set_config('statement_timeout', '2000', true) AS statement_limit,
             set_config('idle_in_transaction_session_timeout', '3000', true) AS idle_limit
    `;
    const clock = await tx.$queryRaw<Array<{ now: Date }>>`
      SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
    `;
    const now = clock[0]?.now;
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw new Error("AMUX session analysis queue clock unavailable");
    }
    const latestScope = await tx.amuxIdeaOperatingScopeSetting.findFirst({
      orderBy: { version: "desc" }, select: { id: true },
    });
    if (!latestScope) return { candidates: [], hasMore: false, nextCursor: null };
    const rows = await tx.amuxIdeaSessionAnalysisReservation.findMany({
      where: { ...buildAmuxSessionAnalysisQueueWhere(now, cursor),
        operatingScopeSettingId: latestScope.id },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: PAGE_SIZE + 1,
      select: { id: true, ideaId: true, modelId: true, createdAt: true,
        idea: { select: { analysisDeadlineAt: true } },
        budgetClaims: { orderBy: { invocationOrdinal: "desc" }, take: 1,
          select: { invocationOrdinal: true } } },
    });
    const candidates = rows.slice(0, PAGE_SIZE);
    const last = candidates.at(-1);
    return {
      candidates: candidates.map((row) => ({ reservationId: row.id,
        ideaId: row.ideaId, modelId: row.modelId,
        expiresAt: row.idea.analysisDeadlineAt.toISOString(),
        nextInvocationOrdinal: row.budgetClaims[0]
          ? row.budgetClaims[0].invocationOrdinal + 1 : 0 })),
      hasMore: rows.length > PAGE_SIZE,
      nextCursor: rows.length > PAGE_SIZE && last
        ? encodeAmuxSessionAnalysisQueueCursor({ createdAt: last.createdAt,
          reservationId: last.id }) : null,
    };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    maxWait: 2_000, timeout: 5_000 });
}
