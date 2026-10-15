import "server-only";

import type { Prisma } from "@prisma/client";

import { AMUX_DB_BOUNDARIES, withAmuxDbBoundary } from "@/lib/amux/dbBoundary";
import { amuxIdeaProgress, type AmuxIdeaProgress } from "@/lib/amux/ideaProgressCore";

/** How many of the owner's newest ideas the Ideas tab lists. */
export const AMUX_IDEA_PROGRESS_LIMIT = 20;

export type AmuxIdeaProgressRow = AmuxIdeaProgress & {
  ideaId: string;
  requestId: string;
  submittedAt: string;
  /** The first registered card's display key, the only plaintext label an idea has. */
  displayKey: string | null;
  /** Task PRs waiting for GitHub review or merge. */
  reviewPullRequests: Array<{ number: number; displayKey: string | null }>;
};

/**
 * The owner's newest ideas and the stage each is at, for the Ideas tab
 * (approved backlog redesign). One REPEATABLE READ snapshot inside the AMUX DB
 * boundary: setup + seven reads + fence, pinned by tests/amuxIdeaProgress.test.mjs.
 * It reads no idea text, title or body (all encrypted or purged); a failed read
 * throws, and the page shows it as unavailable, never as an empty list.
 */
export async function readAmuxIdeaProgressForOwner(actorUserId: string): Promise<AmuxIdeaProgressRow[]> {
  return withAmuxDbBoundary(AMUX_DB_BOUNDARIES.ideaProgressListRead,
    (tx) => readAmuxIdeaProgressInTx(tx, actorUserId));
}

export async function readAmuxIdeaProgressInTx(tx: Prisma.TransactionClient,
  actorUserId: string): Promise<AmuxIdeaProgressRow[]> {
  const ideas = await tx.amuxIdeaSubmission.findMany({
    where: { actorUserId }, orderBy: [{ submittedAt: "desc" }, { id: "asc" }],
    take: AMUX_IDEA_PROGRESS_LIMIT,
    select: { id: true, requestId: true, state: true, submittedAt: true, cancelledAt: true },
  });
  if (ideas.length === 0) return [];
  const ideaIds = ideas.map((idea) => idea.id);
  const chunks = await tx.amuxIdeaAnalysisChunk.findMany({
    where: { ideaId: { in: ideaIds } },
    select: { ideaId: true, chunkIndex: true, state: true, coverageStatus: true, currentPreviewId: true },
  });
  const previewIds = chunks.flatMap((chunk) => chunk.currentPreviewId ? [chunk.currentPreviewId] : []);
  const previews = await tx.amuxIdeaTransferPreview.findMany({
    where: { id: { in: previewIds } }, select: { id: true, ideaId: true, state: true },
  });
  const holds = await tx.amuxIdeaAnalysisBudgetHold.findMany({
    where: { previewId: { in: previewIds } }, select: { previewId: true, status: true },
  });
  const proposed = await tx.amuxIdeaDraftUnit.groupBy({
    by: ["ideaId"], where: { ideaId: { in: ideaIds }, state: "proposed" }, _count: { _all: true },
  });
  const decisions = await tx.amuxIdeaUnitDecision.findMany({
    where: { ideaId: { in: ideaIds }, action: "register_card", state: "consumed",
      registeredWorkItemId: { not: null } },
    select: { ideaId: true, registeredWorkItemId: true },
  });
  const cardIds = decisions.flatMap((decision) => decision.registeredWorkItemId ? [decision.registeredWorkItemId] : []);
  const cards = await tx.amuxWorkItem.findMany({
    where: { id: { in: cardIds } },
    select: { id: true, cardType: true, status: true, reviewPrNumber: true, v4TerminalAt: true,
      displayKey: true, createdAt: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });

  const holdOf = new Map(holds.map((hold) => [hold.previewId, hold.status]));
  const previewOf = new Map(previews.map((preview) => [preview.id, preview.state]));
  const cardById = new Map(cards.map((card) => [card.id, card]));
  return ideas.map((idea) => {
    const own = decisions.filter((decision) => decision.ideaId === idea.id)
      .flatMap((decision) => {
        const card = decision.registeredWorkItemId ? cardById.get(decision.registeredWorkItemId) : undefined;
        return card ? [card] : [];
      })
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
    const progress = amuxIdeaProgress({
      state: idea.state,
      cancelled: idea.cancelledAt !== null,
      chunks: chunks.filter((chunk) => chunk.ideaId === idea.id).map((chunk) => ({
        chunkIndex: chunk.chunkIndex, state: chunk.state, coverageStatus: chunk.coverageStatus,
        previewState: chunk.currentPreviewId ? previewOf.get(chunk.currentPreviewId) ?? null : null,
        holdStatus: chunk.currentPreviewId ? holdOf.get(chunk.currentPreviewId) ?? null : null,
      })),
      proposedUnits: proposed.find((row) => row.ideaId === idea.id)?._count._all ?? 0,
      cards: own.map((card) => ({ cardType: card.cardType, status: card.status,
        reviewPrNumber: card.reviewPrNumber, terminal: card.v4TerminalAt !== null || card.status === "cancelled" })),
    });
    return {
      ...progress,
      ideaId: idea.id,
      requestId: idea.requestId,
      submittedAt: idea.submittedAt.toISOString(),
      displayKey: own.find((card) => card.displayKey)?.displayKey ?? null,
      reviewPullRequests: own.filter((card) => card.cardType !== "story" && card.v4TerminalAt === null &&
        card.status === "review" && card.reviewPrNumber !== null)
        .map((card) => ({ number: card.reviewPrNumber as number, displayKey: card.displayKey })),
    };
  });
}
