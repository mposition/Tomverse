import "server-only";
import type { Prisma } from "@prisma/client";
import { writeSystemAuditLog } from "@/lib/adminAudit";
import { AMUX_V22_RECOVERY_CHECKER_AUDIT_ACTOR,
  AMUX_V22_RECOVERY_CONTROLLER_AUDIT_ACTOR,
  AMUX_V22_API_MODEL_ACCESS_AUDIT_ACTOR } from "@/lib/adminAuditSystemActors";

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

export function recordAmuxV22ReadOnlyLaunchCheckAudit(tx: Prisma.TransactionClient,
  launchCheckId: string, metadata: Prisma.InputJsonObject) {
  return writeSystemAuditLog({ tx, systemActor: AMUX_V22_RECOVERY_CONTROLLER_AUDIT_ACTOR,
    action: "amux.v22.recovery.read_only_launch_requested",
    targetType: "AmuxV22ReadOnlyLaunchCheck", targetId: launchCheckId,
    summary: "Recorded one content-free read-only retry launch preflight request.",
    metadata });
}

export function recordAmuxV22ReadOnlyLaunchProofAudit(tx: Prisma.TransactionClient,
  launchProofId: string, metadata: Prisma.InputJsonObject) {
  return writeSystemAuditLog({ tx, systemActor: AMUX_V22_RECOVERY_CONTROLLER_AUDIT_ACTOR,
    action: "amux.v22.recovery.read_only_launch_observed",
    targetType: "AmuxV22ReadOnlyLaunchProof", targetId: launchProofId,
    summary: "Recorded one trusted root read-only retry launch preflight observation.",
    metadata });
}

export function recordAmuxV22ApiModelAccessEvidenceAudit(
  tx: Prisma.TransactionClient, evidenceId: string,
  metadata: Prisma.InputJsonObject,
) {
  return writeSystemAuditLog({ tx,
    systemActor: AMUX_V22_API_MODEL_ACCESS_AUDIT_ACTOR,
    action: "amux.v22.recovery.api_model_access_observed",
    targetType: "AmuxV22ApiModelAccessEvidence", targetId: evidenceId,
    summary: "Recorded one content-free FIRST recovery API model-access observation.",
    metadata });
}
