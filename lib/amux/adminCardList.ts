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
 */

export const AMUX_ADMIN_CARD_LIST_LIMIT = 200;

const STATUS_ORDER = ["doing", "review", "blocked", "todo", "backlog", "done", "cancelled"];

export type AmuxAdminCardRow = {
  id: string;
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

export async function listAmuxCardsForAdmin(): Promise<{
  rows: AmuxAdminCardRow[];
  total: number;
  limit: number;
}> {
  const [total, cards] = await Promise.all([
    prisma.amuxWorkItem.count({ where: { archivedAt: null } }),
    prisma.amuxWorkItem.findMany({
      where: { archivedAt: null },
      orderBy: [{ updatedAt: "desc" }],
      take: AMUX_ADMIN_CARD_LIST_LIMIT,
      select: {
        id: true,
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
        _count: { select: { executionAttempts: true } },
        executionAttempts: {
          // attemptNumber is null on historical rows; start time orders every row.
          orderBy: [{ startedAt: "desc" }],
          take: 1,
          select: { outcome: true, toStatus: true },
        },
      },
    }),
  ]);
  const rank = (status: string) => {
    const index = STATUS_ORDER.indexOf(status);
    return index === -1 ? STATUS_ORDER.length : index;
  };
  const rows = cards
    .map((card) => ({
      id: card.id,
      sourceKey: card.sourceKey,
      status: card.status,
      owner: card.owner,
      kind: card.kind,
      priority: card.priority,
      revision: card.revision,
      briefPresent: card.executionBriefDigest !== null,
      requiresHumanReview: card.requiresHumanReview,
      reviewPrNumber: card.reviewPrNumber,
      attemptCount: card._count.executionAttempts,
      lastAttemptOutcome: card.executionAttempts[0]?.outcome ?? null,
      lastAttemptToStatus: card.executionAttempts[0]?.toStatus ?? null,
      updatedAt: card.updatedAt.toISOString(),
    }))
    .sort(
      (left, right) =>
        rank(left.status) - rank(right.status) ||
        (left.sourceKey ?? left.id).localeCompare(right.sourceKey ?? right.id),
    );
  return { rows, total, limit: AMUX_ADMIN_CARD_LIST_LIMIT };
}
