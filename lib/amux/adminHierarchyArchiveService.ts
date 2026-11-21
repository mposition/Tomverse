import "server-only";

import { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { takeAuditChainLock, writeAdminAuditLog } from "@/lib/adminAudit";
import { prisma } from "@/lib/prisma";
import {
  AMUX_HIERARCHY_ARCHIVE_ACTION, AmuxHierarchyArchiveRefusal,
  amuxHierarchyArchiveEnabled,
} from "./adminHierarchyCore.ts";
import { readAmuxHierarchyRollups } from "./adminHierarchyRollupStore.ts";

const LEVEL_ORDER = ["feature", "epic", "initiative"] as const;

/**
 * Owner clean-up (owner decision 2026-11-21): archive hierarchies that have no
 * work left, each with its active Epics and Features, in one transaction.
 *
 * Archive is one-way. The database sets `archivedAt` and starts the 90-day
 * content clock (docs/policy/amux-intake.md section 8), refuses reactivation,
 * and refuses to archive a node with an active child or a Feature with an open
 * card. The same checks run here first so a refusal names the reason; the
 * database guard stays the backstop. Children are archived before parents
 * because the guard checks each row as it changes.
 *
 * Behind the default-off `AMUX_HIERARCHY_ARCHIVE_ENABLED` switch.
 */
export async function archiveAmuxHierarchyNodes(input: {
  session: Session; request: Request; nodeIds: string[];
}) {
  if (!amuxHierarchyArchiveEnabled(process.env))
    throw new AmuxHierarchyArchiveRefusal("disabled", null);
  const named = [...new Set(input.nodeIds)];
  return prisma.$transaction(async (tx) => {
    // Audit chain before the node rows (lib/adminAudit.ts takeAuditChainLock).
    await takeAuditChainLock(tx);
    const locked = await tx.$queryRaw<Array<{ id: string; state: string; level: string }>>`
      SELECT "id", "state", "level" FROM "AmuxPortfolioNode"
      WHERE "id" = ANY(${named}::text[]) ORDER BY "id" FOR UPDATE
    `;
    const lockedById = new Map(locked.map((row) => [row.id, row]));
    for (const id of named) {
      const row = lockedById.get(id);
      if (!row) throw new AmuxHierarchyArchiveRefusal("not_found", id);
      if (row.state !== "active") throw new AmuxHierarchyArchiveRefusal("not_active", id);
    }
    const subtree = await tx.$queryRaw<Array<{ rootId: string; id: string; level: string }>>`
      WITH RECURSIVE descendants("rootId", "id", "level", "depth") AS (
        SELECT "id", "id", "level", 0 FROM "AmuxPortfolioNode"
        WHERE "id" = ANY(${named}::text[])
        UNION ALL
        SELECT d."rootId", child."id", child."level", d."depth" + 1
        FROM descendants d
        JOIN "AmuxPortfolioNode" child ON child."parentId" = d."id"
        WHERE child."state" = 'active' AND d."depth" < 2
      ) SELECT "rootId", "id", "level" FROM descendants
    `;
    const all = [...new Map(subtree.map((row) => [row.id, row])).values()];
    const allIds = all.map((row) => row.id);
    await tx.$queryRaw`
      SELECT "id" FROM "AmuxPortfolioNode"
      WHERE "id" = ANY(${allIds}::text[]) ORDER BY "id" FOR UPDATE
    `;
    // Every card under the subtree, Story-linked Tasks included, is locked
    // before the work is counted: the database guard sees only cards directly
    // under a Feature, so without this a Task reopened under a Story between
    // the count and the archive would be archived with work left. A new card
    // waits on these locks (its parent key), and so does any status change.
    await tx.$queryRaw`
      SELECT card."id" FROM "AmuxWorkItem" card
      WHERE card."parentFeatureNodeId" = ANY(${allIds}::text[])
        OR card."parentStoryCardId" IN (
          SELECT story."id" FROM "AmuxWorkItem" story
          WHERE story."parentFeatureNodeId" = ANY(${allIds}::text[]))
      ORDER BY card."id" FOR UPDATE
    `;
    const rollups = await readAmuxHierarchyRollups(tx, named);
    for (const id of named) {
      const rollup = rollups.get(id)!;
      if (rollup.remaining > 0) throw new AmuxHierarchyArchiveRefusal("remaining_work", id);
      if (rollup.openCards > 0) throw new AmuxHierarchyArchiveRefusal("open_cards", id);
    }
    for (const level of LEVEL_ORDER) {
      const ids = all.filter((row) => row.level === level).map((row) => row.id);
      if (ids.length) await tx.amuxPortfolioNode.updateMany({
        where: { id: { in: ids }, state: "active" }, data: { state: "archived" } });
    }
    const after = await tx.amuxPortfolioNode.findMany({
      where: { id: { in: all.map((row) => row.id) } },
      select: { id: true, state: true, archivedAt: true, contentPurgeAfter: true } });
    if (after.length !== all.length || after.some((row) => row.state !== "archived" ||
        !row.archivedAt || !row.contentPurgeAfter))
      throw new Error("hierarchy archive readback did not match");
    const afterById = new Map(after.map((row) => [row.id, row]));
    const archived = [];
    for (const id of named) {
      const members = subtree.filter((row) => row.rootId === id).map((row) => row.id);
      const rollup = rollups.get(id)!;
      const at = afterById.get(id)!;
      await writeAdminAuditLog({ tx, session: input.session, request: input.request,
        action: AMUX_HIERARCHY_ARCHIVE_ACTION, targetType: "AmuxPortfolioNode", targetId: id,
        summary: `Archived an AMUX ${lockedById.get(id)!.level} with ${members.length - 1} ` +
          "active descendant hierarchy nodes from the execution board.",
        metadata: { nodeId: id, level: lockedById.get(id)!.level, archivedNodeIds: members,
          tasksDone: rollup.done, tasksCancelled: rollup.cancelled,
          archivedAt: at.archivedAt!.toISOString(),
          contentPurgeAfter: at.contentPurgeAfter!.toISOString() } });
      archived.push({ nodeId: id, archivedNodeIds: members,
        archivedAt: at.archivedAt!.toISOString(),
        contentPurgeAfter: at.contentPurgeAfter!.toISOString() });
    }
    return { archived };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 30_000 });
}
