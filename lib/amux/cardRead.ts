import "server-only";

import {
  AMUX_CARD_READ_MAX_DEPENDENCIES,
  classifyAmuxCardReadRows,
  type AmuxCardReadResult,
} from "@/lib/amux/cardReadCore";
import { BOARD_IMPORT_CANONICAL_SOURCE_SYSTEM } from "@/lib/amux/boardImportCore";
import { prisma } from "@/lib/prisma";

/** Exact, bounded, read-only lookup. The query intentionally has no writer or audit dependency. */
export async function readAmuxCardBySourceKey(
  sourceKey: string,
): Promise<AmuxCardReadResult> {
  const rows = await prisma.amuxWorkItem.findMany({
    where: {
      sourceSystem: BOARD_IMPORT_CANONICAL_SOURCE_SYSTEM,
      sourceKey,
    },
    orderBy: [{ sourceSystem: "asc" }, { id: "asc" }],
    take: 2,
    select: {
      id: true,
      status: true,
      priority: true,
      archivedAt: true,
      sourceSystem: true,
      sourceKey: true,
      sourceVersion: true,
      sourceDigest: true,
      sourceSnapshot: true,
      acceptedSourceRevision: {
        select: {
          id: true,
          workItemId: true,
          sourceVersion: true,
          detailDigest: true,
          sectionCode: true,
          state: true,
          observedAt: true,
          decidedAt: true,
        },
      },
      dependencies: {
        take: AMUX_CARD_READ_MAX_DEPENDENCIES + 1,
        select: {
          dependency: {
            select: {
              id: true,
              status: true,
              priority: true,
              archivedAt: true,
              sourceSystem: true,
              sourceKey: true,
            },
          },
        },
      },
    },
  });

  return classifyAmuxCardReadRows(rows, sourceKey);
}
