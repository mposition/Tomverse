import "server-only";

import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { writeAdminAuditLog } from "@/lib/adminAudit";
import { AMUX_V22_AUTO_PROMOTION_POLICY_VERSION } from
  "./v22AutoPromotionCore.ts";
import { readV22ExecutionMove, requestV22ExecutionMove } from
  "./v22AutoPromotionService.ts";

const DESTINATION = "amux_unassigned_todo";

/** Admin board boundary for the one approved move. The actual state change is
 * still owned by the canonical v22 automatic-admission writer. */
export function readAdminExecutionMove(taskId: string, requestId: string) {
  return readV22ExecutionMove(taskId, requestId);
}

export function moveAdminExecutionCard(input: {
  session: Session;
  request: Request;
  taskId: string;
  expectedRevision: number;
  requestId: string;
}) {
  const writeHumanIntent = (tx: Prisma.TransactionClient, taskId: string) =>
    writeAdminAuditLog({ tx, session: input.session, request: input.request,
      action: "amux.v22.execution_move.requested",
      targetType: "AmuxWorkItem", targetId: taskId,
      summary: "Requested one guarded AMUX backlog-to-Todo move.",
      metadata: { requestId: input.requestId,
        expectedRevision: input.expectedRevision,
        destination: DESTINATION,
        policyVersion: AMUX_V22_AUTO_PROMOTION_POLICY_VERSION },
    });
  return requestV22ExecutionMove({ ...input, writeHumanIntent });
}
