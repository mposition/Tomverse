import { amuxV22TaskWritesPatch } from "./v22WorkerClaimCore.ts";
import { deriveAmuxIdeaUnitConfirmation,
  sameAmuxIdeaUnitConfirmation,
  type AmuxIdeaUnitConfirmationSnapshot } from
  "./ideaUnitConfirmationCore.ts";
import { type AmuxUnitDecisionAuditRow, amuxUnitDecisionAuditActorValid } from
  "./ideaSystemRegistrationCore.ts";

type ConsentEvidence = {
  cardId: string;
  sourceSystem: string | null;
  cardType: string | null;
  taskRole: string | null;
  sourceApprovalId: string | null;
  decision: {
    id: string; ideaId: string; state: string; action: string;
    actorUserId: string; registeredWorkItemId: string | null;
    confirmationDigest: string; confirmationDigestKeyId: string; confirmationSnapshot: unknown;
    finalAuditLogId: string | null;
  } | null;
  audit: (AmuxUnitDecisionAuditRow & { id: string }) | null;
  /** The idea's v19 plan registration audit when a system row consumed it. */
  planRegistrationAudit: AmuxUnitDecisionAuditRow | null;
  digestKey: { digestKeyId: string; digestKey: Buffer };
};

/** A separate, default-off owner consent. This is only one precondition for
 * T1: it never makes a patch safe, issues a capability, or authorizes a push. */
export function amuxV22PublicPrConsentAllowed(input: ConsentEvidence): boolean {
  const { decision, audit } = input;
  if (input.sourceSystem !== "admin-idea-v4" ||
      input.cardType !== "task" || !amuxV22TaskWritesPatch(input.taskRole) ||
      !decision || !audit || input.sourceApprovalId !== decision.id ||
      decision.action !== "register_card" || decision.state !== "consumed" ||
      decision.registeredWorkItemId !== input.cardId ||
      decision.confirmationDigestKeyId !== input.digestKey.digestKeyId ||
      decision.finalAuditLogId !== audit.id ||
      audit.action !== "amux.v4.unit.consume" ||
      !amuxUnitDecisionAuditActorValid({ audit, decision,
        planRegistrationAudit: input.planRegistrationAudit }) ||
      audit.targetType !== "AmuxIdeaUnitDecision" ||
      audit.targetId !== decision.id || !audit.entryHash ||
      !/^[a-f0-9]{64}$/.test(audit.entryHash)) return false;
  const snapshot = decision.confirmationSnapshot as
    AmuxIdeaUnitConfirmationSnapshot | null;
  if (!snapshot || snapshot.action !== "register_card" ||
      snapshot.decisionId !== decision.id ||
      snapshot.actorUserId !== decision.actorUserId ||
      snapshot.card?.cardType !== "task" ||
      !snapshot.card.task || !amuxV22TaskWritesPatch(snapshot.card.task.role) ||
      snapshot.card.task.publicPrDisclosureApproved !== true ||
      !snapshot.duplicates) return false;
  const metadata = audit.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata) ||
      (metadata as Record<string, unknown>).cardId !== input.cardId ||
      (metadata as Record<string, unknown>).confirmationDigest !==
        decision.confirmationDigest ||
      (metadata as Record<string, unknown>).publicPrDisclosureApproved !== true) {
    return false;
  }
  const verified = deriveAmuxIdeaUnitConfirmation(snapshot, input.digestKey,
    snapshot.duplicates, { ok: true, receipt: snapshot.card.task.costReceipt });
  return verified.ok && sameAmuxIdeaUnitConfirmation(
    verified.confirmationDigest, decision.confirmationDigest);
}
