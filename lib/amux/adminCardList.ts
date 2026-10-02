import "server-only";

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { encodeAmuxAdminCardCursor,
  type AmuxAdminCardCursor } from "./adminCardCursorCore.ts";
import { amuxHasOwnerAttentionEscalation,
  amuxLegacyTodoClaimVerified } from "./adminKanbanCore.ts";

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
  cardType: string | null;
  parentFeatureNodeId: string | null;
  parentStoryCardId: string | null;
  status: string;
  owner: string | null;
  claimVerified: boolean;
  kind: string;
  priority: string;
  revision: number;
  briefPresent: boolean;
  requiresHumanReview: boolean;
  hasOwnerAttentionEscalation: boolean;
  reviewPrNumber: number | null;
  attemptCount: number;
  lastAttemptOutcome: string | null;
  lastAttemptToStatus: string | null;
  updatedAt: string;
};

export type AmuxAdminHierarchyNode = {
  id: string;
  level: string;
  parentId: string | null;
  state: string;
};

export async function listAmuxCardsForAdmin(cursor: AmuxAdminCardCursor | null = null): Promise<{
  rows: AmuxAdminCardRow[];
  hierarchyNodes: AmuxAdminHierarchyNode[];
  total: number;
  limit: number;
  nextCursor: string | null;
}> {
  const where: Prisma.AmuxWorkItemWhereInput = cursor ? {
    archivedAt: null,
    OR: [
      { updatedAt: { lt: cursor.updatedAt } },
      { updatedAt: cursor.updatedAt, id: { lt: cursor.id } },
    ],
  } : { archivedAt: null };
  const [total, fetched] = await Promise.all([
    prisma.amuxWorkItem.count({ where: { archivedAt: null } }),
    prisma.amuxWorkItem.findMany({
      where,
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: AMUX_ADMIN_CARD_LIST_LIMIT + 1,
      select: {
        id: true,
        sourceKey: true,
        cardType: true,
        parentFeatureNodeId: true,
        parentStoryCardId: true,
        status: true,
        owner: true,
        claimedAt: true,
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
  const cards = fetched.slice(0, AMUX_ADMIN_CARD_LIST_LIMIT);
  const featureIds = [...new Set(cards.flatMap((card) =>
    card.parentFeatureNodeId ? [card.parentFeatureNodeId] : []))];
  const features = featureIds.length ? await prisma.amuxPortfolioNode.findMany({
    where: { id: { in: featureIds } },
    select: { id: true, level: true, parentId: true, state: true },
  }) : [];
  const epicIds = [...new Set(features.flatMap((node) => node.parentId ? [node.parentId] : []))];
  const epics = epicIds.length ? await prisma.amuxPortfolioNode.findMany({
    where: { id: { in: epicIds } },
    select: { id: true, level: true, parentId: true, state: true },
  }) : [];
  const initiativeIds = [...new Set(epics.flatMap((node) => node.parentId ? [node.parentId] : []))];
  const initiatives = initiativeIds.length ? await prisma.amuxPortfolioNode.findMany({
    where: { id: { in: initiativeIds } },
    select: { id: true, level: true, parentId: true, state: true },
  }) : [];
  const hierarchyNodes = [...new Map([...features, ...epics, ...initiatives]
    .map((node) => [node.id, node])).values()];
  const last = cards.at(-1);
  const nextCursor = fetched.length > AMUX_ADMIN_CARD_LIST_LIMIT && last
    ? encodeAmuxAdminCardCursor({ updatedAt: last.updatedAt, id: last.id }) : null;
  const ids = cards.map((card) => card.id);
  // Set queries for the whole page, not one per card: a nested `take` on
  // a to-many relation is loaded per parent row.
  const [counts, latest, routes, escalations] = ids.length === 0
    ? [[], [], [], []]
    : await Promise.all([
        prisma.amuxExecutionAttempt.groupBy({
          by: ["taskId"],
          where: { taskId: { in: ids } },
          _count: { _all: true },
        }),
        // attemptNumber is null on historical rows; start time orders every row.
        prisma.$queryRaw<Array<{ taskId: string; outcome: string | null; toStatus: string | null }>>`
          SELECT DISTINCT ON ("taskId") "taskId", "outcome", "toStatus"
          FROM "AmuxExecutionAttempt"
          WHERE "taskId" = ANY(${ids}::text[])
          ORDER BY "taskId", "startedAt" DESC
        `,
        prisma.$queryRaw<Array<{ taskId: string; worker: string; taskRevision: number }>>`
          SELECT DISTINCT ON ("taskId") "taskId", "worker", "taskRevision"
          FROM "AmuxRouteDecision"
          WHERE "taskId" = ANY(${ids}::text[])
          ORDER BY "taskId", "createdAt" DESC, "id" DESC
        `,
        prisma.amuxHumanEscalation.findMany({
          where: { taskId: { in: ids }, status: { in: ["open", "acknowledged"] } },
          select: { taskId: true, reason: true },
        }),
      ]);
  const countByTask = new Map(counts.map((row) => [row.taskId, row._count._all]));
  const latestByTask = new Map(latest.map((row) => [row.taskId, row]));
  const routeByTask = new Map(routes.map((row) => [row.taskId, row]));
  const escalationReasonsByTask = new Map<string, string[]>();
  for (const row of escalations) {
    const reasons = escalationReasonsByTask.get(row.taskId) ?? [];
    reasons.push(row.reason);
    escalationReasonsByTask.set(row.taskId, reasons);
  }
  const rank = (status: string) => {
    const index = STATUS_ORDER.indexOf(status);
    return index === -1 ? STATUS_ORDER.length : index;
  };
  const rows = cards
    .map((card) => ({
      id: card.id,
      sourceKey: card.sourceKey,
      cardType: card.cardType,
      parentFeatureNodeId: card.parentFeatureNodeId,
      parentStoryCardId: card.parentStoryCardId,
      status: card.status,
      owner: card.owner,
      claimVerified: amuxLegacyTodoClaimVerified(card, routeByTask.get(card.id) ?? null),
      kind: card.kind,
      priority: card.priority,
      revision: card.revision,
      briefPresent: card.executionBriefDigest !== null,
      requiresHumanReview: card.requiresHumanReview,
      hasOwnerAttentionEscalation: amuxHasOwnerAttentionEscalation(card.status,
        escalationReasonsByTask.get(card.id) ?? []),
      reviewPrNumber: card.reviewPrNumber,
      attemptCount: countByTask.get(card.id) ?? 0,
      lastAttemptOutcome: latestByTask.get(card.id)?.outcome ?? null,
      lastAttemptToStatus: latestByTask.get(card.id)?.toStatus ?? null,
      updatedAt: card.updatedAt.toISOString(),
    }))
    .sort(
      (left, right) =>
        rank(left.status) - rank(right.status) ||
        (left.sourceKey ?? left.id).localeCompare(right.sourceKey ?? right.id),
    );
  return { rows, hierarchyNodes, total, limit: AMUX_ADMIN_CARD_LIST_LIMIT, nextCursor };
}
