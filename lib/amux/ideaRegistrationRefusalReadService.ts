import "server-only";

import type { Prisma } from "@prisma/client";

import { auditRowActorKind } from "@/lib/adminAuditSystemActors";
import { AMUX_V20_REGISTRATION_REFUSAL_ACTION,
  AMUX_V20_REGISTRATION_REFUSAL_TARGET,
  amuxV20RegistrationRefusalMetadata,
  amuxV20RegistrationRefusalView,
  isAmuxV20RegistrationRefusalAttemptKind,
  isAmuxV20RegistrationRefusalGrade,
  isAmuxRegistrationRefusalCode,
  matchesAmuxV20RegistrationRefusalMetadata,
  type AmuxV20RegistrationRefusalView } from
  "./ideaRegistrationRefusalCore.ts";

/** Owner-scoped metadata read for the analysis detail. Trigger-enforced audit
 * evidence is checked again before returning the latest waiting refusal. */
export async function readLatestAmuxV20RegistrationRefusalInTx(
  tx: Prisma.TransactionClient, ideaId: string, actorUserId: string,
  analysisPreviewId: string, sourcePlanRevisionId: string,
): Promise<AmuxV20RegistrationRefusalView | null> {
  const row = await tx.amuxIdeaRegistrationRefusal.findFirst({
    where: { ideaId, actorUserId, state: "awaiting_operator",
      analysisPreviewId, sourcePlanRevisionId,
      draftUnit: { state: "proposed" } },
    orderBy: [{ attemptedAt: "desc" }, { id: "desc" }],
    include: { auditLog: { select: { actorUserId: true, actorEmail: true,
      ipAddress: true, userAgent: true, action: true,
      targetType: true, targetId: true, metadata: true, entryHash: true } } },
  });
  if (!row) return null;
  const expected = amuxV20RegistrationRefusalMetadata(row);
  const actorKind = auditRowActorKind(row.auditLog);
  const metadata = row.auditLog.metadata &&
    typeof row.auditLog.metadata === "object" &&
    !Array.isArray(row.auditLog.metadata) ?
    { ...(row.auditLog.metadata as Record<string, unknown>) } : null;
  if (actorKind === "system" && metadata) {
    delete metadata.systemActor;
    delete metadata.actorScope;
  }
  if (!isAmuxV20RegistrationRefusalAttemptKind(row.attemptKind) ||
      !isAmuxRegistrationRefusalCode(row.refusalCode) ||
      (row.proposedExecutionGrade !== null &&
        !isAmuxV20RegistrationRefusalGrade(row.proposedExecutionGrade)) ||
      (row.finalExecutionGrade !== null &&
        !isAmuxV20RegistrationRefusalGrade(row.finalExecutionGrade)) ||
      !row.auditLog.entryHash ||
      (actorKind !== "system" &&
        (actorKind !== "human" || row.auditLog.actorUserId !== actorUserId)) ||
      row.auditLog.action !== AMUX_V20_REGISTRATION_REFUSAL_ACTION ||
      row.auditLog.targetType !== AMUX_V20_REGISTRATION_REFUSAL_TARGET ||
      row.auditLog.targetId !== row.id ||
      !matchesAmuxV20RegistrationRefusalMetadata(
        metadata, expected)) {
    throw new Error("AMUX v20 registration refusal evidence unavailable");
  }
  return amuxV20RegistrationRefusalView(row);
}
