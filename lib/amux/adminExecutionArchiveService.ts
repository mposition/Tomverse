import "server-only";

import type { Session } from "next-auth";

import { writeAdminAuditLog } from "@/lib/adminAudit";
import { prisma } from "@/lib/prisma";

/** Owner board clean-up: archive every card still on the board in one step.
 * Only `archivedAt` and `revision` change, so every card keeps its status,
 * ledgers and evidence, and leaves the Kanban lanes for the Archive drawer.
 * The revision bump makes any in-flight compare-and-set on these cards fail.
 * The audit entry records the shared timestamp, so the step can be undone with
 * `archivedAt = <archivedAt>`. */
export async function archiveAllAdminExecutionCards(input: {
  session: Session;
  request: Request;
}) {
  const archivedAt = new Date();
  return prisma.$transaction(async (tx) => {
    const { count } = await tx.amuxWorkItem.updateMany({
      where: { archivedAt: null },
      data: { archivedAt, revision: { increment: 1 } },
    });
    await writeAdminAuditLog({ tx, session: input.session, request: input.request,
      action: "amux.execution.archive_all",
      targetType: "AmuxWorkItem",
      summary: `Archived all ${count} active AMUX cards from the execution board.`,
      metadata: { archived: count, archivedAt: archivedAt.toISOString() },
    });
    return { archived: count, archivedAt: archivedAt.toISOString() };
  // Every row runs the card guards, deferred ones at commit.
  }, { timeout: 30_000 });
}
