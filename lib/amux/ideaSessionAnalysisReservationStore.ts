import "server-only";

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";

import { takeAuditChainLock, writeSystemAuditLog } from "../adminAudit.ts";
import type { AmuxOperatingScopeAuthority } from "./ideaOperatingScopeStore.ts";
import {
  AMUX_SESSION_ANALYSIS_RESERVATION_AUDIT_SUMMARY,
  AMUX_SESSION_ANALYSIS_RESERVATION_STATUS,
  AMUX_SESSION_ANALYSIS_RESERVED_ACTION,
  AMUX_SESSION_ANALYSIS_RESERVED_TARGET,
  AMUX_SESSION_INTAKE_SYSTEM_AUDIT_ACTOR,
  amuxSessionAnalysisReservationAuditMetadata,
} from "./ideaSessionAnalysisReservationCore.ts";

export class AmuxSessionAnalysisReservationError extends Error {
  constructor(readonly code: "submission_unavailable" | "already_reserved") {
    super(code);
    this.name = "AmuxSessionAnalysisReservationError";
  }
}

export type CommittedAmuxSessionAnalysisReservation = {
  reservationId: string;
  ideaId: string;
  requestId: string;
  reservationAuditId: string;
};

/** Append one queue identity in the same transaction that inserted the session
 * submission. It reserves no money and grants no dispatch permission. */
export async function commitAmuxSessionAnalysisReservation(
  tx: Prisma.TransactionClient,
  input: {
    ideaId: string;
    requestId: string;
    submissionAuditId: string;
    authority: AmuxOperatingScopeAuthority;
  },
): Promise<CommittedAmuxSessionAnalysisReservation> {
  await takeAuditChainLock(tx);
  const rows = await tx.$queryRaw<Array<{
    id: string;
    actorUserId: string;
    requestId: string;
    submissionAuditLogId: string | null;
    sessionOperatingScopeSettingId: string | null;
  }>>`
    SELECT "id", "actorUserId", "requestId", "submissionAuditLogId",
           "sessionOperatingScopeSettingId"
    FROM "AmuxIdeaSubmission"
    WHERE "id" = ${input.ideaId}
      AND "submissionOrigin" = 'session'
      AND xmin = pg_current_xact_id()::xid
    FOR KEY SHARE
  `;
  const idea = rows[0];
  if (!idea || idea.requestId !== input.requestId ||
      idea.submissionAuditLogId !== input.submissionAuditId ||
      idea.actorUserId !== input.authority.approvedByUserId ||
      idea.sessionOperatingScopeSettingId !== input.authority.settingId) {
    throw new AmuxSessionAnalysisReservationError("submission_unavailable");
  }
  if (await tx.amuxIdeaSessionAnalysisReservation.findUnique({
    where: { ideaId: input.ideaId }, select: { id: true },
  })) {
    throw new AmuxSessionAnalysisReservationError("already_reserved");
  }

  const reservationId = randomUUID();
  const binding = {
    reservationId,
    ideaId: input.ideaId,
    requestId: input.requestId,
    submissionAuditId: input.submissionAuditId,
    operatingScopeSettingId: input.authority.settingId,
    dataOwnerUserId: input.authority.approvedByUserId,
    modelProvider: input.authority.scope.model.provider,
    modelId: input.authority.scope.model.modelId,
    reasoningEffort: input.authority.scope.model.reasoningEffort,
  };
  const reservationAuditId = await writeSystemAuditLog({
    tx,
    systemActor: AMUX_SESSION_INTAKE_SYSTEM_AUDIT_ACTOR,
    action: AMUX_SESSION_ANALYSIS_RESERVED_ACTION,
    targetType: AMUX_SESSION_ANALYSIS_RESERVED_TARGET,
    targetId: reservationId,
    summary: AMUX_SESSION_ANALYSIS_RESERVATION_AUDIT_SUMMARY,
    metadata: amuxSessionAnalysisReservationAuditMetadata(binding),
  });
  await tx.amuxIdeaSessionAnalysisReservation.create({ data: {
    id: reservationId,
    ideaId: input.ideaId,
    requestId: input.requestId,
    actorUserId: input.authority.approvedByUserId,
    operatingScopeSettingId: input.authority.settingId,
    status: AMUX_SESSION_ANALYSIS_RESERVATION_STATUS,
    modelProvider: input.authority.scope.model.provider,
    modelId: input.authority.scope.model.modelId,
    reasoningEffort: input.authority.scope.model.reasoningEffort,
    reservationAuditLogId: reservationAuditId,
  } });
  return { reservationId, ideaId: input.ideaId, requestId: input.requestId,
    reservationAuditId };
}
