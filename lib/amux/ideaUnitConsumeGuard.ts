import {
  sameAmuxIdeaUnitConfirmation,
  type AmuxIdeaUnitConfirmationResult,
} from "./ideaUnitConfirmationCore.ts";

/**
 * A dark, pure precondition for consuming one prepared v4 unit decision.
 * The caller must load the row and its stored prepare snapshot under the same
 * database transaction, derive `currentConfirmation` from freshly authorized
 * rows and server-owned scans/prices, and pass the database clock. This guard
 * does not write a card, node, audit, or decision row and cannot authorize a
 * caller-provided snapshot on its own. The SQL trigger is the final fence.
 */
export type PreparedAmuxIdeaUnitDecision = {
  id: string;
  ideaId: string;
  draftUnitId: string;
  actorUserId: string;
  state: "prepared" | "consumed" | "cancelled" | "invalidated" | "expired";
  preparedAt: Date;
  expiresAt: Date;
  outcomeUnknownAt: Date | null;
  ownerSessionDigest: string;
  ownerSessionDigestKeyId: string;
  confirmationDigest: string;
  confirmationDigestKeyId: string;
};

export type AmuxIdeaUnitConsumeContext = {
  decisionId: string;
  ideaId: string;
  draftUnitId: string;
  actorUserId: string;
  /** Caller-verified recent owner step-up bound to this actor and app session. */
  recentOwnerStepUp: boolean;
  /** Recomputed for the current browser session using the stored key ID. */
  ownerSessionDigest: string;
  ownerSessionDigestKeyId: string;
  /** Must be obtained with SELECT clock_timestamp() inside the transaction. */
  databaseNow: Date;
  currentConfirmation: AmuxIdeaUnitConfirmationResult;
};

export type AmuxIdeaUnitConsumeDecision =
  | { decision: "allow" }
  | { decision: "reject" | "reconfirm" | "halt"; reason: string };

const validDate = (value: unknown): value is Date =>
  value instanceof Date && Number.isFinite(value.getTime());
const nonEmptyId = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

export function checkAmuxIdeaUnitConsume(
  prepared: PreparedAmuxIdeaUnitDecision,
  current: AmuxIdeaUnitConsumeContext,
): AmuxIdeaUnitConsumeDecision {
  if (!prepared || !current) {
    return { decision: "halt", reason: "receipt_unavailable" };
  }
  if (![prepared.id, prepared.ideaId, prepared.draftUnitId, prepared.actorUserId,
    current.decisionId, current.ideaId, current.draftUnitId, current.actorUserId,
    prepared.ownerSessionDigestKeyId, current.ownerSessionDigestKeyId,
    prepared.confirmationDigestKeyId].every(nonEmptyId) ||
      prepared.id !== current.decisionId || prepared.ideaId !== current.ideaId ||
      prepared.draftUnitId !== current.draftUnitId ||
      prepared.actorUserId !== current.actorUserId) {
    return { decision: "reject", reason: "identity_mismatch" };
  }
  if (prepared.ownerSessionDigestKeyId !== current.ownerSessionDigestKeyId ||
      !sameAmuxIdeaUnitConfirmation(prepared.ownerSessionDigest, current.ownerSessionDigest)) {
    return { decision: "reject", reason: "session_mismatch" };
  }
  if (current.recentOwnerStepUp !== true) {
    return { decision: "reconfirm", reason: "owner_step_up_required" };
  }
  if (!validDate(current.databaseNow) || !validDate(prepared.preparedAt) ||
      !validDate(prepared.expiresAt)) {
    return { decision: "halt", reason: "clock_or_receipt_unavailable" };
  }
  if (prepared.outcomeUnknownAt !== null) {
    return { decision: "halt", reason: "outcome_unknown" };
  }
  if (prepared.state !== "prepared") {
    return { decision: "reject", reason: "not_prepared" };
  }
  if (prepared.expiresAt.getTime() - prepared.preparedAt.getTime() !== 15 * 60_000 ||
      current.databaseNow.getTime() < prepared.preparedAt.getTime()) {
    return { decision: "halt", reason: "receipt_clock_anomaly" };
  }
  if (current.databaseNow.getTime() >= prepared.expiresAt.getTime()) {
    return { decision: "reconfirm", reason: "receipt_expired" };
  }
  if (current.currentConfirmation?.ok !== true) {
    return { decision: "reconfirm", reason: "evidence_changed" };
  }
  if (prepared.confirmationDigestKeyId !== current.currentConfirmation.digestKeyId ||
      !sameAmuxIdeaUnitConfirmation(prepared.confirmationDigest,
        current.currentConfirmation.confirmationDigest)) {
    return { decision: "reconfirm", reason: "confirmation_changed" };
  }
  return { decision: "allow" };
}
