import "server-only";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  boardImportStoredSnapshot,
  type BoardImportExistingCard,
  type BoardImportItem,
} from "@/lib/amux/boardImportCore";

type CardDb = Prisma.TransactionClient | typeof prisma;

/**
 * Read path for preview and for the apply-time reclassification.
 *
 * Selects provenance and child counts only. Titles, descriptions, prompts
 * and delivery payloads are not loaded. This module does not open a
 * transaction and does not write.
 */
export async function loadBoardImportExistingCards(
  db: CardDb,
  items: readonly BoardImportItem[],
): Promise<BoardImportExistingCard[]> {
  if (items.length === 0) return [];
  const rows = await db.amuxWorkItem.findMany({
    where: {
      OR: items.map((item) => ({
        sourceSystem: item.sourceSystem,
        sourceKey: item.sourceKey,
      })),
    },
    select: {
      sourceSystem: true,
      sourceKey: true,
      sourceVersion: true,
      sourceDigest: true,
      sourceSnapshot: true,
      status: true,
      owner: true,
      claimedAt: true,
      executionAttempts: {
        select: { id: true, delivery: { select: { attemptId: true } } },
      },
      routeDecisions: { select: { id: true } },
    },
  });
  return rows.flatMap((row) => {
    if (!row.sourceSystem || !row.sourceKey) return [];
    return [
      {
        sourceSystem: row.sourceSystem,
        sourceKey: row.sourceKey,
        sourceVersion: row.sourceVersion ?? "",
        sourceDigest: row.sourceDigest ?? "",
        sourceSnapshot: boardImportStoredSnapshot(row.sourceSnapshot),
        status: row.status,
        owner: row.owner,
        claimedAt: row.claimedAt ? row.claimedAt.toISOString() : null,
        attemptCount: row.executionAttempts.length,
        deliveryCount: row.executionAttempts.filter((attempt) => attempt.delivery).length,
        routeDecisionCount: row.routeDecisions.length,
      },
    ];
  });
}
