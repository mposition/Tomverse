import "server-only";
import type { Prisma } from "@prisma/client";
import { writeSystemAuditLog } from "@/lib/adminAudit";
import { AMUX_V22_RECOVERY_CHECKER_AUDIT_ACTOR,
  AMUX_V22_RECOVERY_CONTROLLER_AUDIT_ACTOR } from "@/lib/adminAuditSystemActors";

export function recordAmuxV22RecoveryEvidenceAudit(tx: Prisma.TransactionClient,
  evidenceId: string, metadata: Prisma.InputJsonObject) {
  return writeSystemAuditLog({ tx, systemActor: AMUX_V22_RECOVERY_CHECKER_AUDIT_ACTOR,
    action: "amux.v22.recovery.inspected", targetType: "AmuxV22TaskRecoveryEvidence",
    targetId: evidenceId, summary: "Recorded content-free fixed-host Task recovery evidence.",
    metadata });
}

export function recordAmuxV22SafeStopEvidenceAudit(tx: Prisma.TransactionClient,
  evidenceId: string, metadata: Prisma.InputJsonObject) {
  return writeSystemAuditLog({ tx, systemActor: AMUX_V22_RECOVERY_CONTROLLER_AUDIT_ACTOR,
    action: "amux.v22.recovery.safe_stop_reported",
    targetType: "AmuxV22TaskRecoveryEvidence", targetId: evidenceId,
    summary: "Recorded content-free root-controller legacy safe-stop evidence.",
    metadata });
}
