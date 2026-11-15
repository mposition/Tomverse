import "server-only";

import { prisma } from "@/lib/prisma";

/**
 * Read-only card list for the owner console.
 *
 * The Tomverse database is the only place an AMUX card's status lives; the
 * local AMUX board never mirrors it. Before this list the only way to see a
 * promoted card was a database query. The rows carry identifiers and state,
 * never the brief, the description or any free text a worker could have
 * written.
 *
 * Owner decision 2026-11-15 (no display cap): the counts are the whole board's
 * (one grouped count), and the rows are the cards the caller names -- the page
 * the list shows -- so a card on any page has its state. It read the newest
 * 200 cards before, and counted only those.
 */

const STATUS_ORDER = ["doing", "review", "blocked", "todo", "backlog", "done", "cancelled"];

export type AmuxAdminCardRow = {
  id: string;
  displayKey: string | null;
  sourceKey: string | null;
  status: string;
  owner: string | null;
  kind: string;
  priority: string;
  revision: number;
  briefPresent: boolean;
  requiresHumanReview: boolean;
  reviewPrNumber: number | null;
  attemptCount: number;
  lastAttemptOutcome: string | null;
  lastAttemptToStatus: string | null;
  updatedAt: string;
};

export async function listAmuxCardsForAdmin(ids: readonly string[]): Promise<{
  rows: AmuxAdminCardRow[];
  total: number;
  /** Cards per stored status, over every card that is not archived. */
  statusCounts: Record<string, number>;
}> {
  const [grouped, cards] = await Promise.all([
    prisma.amuxWorkItem.groupBy({ by: ["status"], where: { archivedAt: null }, _count: { _all: true } }),
    ids.length === 0 ? [] : prisma.amuxWorkItem.findMany({
      where: { archivedAt: null, id: { in: [...ids] } },
      orderBy: [{ updatedAt: "desc" }],
      select: {
        id: true,
        displayKey: true,
        sourceKey: true,
        status: true,
        owner: true,
        kind: true,
        priority: true,
        revision: true,
        executionBriefDigest: true,
        requiresHumanReview: true,
        reviewPrNumber: true,
        updatedAt: true,
      },
    }),
  ]);
  const statusCounts = Object.fromEntries(grouped.map((row) => [row.status, row._count._all]));
  const total = grouped.reduce((sum, row) => sum + row._count._all, 0);
  const cardIds = cards.map((card) => card.id);
  // Two set queries for the whole page, not one per card: a nested `take` on
  // a to-many relation is loaded per parent row.
  const [counts, latest] = cardIds.length === 0
    ? [[], []]
    : await Promise.all([
        prisma.amuxExecutionAttempt.groupBy({
          by: ["taskId"],
          where: { taskId: { in: cardIds } },
          _count: { _all: true },
        }),
        // attemptNumber is null on historical rows; start time orders every row.
        prisma.$queryRaw<Array<{ taskId: string; outcome: string | null; toStatus: string | null }>>`
          SELECT DISTINCT ON ("taskId") "taskId", "outcome", "toStatus"
          FROM "AmuxExecutionAttempt"
          WHERE "taskId" = ANY(${cardIds}::text[])
          ORDER BY "taskId", "startedAt" DESC
        `,
      ]);
  const countByTask = new Map(counts.map((row) => [row.taskId, row._count._all]));
  const latestByTask = new Map(latest.map((row) => [row.taskId, row]));
  const rank = (status: string) => {
    const index = STATUS_ORDER.indexOf(status);
    return index === -1 ? STATUS_ORDER.length : index;
  };
  const rows = cards
    .map((card) => ({
      id: card.id,
      displayKey: card.displayKey,
      sourceKey: card.sourceKey,
      status: card.status,
      owner: card.owner,
      kind: card.kind,
      priority: card.priority,
      revision: card.revision,
      briefPresent: card.executionBriefDigest !== null,
      requiresHumanReview: card.requiresHumanReview,
      reviewPrNumber: card.reviewPrNumber,
      attemptCount: countByTask.get(card.id) ?? 0,
      lastAttemptOutcome: latestByTask.get(card.id)?.outcome ?? null,
      lastAttemptToStatus: latestByTask.get(card.id)?.toStatus ?? null,
      updatedAt: card.updatedAt.toISOString(),
    }))
    .sort(
      (left, right) =>
        rank(left.status) - rank(right.status) ||
        (left.displayKey ?? left.sourceKey ?? left.id).localeCompare(
          right.displayKey ?? right.sourceKey ?? right.id, undefined, { numeric: true }),
    );
  return { rows, total, statusCounts };
}
