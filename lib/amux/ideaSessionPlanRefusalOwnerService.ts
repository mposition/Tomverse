import "server-only";

import type { Session } from "next-auth";

import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { takeAuditChainLock, writeAdminAuditLog } from "@/lib/adminAudit";
import { AMUX_DB_BOUNDARIES, withAmuxDbBoundary } from "@/lib/amux/dbBoundary";
import { BoardImportError } from "./boardImportCore.ts";
import type { AmuxPlanRefusalDecision } from "./ideaSessionPlanRefusalCore.ts";
import { AMUX_PLAN_REFUSAL_AUDIT_TARGET, AMUX_PLAN_REFUSAL_DECIDED_ACTION,
  decideAmuxPlanRefusalInTx } from "./ideaSessionPlanRefusalService.ts";

const REFUSAL_ID = /^[0-9a-f-]{36}$/;

/** The owner's own decision from the idea's Admin detail, also the way out
 * when the Decision Maker is off or routed the card to the operator. */
export async function decideAmuxPlanRefusalAsOwner(input: { session: Session;
  request: Request; ideaId: string; refusalId: string;
  decision: AmuxPlanRefusalDecision }) {
  const actorUserId = input.session.user?.id;
  if (!actorUserId || !isAdminSession(input.session) ||
      getAdminRole(input.session) !== "owner" || !REFUSAL_ID.test(input.refusalId)) {
    throw new BoardImportError("forbidden", 403);
  }
  return withAmuxDbBoundary(AMUX_DB_BOUNDARIES.amuxPlanRefusalOwnerDecision,
    async (tx, context) => {
      await takeAuditChainLock(tx);
      const owned = await tx.amuxIdeaSessionPlanRefusal.findUnique({
        where: { id: input.refusalId }, select: { ideaId: true } });
      if (owned?.ideaId !== input.ideaId) throw new BoardImportError("not_found", 404);
      const result = await decideAmuxPlanRefusalInTx(tx, { refusalId: input.refusalId,
        decision: input.decision, source: "operator",
        decidedByUserId: actorUserId, now: context.dbNow,
        audit: (ideaId) => writeAdminAuditLog({ tx, session: input.session,
          request: input.request, action: AMUX_PLAN_REFUSAL_DECIDED_ACTION,
          targetType: AMUX_PLAN_REFUSAL_AUDIT_TARGET, targetId: input.refusalId,
          summary: "Decided one refused session analysis answer.",
          metadata: { ideaId, decision: input.decision, source: "operator" } }) });
      if (!result.applied) throw new BoardImportError("not_open", 409);
      return result;
    });
}
