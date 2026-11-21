import "server-only";

import type { Prisma, PrismaClient } from "@prisma/client";

import {
  amuxHierarchyRollupFromRow, type AmuxHierarchyRollup, type AmuxHierarchyRollupRow,
} from "./adminHierarchyCore.ts";

type Db = Pick<PrismaClient, "$queryRaw"> | Pick<Prisma.TransactionClient, "$queryRaw">;

/**
 * One rollup per given hierarchy node over its active subtree (an Initiative
 * reaches its Epics and Features, an Epic its Features). A Task belongs to a
 * Feature directly or through a Story under that Feature, and is counted once.
 *
 * `openCards` repeats the database archive guard exactly: any card directly
 * under a Feature in the subtree whose status is neither done nor cancelled,
 * archived or not (migration 20261001102100, amux_portfolio_parent_guard).
 * Attention follows the board's attention lane: blocked, or an open escalation.
 */
export async function readAmuxHierarchyRollups(db: Db, ids: string[]):
  Promise<Map<string, AmuxHierarchyRollup>> {
  if (ids.length === 0) return new Map();
  const rows = await db.$queryRaw<Array<AmuxHierarchyRollupRow & { rootId: string }>>`
    WITH RECURSIVE descendants("rootId", "id", "depth") AS (
      SELECT "id", "id", 0 FROM "AmuxPortfolioNode"
      WHERE "id" = ANY(${ids}::text[])
      UNION ALL
      SELECT d."rootId", child."id", d."depth" + 1
      FROM descendants d
      JOIN "AmuxPortfolioNode" child ON child."parentId" = d."id"
      WHERE child."state" = 'active' AND d."depth" < 2
    ), linked AS (
      SELECT d."rootId", card."id",
        bool_or(card."parentFeatureNodeId" = d."id") AS "direct"
      FROM descendants d
      JOIN "AmuxWorkItem" card ON card."parentFeatureNodeId" = d."id"
        OR card."parentStoryCardId" IN (
          SELECT story."id" FROM "AmuxWorkItem" story
          WHERE story."parentFeatureNodeId" = d."id")
      GROUP BY d."rootId", card."id"
    ), facts AS (
      SELECT l."rootId", l."direct", card."cardType", card."status",
        card."archivedAt", card."updatedAt",
        (card."status" = 'blocked' OR EXISTS (
          SELECT 1 FROM "AmuxHumanEscalation" escalation
          WHERE escalation."taskId" = card."id"
            AND escalation."status" IN ('open', 'acknowledged'))) AS "attention"
      FROM linked l JOIN "AmuxWorkItem" card ON card."id" = l."id"
    )
    SELECT "rootId",
      COUNT(*) FILTER (WHERE "cardType" = 'task' AND "archivedAt" IS NULL
        AND "status" <> 'cancelled')::int AS "total",
      COUNT(*) FILTER (WHERE "cardType" = 'task' AND "archivedAt" IS NULL
        AND "status" = 'done')::int AS "done",
      COUNT(*) FILTER (WHERE "cardType" = 'task' AND "archivedAt" IS NULL
        AND "status" = 'cancelled')::int AS "cancelled",
      COUNT(*) FILTER (WHERE "cardType" = 'task' AND "archivedAt" IS NULL
        AND "status" NOT IN ('done', 'cancelled') AND "attention")::int AS "attention",
      COUNT(*) FILTER (WHERE "cardType" = 'task' AND "archivedAt" IS NULL
        AND NOT "attention" AND "status" = 'review')::int AS "review",
      COUNT(*) FILTER (WHERE "cardType" = 'task' AND "archivedAt" IS NULL
        AND NOT "attention" AND "status" = 'doing')::int AS "doing",
      COUNT(*) FILTER (WHERE "cardType" = 'task' AND "archivedAt" IS NULL
        AND NOT "attention" AND "status" = 'todo')::int AS "todo",
      COUNT(*) FILTER (WHERE "cardType" = 'task' AND "archivedAt" IS NULL
        AND NOT "attention" AND "status" = 'backlog')::int AS "backlog",
      COUNT(*) FILTER (WHERE "direct"
        AND "status" NOT IN ('done', 'cancelled'))::int AS "openCards",
      MAX("updatedAt") FILTER (WHERE "archivedAt" IS NULL) AS "lastActivityAt"
    FROM facts
    GROUP BY "rootId"
  `;
  const byRoot = new Map(rows.map((row) => [row.rootId, row]));
  return new Map(ids.map((id) => [id, amuxHierarchyRollupFromRow(byRoot.get(id))]));
}
