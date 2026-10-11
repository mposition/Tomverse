import "server-only";

import { prisma } from "@/lib/prisma";
import { readAmuxCardTitle } from "./adminExecutionRead.ts";
import { AMUX_BACKLOG_PAGE_SIZE, amuxBacklogSummary, amuxBacklogWhere } from
  "./adminBacklogListCore.ts";

export async function readAmuxBacklogList(search: string, requestedPage: number) {
  const where = amuxBacklogWhere(search);
  const total = await prisma.amuxWorkItem.count({ where });
  const pageCount = Math.max(1, Math.ceil(total / AMUX_BACKLOG_PAGE_SIZE));
  const page = Math.min(requestedPage, pageCount);
  const cards = await prisma.amuxWorkItem.findMany({ where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    skip: (page - 1) * AMUX_BACKLOG_PAGE_SIZE, take: AMUX_BACKLOG_PAGE_SIZE,
    select: { id: true, sourceKey: true, sourceSystem: true, sourceSnapshot: true,
      title: true, description: true, revision: true, createdAt: true,
      v4TitleCiphertext: true, v4TitleKeyId: true, v4TitleKeyVersion: true,
      v4TitleDigest: true, v4TitleDigestKeyId: true },
  });
  const ids = cards.map((card) => card.id);
  const [titles, scores] = await Promise.all([
    Promise.all(cards.map(readAmuxCardTitle)),
    ids.length ? prisma.$queryRaw<Array<{ taskId: string; taskRevision: number;
      scoreTotal: number; activeStaleAt: Date }>>`
      SELECT DISTINCT ON ("taskId") "taskId", "taskRevision", "scoreTotal", "activeStaleAt"
      FROM "AmuxPortfolioScoreSnapshot"
      WHERE "taskId" = ANY(${ids}::text[])
      ORDER BY "taskId", "computedAt" DESC, "id" DESC
    ` : [],
  ]);
  const latestScore = new Map(scores.map((score) => [score.taskId, score]));
  const now = Date.now();
  return { total, page, pageCount, pageSize: AMUX_BACKLOG_PAGE_SIZE,
    rows: cards.map((card, index) => {
      const score = latestScore.get(card.id);
      return { id: card.id, cardNumber: card.sourceKey ?? card.id,
        createdAt: card.createdAt.toISOString(),
        summary: amuxBacklogSummary(card.sourceSystem === "admin-idea-v4" ?
          titles[index] : card.description || titles[index]),
        summaryUnavailable: card.sourceSystem === "admin-idea-v4" && titles[index] === null,
        score: score?.taskRevision === card.revision ? score.scoreTotal : null,
        scoreFresh: score?.taskRevision === card.revision && score.activeStaleAt.getTime() > now };
    }) };
}

export type AmuxBacklogList = Awaited<ReturnType<typeof readAmuxBacklogList>>;
