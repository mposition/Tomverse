import "server-only";
import type { Prisma } from "@prisma/client";
import { writeSystemAuditLog } from "@/lib/adminAudit";
import { auditRowActorKind, SYSTEM_AUDIT_ACTOR_METADATA_KEY,
  AMUX_V22_RECOVERY_CHECKER_AUDIT_ACTOR,
  AMUX_V22_RECOVERY_CONTROLLER_AUDIT_ACTOR,
  AMUX_V22_API_MODEL_ACCESS_AUDIT_ACTOR,
  AMUX_V22_RECOVERY_PREAPPROVAL_AUDIT_ACTOR } from "@/lib/adminAuditSystemActors";

/** A system audit row written by the pre-approval actor, not merely by a system. */
export async function preApprovalSystemAuditBound(tx: Prisma.TransactionClient, auditId: string,
  action: string, targetType: string, targetId: string) {
  const row = await tx.adminAuditLog.findUnique({ where: { id: auditId } });
  const metadata = row?.metadata;
  return !!row?.entryHash && row.action === action && row.targetType === targetType &&
    row.targetId === targetId && auditRowActorKind(row) === "system" &&
    !!metadata && typeof metadata === "object" && !Array.isArray(metadata) &&
    (metadata as Record<string, unknown>)[SYSTEM_AUDIT_ACTOR_METADATA_KEY] ===
      AMUX_V22_RECOVERY_PREAPPROVAL_AUDIT_ACTOR;
}

/** The approval an owner's one-click pre-approval opened, never a new consent. */
export function recordAmuxV22PreApprovalAppliedAudit(tx: Prisma.TransactionClient,
  approvalId: string, metadata: Prisma.InputJsonObject) {
  return writeSystemAuditLog({ tx, systemActor: AMUX_V22_RECOVERY_PREAPPROVAL_AUDIT_ACTOR,
    action: "amux.v22.recovery.preapproval_applied",
    targetType: "AmuxV22TaskRecoveryApproval", targetId: approvalId,
    summary: "Opened one additional capped Task attempt from the owner's own pre-approval after verified stop evidence.",
    metadata });
}

/** The one outcome of a pre-approval: applied, or refused with its reason. */
export function recordAmuxV22PreApprovalSettledAudit(tx: Prisma.TransactionClient,
  resultId: string, metadata: Prisma.InputJsonObject) {
  return writeSystemAuditLog({ tx, systemActor: AMUX_V22_RECOVERY_PREAPPROVAL_AUDIT_ACTOR,
    action: "amux.v22.recovery.preapproval_settled",
    targetType: "AmuxV22TaskRecoveryPreApprovalResult", targetId: resultId,
    summary: "Recorded the single outcome of an owner's Task recovery pre-approval.",
    metadata });
}

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
