import "server-only";

import type { Session } from "next-auth";

import { writeAdminAuditLog } from "@/lib/adminAudit";
import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { prisma } from "@/lib/prisma";
import { BoardImportError } from "./boardImportCore.ts";
import { OWNER_TRANSACTION_LIMITS, withAutoTransaction } from
  "./autoPromotionService.ts";
import type { AmuxV22ClaimLane } from "./v22WorkerClaimCore.ts";

/** Read-back for a lost declaration response. A retry is never inferred from
 * the transport failure; the operator compares the latest sequence first. */
export async function readV22LaneDecision(taskId: string) {
  const card = await prisma.amuxWorkItem.findUnique({ where: { id: taskId },
    select: { sourceSystem: true, cardType: true, status: true,
      owner: true, v22AssignmentId: true },
  });
  if (!card || card.sourceSystem !== "admin-idea-v4" ||
      card.cardType !== "task") throw new BoardImportError("not_found", 404);
  const latest = await prisma.amuxV22LaneDecision.findFirst({
    where: { workItemId: taskId }, orderBy: { sequence: "desc" },
    select: { sequence: true, lane: true, decidedAt: true },
  });
  return { taskId, lane: latest?.lane ?? "normal",
    sequence: latest?.sequence.toString() ?? null,
    decidedAt: latest?.decidedAt.toISOString() ?? null,
    status: card.status, assigned: card.v22AssignmentId !== null,
    workerName: card.owner };
}

/** A normal decision clears a prior declaration; no audit row is rewritten. */
export async function declareV22Lane(input: { session: Session; request: Request;
  taskId: string; lane: AmuxV22ClaimLane;
  expectedLaneSequence: string | null }) {
  const actorUserId = input.session.user?.id;
  if (!actorUserId || !isAdminSession(input.session) ||
      getAdminRole(input.session) !== "owner") {
    throw new BoardImportError("forbidden", 403);
  }
  return withAutoTransaction(input.taskId, OWNER_TRANSACTION_LIMITS,
    async (tx, now) => {
      const card = await tx.amuxWorkItem.findUnique({ where: { id: input.taskId },
        select: { sourceSystem: true, cardType: true, status: true,
          archivedAt: true, owner: true, claimedAt: true, v22ReceiptId: true } });
      if (!card || card.sourceSystem !== "admin-idea-v4" ||
          card.cardType !== "task" || card.status !== "todo" ||
          card.archivedAt || card.owner || card.claimedAt ||
          !card.v22ReceiptId) throw new BoardImportError("not_unassigned_todo", 409);
      const latest = await tx.amuxV22LaneDecision.findFirst({
        where: { workItemId: input.taskId }, orderBy: { sequence: "desc" },
        select: { sequence: true },
      });
      if ((latest?.sequence.toString() ?? null) !== input.expectedLaneSequence) {
        throw new BoardImportError("lane_changed", 409);
      }
      const rows = await tx.$queryRaw<Array<{ sequence: bigint }>>`
        SELECT nextval(pg_get_serial_sequence('"AmuxV22LaneDecision"', 'sequence'))
          AS sequence`;
      const sequence = rows[0]?.sequence;
      if (sequence === undefined) throw new BoardImportError("lane_unavailable", 503);
      const auditId = await writeAdminAuditLog({ tx, session: input.session,
        request: input.request, action: "amux.v22.lane.declared",
        targetType: "AmuxV22LaneDecision", targetId: sequence.toString(),
        summary: "Declared an AMUX v22 Task assignment lane.",
        metadata: { taskId: input.taskId, lane: input.lane,
          previousSequence: input.expectedLaneSequence },
      });
      await tx.amuxV22LaneDecision.create({ data: { sequence,
        workItemId: input.taskId, lane: input.lane,
        approvedByUserId: actorUserId, authorizationAuditLogId: auditId,
        decidedAt: now } });
      return { taskId: input.taskId, lane: input.lane,
        sequence: sequence.toString(), auditId };
    });
}
